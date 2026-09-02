# 插件子进程沙箱
#
# 设计目标：将插件运行在独立 OS 子进程中，隔离插件的权限/资源，
# 避免插件 bug 或恶意代码影响核心服务。
#
# 实现策略：
# 1. 插件以 stdio IPC 模式运行（子进程负责加载插件代码）
# 2. 父进程（核心服务）严格控制子进程的权限：
#    - 网络出口：仅允许访问插件声明的域名（白名单）
#    - 文件系统：仅允许访问插件安装目录（只读，数据写入独立卷）
#    - 内存限制：cgroup 或进程级 RSS 上限
#    - 超时：子进程执行超时强制 kill
# 3. 通过 SandboxExecutor 接口统一接入
#
# 状态：原型阶段（Phase 3.3），需在 runner.ts 中集成。
#
# 使用方式：
# 1. 插件 manifest.json 声明 sandbox: { network: ['example.com'], fs: ['/app/plugins/my-plugin'] }
# 2. server 启动时检测 SANDBOX_PLUGIN_MODE 环境变量
# 3. 运行时按 manifest 声明创建隔离子进程
