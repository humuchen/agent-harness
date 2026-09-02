#!/usr/bin/env bash
# scripts/cron-run-example.sh — 外部 OS 调度包装：周期性触发 agent-harness 运行。
#
# 这是「定时触发」最稳的路线（推荐生产使用）：调度由 OS / 外部 SaaS 负责，
# 本脚本只负责「发一次 POST /api/run」并保证：幂等（flock 防重叠）、失败非零退出（可被告警采集）。
#
# 依赖：curl、jq（用于安全构造 JSON 负载）。
#
# 用法示例：
#   # 每 5 分钟触发一次（crontab -e）
#   */5 * * * * /path/to/scripts/cron-run-example.sh >> /var/log/harness-cron.log 2>&1
#
#   # systemd-timer 见 docs/03-plugins/定时触发演示与说明.md
#
# 环境变量：
#   HARNESS_BASE_URL    默认 http://127.0.0.1:4173
#   OPEN_API_KEY        admin 逃生通道密钥（注意：UI_AUTH_TOKEN 不被 authz 消费！）
#   SCHEDULE_PROMPT     触发提示词
#   SCHEDULE_AGENT_ID   指定 agent（可选）
#   CRON_LOCK_FILE      锁文件（防重叠），默认 /tmp/harness-cron.lock

set -euo pipefail

command -v curl >/dev/null 2>&1 || { echo "[cron] 需要 curl" >&2; exit 1; }
command -v jq   >/dev/null 2>&1 || { echo "[cron] 需要 jq"    >&2; exit 1; }

HARNESS_BASE_URL="${HARNESS_BASE_URL:-http://127.0.0.1:4173}"
OPEN_API_KEY="${OPEN_API_KEY:-}"
PROMPT="${SCHEDULE_PROMPT:-执行一次定时巡检任务。}"
AGENT_ID="${SCHEDULE_AGENT_ID:-}"
LOCK_FILE="${CRON_LOCK_FILE:-/tmp/harness-cron.lock}"

# 幂等：若上一次触发仍在进行（如模型响应很慢），本次直接跳过，避免重叠与重复执行。
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cron] 已有实例在运行，跳过本次（防重叠）" >&2
  exit 0
fi

run_id="cron-$(date +%Y%m%dT%H%M%S)-$$"

# 用 jq 安全构造 JSON（正确处理引号 / 换行 / 空值）。
payload=$(jq -n \
  --arg p "$PROMPT" \
  --arg a "$AGENT_ID" \
  --arg r "$run_id" \
  '{prompt:$p, agentId:(if $a=="" then null else $a end), runId:$r}')

http_code=$(curl -s -o /tmp/harness-cron.resp -w '%{http_code}' \
  -X POST "$HARNESS_BASE_URL/api/run" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $OPEN_API_KEY" \
  --data "$payload" \
  --max-time 120 || echo 000)

if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 400 ]; then
  echo "[cron] 触发失败 HTTP=$http_code body=$(head -c 200 /tmp/harness-cron.resp 2>/dev/null)" >&2
  exit 1
fi

echo "[cron] 触发成功 HTTP=$http_code runId=$run_id"
exit 0
