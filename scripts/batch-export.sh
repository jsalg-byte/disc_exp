#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${PROJECT_DIR}/outputs"

ENV_FILE="${PROJECT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

TOKEN="${DISCORD_USER_TOKEN:-}"
GUILD_ID="${DISCORD_GUILD_ID:-}"

if [[ -z "$TOKEN" || -z "$GUILD_ID" ]]; then
  echo "Error: Set DISCORD_USER_TOKEN and DISCORD_GUILD_ID in .env" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# 30-day windows going back 5 months from 2026-03-09
# Month 1 (Feb 7 - Mar 9) already done
WINDOWS=(
  "2026-01-08 2026-02-07 2026-01-08-to-2026-02-07"
  "2025-12-09 2026-01-08 2025-12-09-to-2026-01-08"
  "2025-11-09 2025-12-09 2025-11-09-to-2025-12-09"
  "2025-10-10 2025-11-09 2025-10-10-to-2025-11-09"
)

for window in "${WINDOWS[@]}"; do
  read -r AFTER BEFORE LABEL <<< "$window"
  EXPORT_FILE="${OUTPUT_DIR}/discord-export-${LABEL}.json"
  SYNTH_FILE="${OUTPUT_DIR}/ai-synthesis-${LABEL}.md"

  echo ""
  echo "=============================="
  echo "==> Window: ${AFTER} to ${BEFORE}"
  echo "=============================="

  if [[ -f "$SYNTH_FILE" ]]; then
    echo "Synthesis already exists, skipping: $SYNTH_FILE"
    continue
  fi

  echo "==> Exporting messages..."
  node "${SCRIPT_DIR}/export-discord-server.mjs" \
    --guild-id "$GUILD_ID" \
    --token "$TOKEN" \
    --user-token \
    --limit 500 \
    --after "$AFTER" \
    --before "$BEFORE" \
    --out "$EXPORT_FILE"

  # Check if there are any messages
  MSG_COUNT=$(node -e "const d=JSON.parse(require('fs').readFileSync('${EXPORT_FILE}','utf8'));console.log(d.totals.totalMessages)")
  echo "Messages found: $MSG_COUNT"

  if [[ "$MSG_COUNT" -eq 0 ]]; then
    echo "No messages in this window, skipping synthesis."
    continue
  fi

  echo "==> Running AI synthesis..."
  node "${SCRIPT_DIR}/synthesize-ai.mjs" \
    --input "$EXPORT_FILE" \
    --out "$SYNTH_FILE"

  echo "==> Done: $SYNTH_FILE"
done

echo ""
echo "All windows complete. Reports in: $OUTPUT_DIR"
