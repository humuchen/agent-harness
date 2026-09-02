# OS 级沙箱（进程隔离）设计文档

> 代码位置：`backend/core/src/sandbox/`（类型 / 能力 / 名单 / 探测 / argv / 执行器）
> 原生 helper：`backend/core/native/sandbox-exec/`（C，Linux only）
> 接入点：`backend/core/src/builtins/sandbox.ts` 的 `createSandboxExecutor({ backend: 'os' })`

## 1. 背景与定位

`builtins/shell.ts` 提供的是**逻辑沙箱**（命令白名单 + 作用域 + 确认三道闸门），
放行后的命令仍以「与宿主同等权限」被 `spawn` 执行——能读写沙箱外文件、任意联网、
吃满 CPU/内存。本项目在容器 backend（`docker/podman --network none --read-only
--cap-drop ALL --security-opt no-new-privileges`）层面已有部分 OS 隔离，但**真正的底层
操作系统隔离能力缺失**。本模块补齐四类原语：

1. **命名空间隔离（namespaces）** —— user / mount / pid / network / ipc / uts
2. **系统调用过滤（seccomp）** —— 未授权 syscall 默认 `errno` / `kill`
3. **资源限制（rlimit）** —— 地址空间 / 数据段 / CPU / 文件描述符 / 进程数 / 文件大小 / 栈
4. **权限控制（capabilities）** —— 丢弃全部能力 / 保留子集 / 禁提权 / 降权 uid·gid

目标：让不可信命令在**独立、受限、受监控**的进程中运行，彼此隔离且受沙箱约束。

## 2. 架构

```
                          builtins/shell.ts（逻辑沙箱：白名单 + 作用域 + 确认）
                                        │  executor
                                        ▼
                          createSandboxExecutor({ backend: 'os' })
                                        │
                                        ▼
                              OSSandboxExecutor  ── describe() 暴露实际生效的隔离
                                        │
            ┌───────────────────────────┼───────────────────────────┐
            ▼                           ▼                           ▼
     (1) 原生 helper              (2) unshare(1) 降级          (3) 硬化本地执行器
     sandbox-exec（四类全覆盖）    user+mount+pid+net+ipc+uts     detach + 超时强杀
     seccomp + 只读根 + 能力裁剪     + bash ulimit 包装            + 擦除密钥环境
     + 只读根 + 资源限制            （无 seccomp / 无能力裁剪）     （macOS / 全不可用）
```

执行路径选择（遵循「一切降级可用」）：

| 条件 | 后端 | 实际生效 |
|---|---|---|
| Linux + helper 二进制存在 | `os-helper` | 四类原语全覆盖 |
| Linux + user namespace + `unshare(1)` 可用 | `os-unshare` | 命名空间 + 部分 rlimit（无 seccomp / 无能力裁剪） |
| 其余（macOS / Windows / 全不可用） | `os-fallback-local` | 退化为硬化 `LocalSandboxExecutor`，并 `structLog` 告警 |

`OSSandboxExecutor.describe()` 返回 `{ backend, supported, active: {namespaces, seccomp, resourceLimits, capabilities}, profile }`，
供 UI / 可观测 / 审计展示「这次执行到底被哪些 OS 约束保护」。

## 3. 四类原语详解

### 3.1 命名空间隔离
原生 helper 通过 `unshare(CLONE_NEWUSER|NEWNS|NEWPID|NEWNET|NEWIPC|NEWUTS)` 创建独立
命名空间，并写 `/proc/self/uid_map`、`/proc/self/gid_map` 把真实 uid/gid 映射为命名空间
内 root（**无需 setuid**，`unshare --map-root-user` 等价做法）。`network` 命名空间默认仅
留 loopback（down）→ 外部网络彻底断掉；`--net-up` 可拉起 lo 供本地 socket。

### 3.2 系统调用过滤（seccomp）
helper 借助 **libseccomp** 把 TS 侧解析好的 syscall 名单（见 `profiles.ts`）编译为 BPF
过滤器，未命中名单的 syscall 按 `defaultAction` 处理：
- `baseline` / `dev` → `errno`（EPERM，命令报错而非被杀，便于排查）
- `strict` → `kill`（命中未授权 syscall 直接终止，安全性最高）
名单是经验集，需按目标命令与架构微调；`profiles.ts` 提供 `baseline` / `dev` / `strict` /
`none` 四档。libseccomp 缺失时 helper 自动跳过 seccomp 并告警。

### 3.3 资源限制（rlimit）
`helper` 内 `setrlimit` 封顶：地址空间（防 OOM 扩散）、数据段、CPU 时间（超时 SIGXCPU）、
文件描述符、进程/线程数（防 fork 炸弹）、单文件大小、栈。`unshare` 降级路径用 `bash ulimit`
包装施加等价的虚拟地址/CPU/描述符/进程数/文件大小上限。

### 3.4 权限控制（capabilities）
helper 以命名空间内 root 身份 `capset` 丢弃全部 Linux capabilities（默认），可按
`permissions.retainCapabilities` 保留子集（需 libcap）；`prctl(PR_SET_NO_NEW_PRIVILEGES)`
禁止 setuid 提权；可选 `uid`/`gid` 降权。

## 4. 策略配置（OSSandboxProfile）

```ts
interface OSSandboxProfile {
  enabled?: boolean;                 // 总开关，默认 true
  namespaces?: NamespaceKind[] | null; // ['user','mount','pid','network','ipc','uts']；null/[]=不建
  networkIsolated?: boolean;         // 断网，默认 true
  readOnlyRoot?: boolean;            // 只读根，仅工作目录可写，默认 true
  writableMount?: string;            // 命名空间内可写挂载点，默认 /work
  resources?: ResourceLimits;        // 各类 rlimit 上限
  permissions?: PermissionControls;  // 能力裁剪 / 禁提权 / 降权
  seccomp?: SeccompConfig;           // enabled / defaultAction / profile / allowedSyscalls
  path?: string;                     // 隔离环境 PATH
}
```

`normalizeProfile()` 合并出全字段安全默认（全开隔离 + 资源封顶）。`null` 与未提供语义不同：
显式 `null`/`[]` 表示「不创建命名空间」，未提供则默认全开。

## 5. 原生 helper（Linux）构建

```bash
# 在 backend/core 下（需要 gcc/clang、libseccomp-dev、libcap-dev；缺库则对应能力降级）
pnpm --filter @agent-harness/core run build:native
# 或
make -C backend/core/native/sandbox-exec
```

产物：`backend/core/native/sandbox-exec/build/sandbox-exec`。
helper 自动探测 libseccomp / libcap，缺失则对应能力静默降级（命名空间 / 只读根 / 资源限制
/ 丢弃全部能力 / 禁提权仍生效）。CLI 契约见 `args.ts` 的 `buildHelperArgs`（TS 侧构造，
可单元测试，无需真起进程）。

## 6. 跨平台与降级

- **Linux 且已构建 helper** → 完整 OS 隔离。
- **Linux 无 helper 但有 unshare(1)** → 命名空间 + 部分 rlimit 降级。
- **macOS / Windows / 全不可用** → 退化为硬化本地执行器，日志告警；shell 工具仍可运行
  （仅失去底层 OS 隔离），保证「一切降级可用」。

## 7. 测试

`backend/core/test/os-sandbox.test.cjs`（零依赖，任意平台可跑）：
- `detectCapabilities()` 在非 Linux 正确判定 unsupported；
- `buildHelperArgs` / `buildUnshareFallbackArgs` 产出的 argv 正确；
- `profiles` / `capabilities` / `normalizeProfile` / `resolveSeccompList` 正确；
- `OSSandboxExecutor` 在非 Linux 优雅降级且仍能正常执行命令。

## 8. 安全红线

- 原生 helper 必须在 **Linux** 编译运行；非 Linux 不得声称具备 OS 隔离。
- seccomp 名单需随目标命令审计，过宽会被绕过、过窄会误伤正常命令（`baseline` 默认 `errno`
  便于先观测再收紧为 `strict` 的 `kill`）。
- 命名空间内的 root **不等于**宿主 root：映射仅在 user namespace 内有效，宿主侧无特权提升。
