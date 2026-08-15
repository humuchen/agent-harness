#!/usr/bin/env bash
#
# 构建 agent-harness 的 OS 级沙箱原生 helper（packages/core/native/sandbox-exec）。
#
# 这是 detect.ts 在「未找到原生 sandbox-exec helper」时提示的构建入口。产物落在
#   packages/core/native/sandbox-exec/build/sandbox-exec
# 与 resolveHelperPath() 的默认解析路径一致，编译后 detectCapabilities() 即认为 helper 就绪。
#
# 平台与降级约定（与「一切降级可用」一致）：
#   - helper 使用 Linux 专属内核接口（unshare/命名空间/capset/seccomp），仅能在 Linux 上编译。
#     非 Linux（macOS/Windows）默认「跳过并成功退出」（exit 0），使 `pnpm -r build` 等跨平台
#     流水线不因此中断；运行期自然降级为「硬化本地进程」执行器。
#   - 缺编译器（cc/gcc）同样默认跳过（exit 0），仅告警。
#   - 可选依赖 libseccomp / libcap 由 Makefile 用 pkg-config 自动探测，缺失则对应能力降级，
#     不影响编译成功。
#
# 严格模式：设 HARNESS_NATIVE_STRICT=1 时，上述「跳过」一律改为失败退出（exit 1），
#   供「必须产出 helper」的 Linux 生产镜像构建 / CI 使用。
#
# 用法：
#   bash scripts/build-native.sh            # 常规：非 Linux/无编译器则跳过
#   HARNESS_NATIVE_STRICT=1 bash scripts/build-native.sh   # 严格：缺条件即失败
#   CC=gcc bash scripts/build-native.sh     # 指定编译器
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$REPO_ROOT/packages/core/native/sandbox-exec"
BIN="$NATIVE_DIR/build/sandbox-exec"

STRICT="${HARNESS_NATIVE_STRICT:-0}"

log()  { printf '[build-native] %s\n' "$*"; }
warn() { printf '[build-native] ⚠️  %s\n' "$*" >&2; }

# 跳过：严格模式下视为失败。
skip() {
  warn "$*"
  if [ "$STRICT" = "1" ]; then
    warn "HARNESS_NATIVE_STRICT=1：跳过被视为失败。"
    exit 1
  fi
  log "跳过原生 helper 构建（运行期将降级为硬化本地进程执行器）。"
  exit 0
}

# 1) 平台前置：仅 Linux 可编译。
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
if [ "$UNAME_S" != "Linux" ]; then
  skip "当前平台为 ${UNAME_S}，OS 级沙箱 helper 仅支持 Linux。"
fi

# 2) 编译器探测。
CC_BIN="${CC:-}"
if [ -z "$CC_BIN" ]; then
  if command -v cc >/dev/null 2>&1; then CC_BIN=cc
  elif command -v gcc >/dev/null 2>&1; then CC_BIN=gcc
  elif command -v clang >/dev/null 2>&1; then CC_BIN=clang
  fi
fi
if [ -z "$CC_BIN" ]; then
  skip "未找到 C 编译器（cc/gcc/clang）。请安装 build-essential（Debian/Ubuntu）或等价包。"
fi
log "使用编译器：$CC_BIN"

# 3) 可选依赖探测（仅提示，缺失不阻断）。
if command -v pkg-config >/dev/null 2>&1; then
  pkg-config --exists libseccomp 2>/dev/null && log "检测到 libseccomp → 启用 seccomp 系统调用过滤。" \
    || warn "未检测到 libseccomp（apt install libseccomp-dev）→ seccomp 将被跳过。"
  pkg-config --exists libcap 2>/dev/null && log "检测到 libcap → 支持按名保留 capabilities。" \
    || warn "未检测到 libcap（apt install libcap-dev）→ 仅能整体丢弃 capabilities。"
else
  warn "未找到 pkg-config → libseccomp/libcap 一律按缺失处理（对应能力降级）。"
fi

# 4) 编译：优先 make（Makefile 已封装 pkg-config 探测），缺 make 时回退直接 cc。
if command -v make >/dev/null 2>&1; then
  log "make -C $NATIVE_DIR"
  make -C "$NATIVE_DIR" CC="$CC_BIN"
else
  warn "未找到 make，回退直接编译（不启用可选库）。"
  mkdir -p "$NATIVE_DIR/build"
  "$CC_BIN" -std=c11 -Wall -Wextra -O2 -D_GNU_SOURCE \
    -o "$BIN" "$NATIVE_DIR/sandbox-exec.c"
fi

# 5) 校验产物。
if [ ! -x "$BIN" ]; then
  warn "编译完成但未找到可执行产物：$BIN"
  exit 1
fi
log "✅ 构建成功：$BIN"
log "   自检：$BIN --ns user -- /bin/echo ok"
if OUT="$("$BIN" --ns user -- /bin/echo ok 2>/dev/null)" && [ "$OUT" = "ok" ]; then
  log "   自检通过（helper 可在本机施加 user namespace 并 exec）。"
else
  warn "   自检未通过：本机可能未开启非特权 user namespace（kernel.unprivileged_userns_clone=1 或 max_user_namespaces>0）。"
  warn "   helper 已就绪，但运行期若无法建命名空间会自动降级。详见 scripts/verify-sandbox.sh。"
fi
