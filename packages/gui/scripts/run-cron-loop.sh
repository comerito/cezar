#!/usr/bin/env bash
# Local stand-in for Vercel Cron. Hits the three CI-loop routes (and the
# three issue-loop routes) on a fixed interval against a running `npm run dev`.
#
# Usage:
#   ./packages/gui/scripts/run-cron-loop.sh             # loop forever, 60s
#   INTERVAL=10 ./packages/gui/scripts/run-cron-loop.sh # 10s ticks
#   BASE_URL=http://localhost:3001 ./...                # different port
#   CRON_SECRET=xyz ./...                               # adds Bearer header
#   ./packages/gui/scripts/run-cron-loop.sh --once      # one tick, then exit
#   ROUTES="ci-watch ci-attribute ci-fix" ./...         # subset of routes

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
INTERVAL="${INTERVAL:-60}"
ROUTES="${ROUTES:-ci-watch ci-attribute ci-fix issue-sync issue-match issue-fix}"

AUTH=()
if [[ -n "${CRON_SECRET:-}" ]]; then
  AUTH=(-H "Authorization: Bearer ${CRON_SECRET}")
fi

ONCE=0
if [[ "${1:-}" == "--once" ]]; then
  ONCE=1
fi

tick() {
  local ts
  ts="$(date +%H:%M:%S)"
  for route in $ROUTES; do
    local url="${BASE_URL}/api/cron/${route}"
    local body status tmp="/tmp/cezar-cron-body.$$"
    status="$(curl -sS -m 300 -o "$tmp" -w '%{http_code}' "${AUTH[@]}" "$url" 2>/dev/null)"
    body="$(cat "$tmp" 2>/dev/null || true)"
    rm -f "$tmp"
    if command -v jq >/dev/null 2>&1 && [[ -n "$body" ]]; then
      body="$(printf '%s' "$body" | jq -c . 2>/dev/null || printf '%s' "$body")"
    fi
    printf '[%s] %-13s %s  %s\n' "$ts" "$route" "$status" "$body"
  done
}

if (( ONCE )); then
  tick
  exit 0
fi

echo "Polling ${BASE_URL} every ${INTERVAL}s. Routes: ${ROUTES}. Ctrl-C to stop."
while true; do
  tick
  sleep "$INTERVAL"
done
