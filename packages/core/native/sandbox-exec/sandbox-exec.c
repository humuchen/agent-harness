/*
 * sandbox-exec —— agent-harness 的 OS 级沙箱原生 helper（Linux only）。
 *
 * 职责：在 exec 目标命令之前，于当前进程施加四类底层隔离原语：
 *   1) 命名空间隔离  unshare(CLONE_NEWUSER|NEWNS|NEWPID|NEWNET|NEWIPC|NEWUTS)
 *                   并写 uid/gid_map 把真实 uid 映射为命名空间内 root（无需 setuid）。
 *   2) 系统调用过滤  libseccomp 编译 BPF，未授权 syscall 默认 errno/kill（可选，缺库则跳过）。
 *   3) 资源限制      setrlimit 封顶 地址空间/数据段/CPU/文件描述符/进程数/文件大小/栈。
 *   4) 权限控制      丢弃全部 capabilities（可选保留子集）、PR_SET_NO_NEW_PRIVS 禁提权、降权 uid/gid。
 *
 * 此外：把根文件系统重新挂载只读（--root-ro），仅把工作目录 bind 为可写（--bind-rw）。
 *
 * 编译（见 Makefile）：
 *   cc -D_GNU_SOURCE sandbox-exec.c -o build/sandbox-exec \
 *      $(pkg-config --cflags --libs libseccomp 2>/dev/null) \
 *      $(pkg-config --cflags --libs libcap 2>/dev/null) \
 *      -DHAVE_LIBSECCOMP -DHAVE_LIBCAP
 * 缺 libseccomp / libcap 时去掉对应 -DHAVE_* 即可，对应能力自动降级（不阻断运行）。
 *
 * CLI 契约（与 packages/core/src/sandbox/args.ts 的 buildHelperArgs 对齐）：
 *   sandbox-exec [options] -- command [args...]
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <ctype.h>
#include <sys/wait.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <linux/sockios.h>
#include <linux/capability.h>
#include <sys/syscall.h>

#ifdef HAVE_LIBSECCOMP
#include <seccomp.h>
#endif
#ifdef HAVE_LIBCAP
#include <sys/capability.h>
#endif

/* ----------------------------- 小工具 ----------------------------- */

static void die(const char *msg) {
    if (msg) perror(msg);
    _exit(2);
}

static void write_file(const char *path, const char *fmt, ...) {
    FILE *f = fopen(path, "w");
    if (!f) { fprintf(stderr, "warn: cannot open %s: %s\n", path, strerror(errno)); return; }
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fclose(f);
}

/* ----------------------------- 命名空间 ----------------------------- */

static int parse_ns_flags(const char *csv, int *has_user) {
    int flags = 0;
    *has_user = 0;
    if (!csv) return 0;
    char *buf = strdup(csv);
    if (!buf) die("strdup");
    for (char *tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
        if (strcmp(tok, "user") == 0)  { flags |= CLONE_NEWUSER; *has_user = 1; }
        else if (strcmp(tok, "mount") == 0) flags |= CLONE_NEWNS;
        else if (strcmp(tok, "pid") == 0)   flags |= CLONE_NEWPID;
        else if (strcmp(tok, "net") == 0)   flags |= CLONE_NEWNET;
        else if (strcmp(tok, "ipc") == 0)   flags |= CLONE_NEWIPC;
        else if (strcmp(tok, "uts") == 0)   flags |= CLONE_NEWUTS;
    }
    free(buf);
    return flags;
}

static void write_id_maps(void) {
    uid_t ruid = getuid();
    gid_t rgid = getgid();
    /* 把真实 uid/gid 映射为命名空间内 root（0）。这是 unshare --map-root-user 的等价做法，
       无需 setuid 权限；映射包含进程自身 uid 即被内核允许。 */
    write_file("/proc/self/uid_map", "0 %u 1\n", ruid);
    write_file("/proc/self/setgroups", "deny\n");
    write_file("/proc/self/gid_map", "0 %u 1\n", rgid);
}

/* ----------------------------- 文件系统 ----------------------------- */

static int setup_mounts(const char *bind_src, const char *bind_dst, int root_ro) {
    if (root_ro) {
        /* 在把根重新挂载只读之前，先确保可写挂载点存在。 */
        if (bind_dst) mkdir(bind_dst, 0755);
        if (mount("/", "/", NULL, MS_REMOUNT | MS_BIND | MS_RDONLY, NULL) < 0) {
            perror("remount / read-only");
            return -1;
        }
    }
    if (bind_src && bind_dst) {
        /* bind 挂载工作目录为可写（默认 rw），覆盖在只读根之上形成唯一可写点。 */
        if (mount(bind_src, bind_dst, "none", MS_BIND, NULL) < 0) {
            perror("bind mount workdir");
            return -1;
        }
    }
    return 0;
}

/* ----------------------------- 网络 ----------------------------- */

static void bring_up_lo(void) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return;
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);
    ifr.ifr_flags = IFF_UP | IFF_RUNNING;
    ioctl(fd, SIOCSIFFLAGS, &ifr);
    close(fd);
}

/* ----------------------------- 资源限制 ----------------------------- */

static void set_rlimit(int resource, long long value) {
    if (value <= 0) return;
    struct rlimit rl;
    rl.rlim_cur = (rlim_t)value;
    rl.rlim_max = (rlim_t)value;
    if (setrlimit(resource, &rl) < 0)
        fprintf(stderr, "warn: setrlimit(%d)=%lld failed: %s\n", resource, value, strerror(errno));
}

/* ----------------------------- 权限控制 ----------------------------- */

/* 丢弃全部 capabilities（始终可用，无需任何库）。 */
static int drop_all_caps_raw(void) {
    /* 注意：<linux/capability.h> 的结构体标签带 _struct 后缀（__user_cap_header_struct /
       __user_cap_data_struct），不可写成 struct __user_cap_header（无此标签，会编译失败）。 */
    struct __user_cap_header_struct hdr;
    struct __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_2];
    memset(&hdr, 0, sizeof(hdr));
    memset(data, 0, sizeof(data));
    hdr.version = _LINUX_CAPABILITY_VERSION_3;
    hdr.pid = 0;
    if (syscall(SYS_capset, &hdr, data) < 0) {
        perror("capset (drop all)");
        return -1;
    }
    return 0;
}

#ifdef HAVE_LIBCAP
/* 清空后仅保留 keep_csv 中的能力（按名解析）。 */
static int set_caps_libcap(const char *keep_csv) {
    cap_t cap = cap_init();
    cap_clear(cap);
    if (keep_csv && *keep_csv) {
        char *buf = strdup(keep_csv);
        if (!buf) { cap_free(cap); return -1; }
        for (char *tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
            cap_value_t v;
            if (cap_from_name(tok, &v) == 0) {
                cap_set_flag(cap, CAP_PERMITTED, 1, &v, CAP_SET);
                cap_set_flag(cap, CAP_EFFECTIVE, 1, &v, CAP_SET);
                cap_set_flag(cap, CAP_INHERITABLE, 1, &v, CAP_SET);
            } else {
                fprintf(stderr, "warn: unknown capability %s\n", tok);
            }
        }
        free(buf);
    }
    if (cap_set_proc(cap) < 0) { perror("cap_set_proc"); cap_free(cap); return -1; }
    cap_free(cap);
    return 0;
}
#endif

static int apply_capabilities(int drop_caps, const char *keep_csv) {
    if (!drop_caps) return 0; /* 保留全部能力 */
#ifdef HAVE_LIBCAP
    if (keep_csv && *keep_csv) return set_caps_libcap(keep_csv);
#endif
    (void)keep_csv;
    return drop_all_caps_raw();
}

/* ----------------------------- seccomp ----------------------------- */

#ifdef HAVE_LIBSECCOMP
static uint32_t default_action_code(const char *action) {
    if (!action) return SCMP_ACT_ERRNO(EPERM);
    if (strcmp(action, "kill") == 0)  return SCMP_ACT_KILL_PROCESS;
    if (strcmp(action, "allow") == 0) return SCMP_ACT_ALLOW;
    if (strcmp(action, "log") == 0)   return SCMP_ACT_LOG;
    return SCMP_ACT_ERRNO(EPERM);
}

static int install_seccomp(const char *allow_csv, const char *default_action) {
    uint32_t def = default_action_code(default_action);
    scmp_filter_ctx ctx = seccomp_init(def);
    if (!ctx) { fprintf(stderr, "warn: seccomp_init failed\n"); return -1; }
    if (allow_csv && *allow_csv) {
        char *buf = strdup(allow_csv);
        if (!buf) { seccomp_release(ctx); return -1; }
        for (char *tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
            int nr = seccomp_syscall_resolve_name(tok);
            if (nr == __NR_SCMP_ERROR) {
                fprintf(stderr, "warn: seccomp unknown syscall %s\n", tok);
                continue;
            }
            if (seccomp_rule_add(ctx, SCMP_ACT_ALLOW, nr, 0) < 0)
                fprintf(stderr, "warn: seccomp_rule_add(%s) failed\n", tok);
        }
        free(buf);
    }
    if (seccomp_load(ctx) < 0) {
        perror("seccomp_load");
        seccomp_release(ctx);
        return -1;
    }
    seccomp_release(ctx);
    return 0;
}
#endif

/* ----------------------------- main ----------------------------- */

int main(int argc, char **argv) {
    const char *ns_csv = NULL;
    int net_up = 0, root_ro = 0;
    const char *bind_src = NULL, *bind_dst = NULL;
    const char *cwd = NULL;
    const char *path = NULL;
    long long r_as = 0, r_data = 0, r_cpu = 0, r_nofile = 0, r_nproc = 0, r_fsize = 0, r_stack = 0;
    int drop_caps = 0, no_new_privs = 0;
    const char *keep_caps = NULL;
    int uid = -1, gid = -1;
    int no_seccomp = 0;
    const char *seccomp_allow = NULL, *seccomp_default = "errno";

    int i = 1;
    for (; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) { i++; break; }
        if (strcmp(argv[i], "--ns") == 0 && i + 1 < argc) ns_csv = argv[++i];
        /* --no-net 为「无外部网络」的默认语义：建了 network 命名空间后仅留 loopback（默认 down），
           无需额外动作，故此处仅作为兼容标记被识别。需本地回环时改用 --net-up。 */
        else if (strcmp(argv[i], "--no-net") == 0) { /* no-op */ }
        else if (strcmp(argv[i], "--net-up") == 0) net_up = 1;
        else if (strcmp(argv[i], "--root-ro") == 0) root_ro = 1;
        else if (strcmp(argv[i], "--bind-rw") == 0 && i + 1 < argc) {
            char *eq = strchr(argv[++i], ':');
            if (eq) { *eq = '\0'; bind_src = argv[i]; bind_dst = eq + 1; }
            else { bind_src = argv[i]; bind_dst = argv[i]; }
        }
        else if (strcmp(argv[i], "--cwd") == 0 && i + 1 < argc) cwd = argv[++i];
        else if (strcmp(argv[i], "--path") == 0 && i + 1 < argc) path = argv[++i];
        else if (strcmp(argv[i], "--rlimit-as") == 0 && i + 1 < argc) r_as = atoll(argv[++i]);
        else if (strcmp(argv[i], "--rlimit-data") == 0 && i + 1 < argc) r_data = atoll(argv[++i]);
        else if (strcmp(argv[i], "--rlimit-cpu") == 0 && i + 1 < argc) r_cpu = atoll(argv[++i]);
        else if (strcmp(argv[i], "--rlimit-nofile") == 0 && i + 1 < argc) r_nofile = atoll(argv[++i]);
        else if (strcmp(argv[i], "--rlimit-nproc") == 0 && i + 1 < argc) r_nproc = atoll(argv[++i]);
        else if (strcmp(argv[i], "--rlimit-fsize") == 0 && i + 1 < argc) r_fsize = atoll(argv[++i]);
        else if (strcmp(argv[i], "--rlimit-stack") == 0 && i + 1 < argc) r_stack = atoll(argv[++i]);
        else if (strcmp(argv[i], "--drop-caps") == 0) drop_caps = 1;
        else if (strcmp(argv[i], "--keep-caps") == 0 && i + 1 < argc) keep_caps = argv[++i];
        else if (strcmp(argv[i], "--no-new-privs") == 0) no_new_privs = 1;
        else if (strcmp(argv[i], "--allow-new-privs") == 0) no_new_privs = 0;
        else if (strcmp(argv[i], "--uid") == 0 && i + 1 < argc) uid = atoi(argv[++i]);
        else if (strcmp(argv[i], "--gid") == 0 && i + 1 < argc) gid = atoi(argv[++i]);
        else if (strcmp(argv[i], "--no-seccomp") == 0) no_seccomp = 1;
        else if (strcmp(argv[i], "--seccomp-allow") == 0 && i + 1 < argc) seccomp_allow = argv[++i];
        else if (strcmp(argv[i], "--seccomp-default") == 0 && i + 1 < argc) seccomp_default = argv[++i];
        else { fprintf(stderr, "warn: unknown option %s (ignored)\n", argv[i]); }
    }

    if (i >= argc) { fprintf(stderr, "error: missing command after --\n"); return 2; }
    const char *command = argv[i];
    char **cmd_args = &argv[i];

    /* 1) 命名空间 */
    int has_user = 0;
    int ns_flags = parse_ns_flags(ns_csv, &has_user);
    if (ns_flags) {
        if (unshare(ns_flags) < 0) die("unshare");
        if (has_user) write_id_maps();
        pid_t pid = fork();
        if (pid < 0) die("fork");
        if (pid > 0) {
            /* 父进程：等待命名空间内的 PID 1（子），并把其退出状态透传给自身。 */
            int status;
            if (waitpid(pid, &status, 0) < 0) die("waitpid");
            if (WIFEXITED(status)) return WEXITSTATUS(status);
            if (WIFSIGNALED(status)) {
                signal(WTERMSIG(status), SIG_DFL);
                kill(getpid(), WTERMSIG(status));
            }
            return 1;
        }
        /* 子进程：新 pid 命名空间内的 PID 1，新 user 命名空间内 uid 0。 */
    }

    /* 2) 文件系统（必须在 seccomp 之前，mount 自身也是 syscall）。 */
    if (setup_mounts(bind_src, bind_dst, ns_flags && root_ro) < 0) return 2;
    if (cwd && chdir(cwd) < 0) { perror("chdir"); return 2; }
    if (net_up && (ns_flags & CLONE_NEWNET)) bring_up_lo();

    /* 3) 资源限制 */
    set_rlimit(RLIMIT_AS, r_as);
    set_rlimit(RLIMIT_DATA, r_data);
    set_rlimit(RLIMIT_CPU, r_cpu);
    set_rlimit(RLIMIT_NOFILE, r_nofile);
    set_rlimit(RLIMIT_NPROC, r_nproc);
    set_rlimit(RLIMIT_FSIZE, r_fsize);
    set_rlimit(RLIMIT_STACK, r_stack);

    /* 4) 权限控制：先禁提权（seccomp 加载 KILL 动作需要），再裁能力，最后降权。 */
    if (no_new_privs) {
        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0)
            fprintf(stderr, "warn: prctl(NO_NEW_PRIVS) failed: %s\n", strerror(errno));
    }
#ifdef HAVE_LIBSECCOMP
    if (!no_seccomp) {
        if (install_seccomp(seccomp_allow, seccomp_default) < 0)
            fprintf(stderr, "warn: seccomp install failed; continuing without syscall filter\n");
    }
#else
    if (!no_seccomp)
        fprintf(stderr, "warn: seccomp requested but helper built without libseccomp; skipping\n");
#endif
    if (apply_capabilities(drop_caps, keep_caps) < 0)
        fprintf(stderr, "warn: capability drop failed\n");
    if (uid >= 0 && setuid((uid_t)uid) < 0) perror("setuid");
    if (gid >= 0 && setgid((gid_t)gid) < 0) perror("setgid");

    /* 5) 执行目标命令 */
    if (path) setenv("PATH", path, 1);
    execv(command, cmd_args);
    perror("execv");
    return 127;
}
