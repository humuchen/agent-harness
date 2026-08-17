/*
 * sandbox-exec —— agent-harness 的 OS 级沙箱原生助手（Linux only）。
 *
 * 这是 packages/core/src/sandbox/args.ts 中 buildHelperArgs() 的 CLI 契约的 C 侧实现。
 * 上层（OSSandboxExecutor）把 OSSandboxProfile 拼成 argv 后，由 Node 以 detached 进程组
 * 方式 spawn 本助手；本助手在真正 exec 目标命令前，施加四类 OS 原语：
 *
 *   1) 命名空间隔离 (namespaces)  —— user / mount / pid / network / ipc / uts
 *   2) 系统调用过滤 (seccomp)     —— 未授权 syscall 默认 kill / errno（依赖可选 libseccomp）
 *   3) 资源限制 (rlimit)          —— 地址空间 / CPU / 文件描述符 / 进程数 / 文件大小 / 栈
 *   4) 权限控制 (capabilities)    —— 丢弃全部能力 / 保留子集 / 禁提权 / 降权 uid·gid
 *
 * 设计要点：
 *   - 零硬依赖：仅用 glibc + Linux 头文件即可编译；libseccomp 为「可选」——缺失时 seccomp
 *     自动降级（仅告警，不阻断编译/运行），其余三类原语照常生效（符合「一切降级可用」）。
 *   - capabilities 用裸 syscall(SYS_capset) 实现，不依赖 libcap。
 *   - 所有隔离在 exec 之前施加；seccomp 必须在最后一道（否则 setup 自身 syscall 会被拦）。
 *   - 任何「请求了但本机施加不了」的隔离都降级 + 往 stderr 打 WARNING（不静默吞掉，也不
 *     让整次运行崩溃），由上层 run-queue / UI 决定是否收紧。
 *   - stdout 绝不输出任何日志（会污染目标命令的输出）；一切诊断走 stderr。
 *
 * 契约：sandbox-exec [options] -- command [args...]
 *   --ns <csv>                  命名空间：user,mount,pid,net,ipc,uts
 *   --no-net | --net-up         仅当含 net 时生效：--no-net 留 lo 全关；--net-up 拉起 lo
 *   --root-ro                   把根重新挂载为只读（仅 writableMount 绑定点可写）
 *   --bind-rw <host:container>  把宿主目录绑定挂载到命名空间内可写点（如 /work）
 *   --cwd <path>                执行前 chdir
 *   --rlimit-as/--rlimit-data/--rlimit-cpu/--rlimit-nofile/--rlimit-nproc/
 *   --rlimit-fsize/--rlimit-stack <n>   资源上限（字节/秒/个数）
 *   --drop-caps | --keep-caps <csv>      丢弃全部能力 / 仅保留子集
 *   --no-new-privs | --allow-new-privs   禁止 / 允许子进程 setuid 提权
 *   --uid <n> | --gid <n>                （在 user ns 内）降权到指定 uid/gid
 *   --no-seccomp | --seccomp-allow <csv> --seccomp-default <action>
 *   --path <p>                   注入精简 PATH
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <net/if.h>
#include <linux/sockios.h>
#include <linux/capability.h>
#include <signal.h>

/* environ 由运行时提供（_GNU_SOURCE 下 <unistd.h> 已声明，这里显式声明以兼容严格编译）。 */
extern char **environ;

#ifdef HAVE_LIBSECCOMP
#include <seccomp.h>
#endif

/* ---- 全局诊断：只走 stderr，绝不碰 stdout ---- */
static void warn(const char *msg) {
  fprintf(stderr, "sandbox-exec: WARNING: %s\n", msg);
}

/* ---- 把 uid/gid 映射到新 user namespace（映射为 inner 0=root）---- */
static int write_user_map(uid_t outer_uid, gid_t outer_gid) {
  FILE *f;
  /* 有附加组时须先置 setgroups=deny，否则 uid_map 写入被拒 */
  f = fopen("/proc/self/setgroups", "w");
  if (f) { fputs("deny\n", f); fclose(f); }
  f = fopen("/proc/self/uid_map", "w");
  if (!f) { warn("无法打开 /proc/self/uid_map"); return -1; }
  fprintf(f, "0 %u 1\n", outer_uid);
  fclose(f);
  f = fopen("/proc/self/gid_map", "w");
  if (!f) { warn("无法打开 /proc/self/gid_map"); return -1; }
  fprintf(f, "0 %u 1\n", outer_gid);
  fclose(f);
  return 0;
}

/* ---- 拉起 loopback（net ns 内 --net-up 时调用）---- */
static void bring_up_lo(void) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return;
  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);
  ifr.ifr_flags = IFF_UP | IFF_LOOPBACK;
  if (ioctl(fd, SIOCSIFFLAGS, &ifr) < 0) warn("ioctl(SIOCSIFFLAGS) 拉起 lo 失败");
  close(fd);
}

/* ---- capability 名 -> 编号（Linux 5.x/6.x 稳定；未知返回 -1）---- */
static int cap_name_to_num(const char *name) {
  static const struct { const char *n; int v; } tbl[] = {
    {"CAP_CHOWN",0},{"CAP_DAC_OVERRIDE",1},{"CAP_DAC_READ_SEARCH",2},
    {"CAP_FOWNER",3},{"CAP_FSETID",4},{"CAP_KILL",5},{"CAP_SETGID",6},
    {"CAP_SETUID",7},{"CAP_SETPCAP",8},{"CAP_LINUX_IMMUTABLE",9},
    {"CAP_NET_BIND_SERVICE",10},{"CAP_NET_BROADCAST",11},{"CAP_NET_ADMIN",12},
    {"CAP_NET_RAW",13},{"CAP_IPC_LOCK",14},{"CAP_IPC_OWNER",15},
    {"CAP_SYS_MODULE",16},{"CAP_SYS_RAWIO",17},{"CAP_SYS_CHROOT",18},
    {"CAP_SYS_PTRACE",19},{"CAP_SYS_PACCT",20},{"CAP_SYS_ADMIN",21},
    {"CAP_SYS_BOOT",22},{"CAP_SYS_NICE",23},{"CAP_SYS_RESOURCE",24},
    {"CAP_SYS_TIME",25},{"CAP_SYS_TTY_CONFIG",26},{"CAP_MKNOD",27},
    {"CAP_LEASE",28},{"CAP_AUDIT_WRITE",29},{"CAP_AUDIT_CONTROL",30},
    {"CAP_SETFCAP",31},{"CAP_MAC_OVERRIDE",32},{"CAP_MAC_ADMIN",33},
    {"CAP_SYSLOG",34},{"CAP_WAKE_ALARM",35},{"CAP_BLOCK_SUSPEND",36},
    {"CAP_AUDIT_READ",37},{"CAP_PERFMON",38},{"CAP_BPF",39},
    {"CAP_CHECKPOINT_RESTORE",40},
    {NULL,-1}
  };
  for (int i = 0; tbl[i].n; i++)
    if (strcmp(tbl[i].n, name) == 0) return tbl[i].v;
  /* 也接受纯数字形式 */
  char *end; long v = strtol(name, &end, 10);
  if (*name && !*end) return (int)v;
  return -1;
}

/* ---- 设置能力集：mask 中置位的 cap 被保留，其余丢弃 ----
 * 两步法：先带上 CAP_SETPCAP 以便 capset 成功，再去掉 SETPCAP 收口。 */
static int set_caps(uint64_t keep_mask) {
  struct __user_cap_header_struct hdr;
  struct __user_cap_data_struct data[2]; /* VERSION_3：64bit 拆两个 32bit 字 */
  memset(&hdr, 0, sizeof(hdr));
  memset(data, 0, sizeof(data));
  hdr.version = _LINUX_CAPABILITY_VERSION_3;
  hdr.pid = 0;

  for (int n = 0; n <= 63; n++) {
    if (!(keep_mask & (1ULL << n))) continue;
    int idx = n / 32, bit = n % 32;
    data[idx].effective   |= (1U << bit);
    data[idx].permitted   |= (1U << bit);
    data[idx].inheritable |= (1U << bit);
  }
  /* 临时保留 SETPCAP 以便本次 capset 通过 */
  if (!(keep_mask & (1ULL << 8))) {
    data[0].effective   |= (1U << 8);
    data[0].permitted   |= (1U << 8);
    data[0].inheritable |= (1U << 8);
  }
  if (syscall(SYS_capset, &hdr, data) < 0) {
    warn("capset（保留子集）失败");
    return -1;
  }
  /* 收口：去掉 SETPCAP（若未显式要求保留） */
  if (!(keep_mask & (1ULL << 8))) {
    data[0].effective   &= ~(1U << 8);
    data[0].permitted   &= ~(1U << 8);
    data[0].inheritable &= ~(1U << 8);
    if (syscall(SYS_capset, &hdr, data) < 0) {
      warn("capset（收口 SETPCAP）失败");
      return -1;
    }
  }
  return 0;
}

/* ---- 累加单个 cap 到 mask ---- */
static uint64_t add_cap(uint64_t mask, const char *name) {
  int n = cap_name_to_num(name);
  if (n < 0 || n > 63) { warn("未知 capability 名，已忽略"); return mask; }
  return mask | (1ULL << n);
}

#ifdef HAVE_LIBSECCOMP
/* ---- seccomp BPF 过滤：默认动作 + 放行名单（syscall 名经 libseccomp 解析为编号）---- */
static int setup_seccomp(const char *allow_csv, const char *def_action) {
  uint32_t def = SCMP_ACT_ERRNO(EPERM);
  if (strcmp(def_action, "kill") == 0)       def = SCMP_ACT_KILL_PROCESS;
  else if (strcmp(def_action, "allow") == 0) def = SCMP_ACT_ALLOW;
  else if (strcmp(def_action, "log") == 0)   def = SCMP_ACT_LOG;
  else if (strcmp(def_action, "errno") == 0) def = SCMP_ACT_ERRNO(EPERM);
  else { warn("未知 seccomp 默认动作，回退 errno"); }

  scmp_filter_ctx ctx = seccomp_init(def);
  if (!ctx) { warn("seccomp_init 失败"); return -1; }

  if (allow_csv && *allow_csv) {
    char *buf = strdup(allow_csv);
    char *tok = strtok(buf, ",");
    while (tok) {
      int nr = seccomp_syscall_resolve_name(tok);
      if (nr == __NR_SCMP_ERROR) {
        fprintf(stderr, "sandbox-exec: WARNING: seccomp 无法解析 syscall '%s'，已跳过\n", tok);
      } else if (seccomp_rule_add(ctx, SCMP_ACT_ALLOW, nr, 0) < 0) {
        fprintf(stderr, "sandbox-exec: WARNING: seccomp 放行 '%s' 失败\n", tok);
      }
      tok = strtok(NULL, ",");
    }
    free(buf);
  }
  if (seccomp_load(ctx) < 0) {
    seccomp_release(ctx);
    warn("seccomp_load 失败，跳过系统调用过滤");
    return -1;
  }
  seccomp_release(ctx);
  return 0;
}
#endif

/* ---- 解析并应用单个 rlimit ---- */
static void apply_rlimit(const char *name, const char *valstr) {
  struct rlimit rl;
  rl.rlim_cur = (rlim_t)strtoull(valstr, NULL, 10);
  rl.rlim_max = RLIM_INFINITY; /* 软限制由参数定，硬限制放开以便可调整 */
  int which = -1;
  if (strcmp(name, "as") == 0)        which = RLIMIT_AS;
  else if (strcmp(name, "data") == 0) which = RLIMIT_DATA;
  else if (strcmp(name, "cpu") == 0)  which = RLIMIT_CPU;
  else if (strcmp(name, "nofile") == 0) which = RLIMIT_NOFILE;
  else if (strcmp(name, "nproc") == 0)  which = RLIMIT_NPROC;
  else if (strcmp(name, "fsize") == 0)  which = RLIMIT_FSIZE;
  else if (strcmp(name, "stack") == 0) which = RLIMIT_STACK;
  else { warn("未知 rlimit 名，已忽略"); return; }
  if (setrlimit(which, &rl) < 0)
    warn("setrlimit 失败（权限不足或值非法）");
}

int main(int argc, char *argv[]) {
  /* 解析后的配置 */
  const char *ns_csv = NULL;
  int net_no = 0, net_up = 0, root_ro = 0;
  const char *bind_spec = NULL, *cwd = NULL, *path = NULL;
  int drop_caps = 0, no_new_privs = -1 /* -1=未指定 */;
  const char *keep_caps_csv = NULL;
  int has_uid = 0, has_gid = 0;
  uid_t req_uid = 0; gid_t req_gid = 0;
  int seccomp_off = 0;
  const char *seccomp_allow = NULL, *seccomp_def = "errno";

  int i = 1;
  while (i < argc) {
    char *a = argv[i];
    if (strcmp(a, "--") == 0) { i++; break; }
    else if (strcmp(a, "--ns") == 0 && i + 1 < argc) ns_csv = argv[++i];
    else if (strcmp(a, "--no-net") == 0) { net_no = 1; net_up = 0; }
    else if (strcmp(a, "--net-up") == 0) { net_up = 1; net_no = 0; }
    else if (strcmp(a, "--root-ro") == 0) root_ro = 1;
    else if (strcmp(a, "--bind-rw") == 0 && i + 1 < argc) bind_spec = argv[++i];
    else if (strcmp(a, "--cwd") == 0 && i + 1 < argc) cwd = argv[++i];
    else if (strncmp(a, "--rlimit-", 9) == 0 && i + 1 < argc)
      apply_rlimit(a + 9, argv[++i]);
    else if (strcmp(a, "--drop-caps") == 0) drop_caps = 1;
    else if (strcmp(a, "--keep-caps") == 0 && i + 1 < argc) keep_caps_csv = argv[++i];
    else if (strcmp(a, "--no-new-privs") == 0) no_new_privs = 1;
    else if (strcmp(a, "--allow-new-privs") == 0) no_new_privs = 0;
    else if (strcmp(a, "--uid") == 0 && i + 1 < argc) { req_uid = (uid_t)atoi(argv[++i]); has_uid = 1; }
    else if (strcmp(a, "--gid") == 0 && i + 1 < argc) { req_gid = (gid_t)atoi(argv[++i]); has_gid = 1; }
    else if (strcmp(a, "--no-seccomp") == 0) seccomp_off = 1;
    else if (strcmp(a, "--seccomp-allow") == 0 && i + 1 < argc) seccomp_allow = argv[++i];
    else if (strcmp(a, "--seccomp-default") == 0 && i + 1 < argc) seccomp_def = argv[++i];
    else if (strcmp(a, "--path") == 0 && i + 1 < argc) path = argv[++i];
    else { fprintf(stderr, "sandbox-exec: 未知参数 '%s'\n", a); return 2; }
    i++;
  }
  if (i >= argc) {
    fprintf(stderr, "sandbox-exec: 缺少 '--' 之后的目标命令\n");
    return 2;
  }
  char *command = argv[i];
  char **cmd_argv = &argv[i];

  /* 1) 解析命名空间 */
  int user_ns = 0, mount_ns = 0, pid_ns = 0, net_ns = 0, uts_ns = 0, ipc_ns = 0;
  if (ns_csv) {
    char *buf = strdup(ns_csv);
    char *tok = strtok(buf, ",");
    while (tok) {
      if (strcmp(tok, "user") == 0) user_ns = 1;
      else if (strcmp(tok, "mount") == 0) mount_ns = 1;
      else if (strcmp(tok, "pid") == 0) pid_ns = 1;
      else if (strcmp(tok, "net") == 0) net_ns = 1;
      else if (strcmp(tok, "uts") == 0) uts_ns = 1;
      else if (strcmp(tok, "ipc") == 0) ipc_ns = 1;
      else fprintf(stderr, "sandbox-exec: WARNING: 未知命名空间 '%s'\n", tok);
      tok = strtok(NULL, ",");
    }
    free(buf);
  }

  /* 2) 施加命名空间（user/mount/uts/ipc/net 合并一次 unshare；pid 单独处理后 fork） */
  int common_flags = 0;
  if (user_ns)  common_flags |= CLONE_NEWUSER;
  if (mount_ns) common_flags |= CLONE_NEWNS;
  if (uts_ns)   common_flags |= CLONE_NEWUTS;
  if (ipc_ns)   common_flags |= CLONE_NEWIPC;
  if (net_ns)   common_flags |= CLONE_NEWNET;

  if (common_flags) {
    if (unshare(common_flags) != 0) {
      fprintf(stderr, "sandbox-exec: WARNING: unshare(0x%x) 失败: %s（降级，命令将在较弱隔离下运行）\n",
              common_flags, strerror(errno));
    } else if (user_ns) {
      /* 映射 outer uid/gid -> inner 0（root），从而拥有新 ns 内的全部能力 */
      uid_t ou = getuid();
      gid_t og = getgid();
      if (write_user_map(ou, og) != 0)
        warn("uid/gid 映射失败，后续特权操作可能受限");
    }
  }

  /* 3) PID 命名空间：fork 使子进程成为 ns 内 PID 1；父进程等待并透传退出码 */
  if (pid_ns) {
    if (unshare(CLONE_NEWPID) != 0) {
      warn("unshare(CLONE_NEWPID) 失败，PID 隔离未生效");
    } else {
      pid_t child = fork();
      if (child < 0) { warn("fork 失败"); }
      else if (child > 0) {
        int status = 0;
        waitpid(child, &status, 0);
        if (WIFEXITED(status)) return WEXITSTATUS(status);
        if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
        return 1;
      }
      /* 子进程继续往下执行 setup + exec */
    }
  }

  /* 4) 挂载隔离（需 mount ns + 新 user ns 的 CAP_SYS_ADMIN） */
  if (mount_ns) {
    /* 断开与宿主的挂载传播，避免影响宿主 */
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0)
      warn("mount(MS_PRIVATE) 失败，挂载隔离可能不完整");

    /* 可写绑定点：先确保目标目录存在，再 bind 挂载 */
    if (bind_spec) {
      char host[4096] = {0}, container[4096] = {0};
      const char *colon = strchr(bind_spec, ':');
      if (!colon) {
        warn("--bind-rw 格式应为 host:container");
      } else {
        size_t hl = (size_t)(colon - bind_spec);
        if (hl >= sizeof(host)) hl = sizeof(host) - 1;
        memcpy(host, bind_spec, hl);
        strncpy(container, colon + 1, sizeof(container) - 1);
        mkdir(container, 0755); /* 若不存在则创建（ro remount 之前，/ 尚且可写）*/
        if (mount(host, container, NULL, MS_BIND, NULL) != 0)
          warn("bind 挂载失败，工作目录可能不可写");
      }
    }

    /* PID ns 时挂载 /proc */
    if (pid_ns) {
      if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NOEXEC | MS_NODEV, NULL) != 0)
        warn("挂载 /proc 失败");
    }

    /* 只读根（须在 bind / proc 之后，避免把它们一起变只读） */
    if (root_ro) {
      if (mount("/", "/", "bind", MS_BIND | MS_REMOUNT | MS_RDONLY | MS_REC, NULL) != 0)
        warn("根只读 remount 失败，根文件系统仍可写");
    }
  }

  /* 5) 降权到指定 uid/gid（user ns 内；仅当值在映射范围内，否则告警不致命） */
  if (has_gid) {
    if (setresgid(req_gid, req_gid, req_gid) != 0)
      warn("setresgid 失败（uid 可能未在 user ns 映射中）");
  }
  if (has_uid) {
    if (setresuid(req_uid, req_uid, req_uid) != 0)
      warn("setresuid 失败（uid 可能未在 user ns 映射中）");
  }

  /* 6) 能力裁剪 */
  if (drop_caps) {
    set_caps(0); /* 全丢 */
  } else if (keep_caps_csv) {
    uint64_t mask = 0;
    char *buf = strdup(keep_caps_csv);
    char *tok = strtok(buf, ",");
    while (tok) { mask = add_cap(mask, tok); tok = strtok(NULL, ","); }
    free(buf);
    /* 若 --no-new-privs 与 --keep-caps 并存，保留子集即可 */
    if (no_new_privs == 1) mask |= (1ULL << 8); /* 仍保留 SETPCAP 以便收口 */
    set_caps(mask);
  }

  /* 7) 禁提权（必须在 seccomp 之前） */
  if (no_new_privs == 1) {
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
      warn("prctl(PR_SET_NO_NEW_PRIVS) 失败");
  }

  /* 8) 切换工作目录（须在 mount / seccomp 之前：chdir 自身不应被 seccomp 拦） */
  if (cwd) {
    if (chdir(cwd) != 0)
      fprintf(stderr, "sandbox-exec: WARNING: chdir('%s') 失败: %s\n", cwd, strerror(errno));
  }

  /* 9) 网络：net ns 且 --net-up 时拉起 lo（--no-net 则彻底留空） */
  if (net_ns && net_up) bring_up_lo();

  /* 10) seccomp（最后一道，仅当未显式关闭） */
  if (!seccomp_off) {
#ifdef HAVE_LIBSECCOMP
    /* 默认动作由上层下发；未带 --seccomp-allow 时仅放行极少基础 syscall */
    const char *allow = seccomp_allow ? seccomp_allow
        : "read,write,exit,exit_group,mmap,brk,rt_sigprocmask,rt_sigaction,sched_yield,futex";
    setup_seccomp(allow, seccomp_def);
#else
    warn("本助手编译时未链接 libseccomp，seccomp 系统调用过滤被跳过（其余隔离仍生效）");
#endif
  }

  /* 11) 注入 PATH（如有） */
  if (path) setenv("PATH", path, 1);

  /* 12) exec 目标命令（替换当前映像，继承上述全部隔离） */
  execvpe(command, cmd_argv, environ);
  fprintf(stderr, "sandbox-exec: exec '%s' 失败: %s\n", command, strerror(errno));
  return 127;
}
