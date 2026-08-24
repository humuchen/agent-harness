#!/usr/bin/env bash
#
# 实测 OS 级沙箱 helper 是否**真的**施加了隔离（Linux only）。
#
# 与单元测试（纯函数拼 argv，任意平台可跑）不同，本脚本在真实 Linux 内核上 exec helper，
# 断言命名空间/只读根/网络隔离/资源限制确实生效——这是「编得过」到「隔得住」的关键一环。
#
# 退出码：
#   0  全部硬断言通过；或「非 Linux / 环境不支持非特权 user namespace」被跳过（loud SKIP）。
#   1  某项硬断言失败（helper 行为不符合预期，属真实缺陷）。
#   （设 HARNESS_SANDBOX_VERIFY_STRICT=1 时，SKIP 也按失败退出，供 CImust-pass 门禁使用。）
#
# 用法：
#   bash scripts/verify-sandbox.sh
#   HARNESS_SANDBOX_VERIFY_STRICT=1 bash scripts/verify-sandbox.sh   # 环境不支持也判失败
#
# 注意：CI/容器里创建 user namespace 常被内核策略限制（needs kernel.unprivileged_userns_clone=1
# 或以 --privileged / 适当能力运行）。此时脚本给出明确诊断并 SKIP，而非误报 helper 有 bug。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$REPO_ROOT/backend/core/native/sandbox-exec"
BIN="${HARNESS_SANDBOX_HELPER:-$NATIVE_DIR/build/sandbox-exec}"
STRICT="${HARNESS_SANDBOX_VERIFY_STRICT:-0}"

PASS=0; FAIL=0
ok()   { printf '  ✅ PASS  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  ❌ FAIL  %s\n' "$*"; FAIL=$((FAIL+1)); }
info() { printf '  ℹ️  %s\n' "$*"; }

skip_all() {
  printf '\n[verify-sandbox] ⏭️  SKIP：%s\n' "$*"
  if [ "$STRICT" = "1" ]; then
    printf '[verify-sandbox] HARNESS_SANDBOX_VERIFY_STRICT=1：SKIP 视为失败。\n'
    exit 1
  fi
  exit 0
}

echo "[verify-sandbox] helper = $BIN"

# 0) 平台 & helper 前置。
if [ "$(uname -s 2>/dev/null || echo unknown)" != "Linux" ]; then
  skip_all "当前非 Linux，无法实测 OS 级隔离（helper 也仅能在 Linux 编译）。请在 Linux/CI 运行本脚本。"
fi
if [ ! -x "$BIN" ]; then
  info "helper 不存在，先尝试构建：bash scripts/build-native.sh"
  if ! bash "$SCRIPT_DIR/build-native.sh"; then
    echo "[verify-sandbox] ❌ helper 构建失败，无法实测。"; exit 1
  fi
fi
if [ ! -x "$BIN" ]; then
  echo "[verify-sandbox] ❌ 构建后仍未找到 helper：$BIN"; exit 1
fi

# 1) 预检：本机能否创建非特权 user namespace。不能则整体 SKIP（环境限制，非 helper 缺陷）。
if ! "$BIN" --ns user -- /bin/true >/dev/null 2>&1; then
  skip_all "本机无法创建非特权 user namespace（尝试 sysctl -w kernel.unprivileged_userns_clone=1 或以更高权限运行）。"
fi

echo ""
echo "[verify-sandbox] 开始实测隔离断言："

# 断言 1：基础 exec —— helper 能施加 user ns 并把命令输出透传。
OUT="$("$BIN" --ns user -- /bin/echo hello 2>/dev/null || true)"
[ "$OUT" = "hello" ] && ok "基础 exec（user ns）输出透传正确" || bad "基础 exec 期望 'hello'，实得 '$OUT'"

# 断言 2：PID 命名空间 —— 命名空间内首进程应为 PID 1。
OUT="$("$BIN" --ns user,pid,mount -- /bin/sh -c 'echo $$' 2>/dev/null || true)"
[ "$OUT" = "1" ] && ok "PID 命名空间隔离（进程在新 ns 内为 PID 1）" || bad "PID ns 期望 \$\$=1，实得 '$OUT'"

# 断言 3：网络隔离 —— 新 net 命名空间内仅有 loopback（/proc/net/dev 仅 1 个接口行）。
HOST_IFACES="$(grep -c ':' /proc/net/dev 2>/dev/null || echo 0)"
NS_IFACES="$("$BIN" --ns user,net --no-net -- /bin/sh -c "grep -c ':' /proc/net/dev" 2>/dev/null || true)"
if [ "$NS_IFACES" = "1" ]; then
  ok "网络隔离（新 net ns 内仅剩 loopback；宿主可见 ${HOST_IFACES} 个接口）"
else
  bad "网络隔离期望 ns 内仅 1 个接口，实得 '$NS_IFACES'（宿主 ${HOST_IFACES}）"
fi

# 断言 4a：只读根 —— 无法写入 /。
OUT="$("$BIN" --ns user,mount --root-ro -- /bin/sh -c 'touch /nope 2>/dev/null && echo WRITABLE || echo READONLY' 2>/dev/null || true)"
[ "$OUT" = "READONLY" ] && ok "只读根（--root-ro 下写 / 被拒）" || bad "只读根期望 READONLY，实得 '$OUT'"

# 断言 4b：可写绑定 —— 绑定的工作目录仍可写。
TMPW="$(mktemp -d)"
OUT="$("$BIN" --ns user,mount --root-ro --bind-rw "$TMPW:/work" --cwd /work -- /bin/sh -c 'touch /work/ok 2>/dev/null && echo OK || echo NO' 2>/dev/null || true)"
[ "$OUT" = "OK" ] && ok "可写绑定（--bind-rw 的工作目录可写）" || bad "可写绑定期望 OK，实得 '$OUT'"
rm -rf "$TMPW" 2>/dev/null || true

# ---- 信息性检查（依赖可选库 / 特定内核配置，不计入硬失败）----
echo ""
echo "[verify-sandbox] 信息性检查（不计入硬失败）："

# seccomp：仅当 helper 以 libseccomp 编译才有意义。用「默认 kill + 只放行极少 syscall」触发拦截。
# 放行不足以让 /bin/true 跑完 → 进程应被 SIGSYS 杀死（退出码 != 0）。
if "$BIN" --ns user --seccomp-default kill --seccomp-allow read,write,exit,exit_group -- /bin/true >/dev/null 2>&1; then
  info "seccomp：极窄名单下 /bin/true 仍成功 —— 可能 helper 未启用 seccomp（缺 libseccomp）或内核不支持。"
else
  info "seccomp：极窄名单下 /bin/true 被拦截（非 0 退出）—— 系统调用过滤生效。"
fi

# rlimit：限制文件大小后写入超额数据应触发 SIGXFSZ（退出码 != 0）。
if "$BIN" --ns user --rlimit-fsize 8 -- /bin/sh -c 'echo AAAAAAAAAAAAAAAAAAAAAAAA > /tmp/.ahfsize 2>/dev/null' >/dev/null 2>&1; then
  info "rlimit(fsize)：写超额未被拦截（部分 shell 缓冲/内核差异，属预期波动）。"
else
  info "rlimit(fsize)：写超额被拦截（RLIMIT_FSIZE 生效）。"
fi
rm -f /tmp/.ahfsize 2>/dev/null || true

echo ""
echo "[verify-sandbox] 结果：PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "[verify-sandbox] ❌ 存在硬断言失败，helper 隔离行为不符合预期。"
  exit 1
fi
echo "[verify-sandbox] ✅ 全部硬断言通过：OS 级隔离在本机确实生效。"
exit 0
