#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${PROJECT_DIR}/outputs"

# Load .env if present
ENV_FILE="${PROJECT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Defaults
GUILD_ID="${DISCORD_GUILD_ID:-}"
TOKEN="${DISCORD_USER_TOKEN:-${DISCORD_TOKEN:-${DISCORD_BOT_TOKEN:-}}}"
LIMIT="${EXPORT_LIMIT:-500}"
DAYS="${EXPORT_DAYS:-30}"
EXPORT_FILE="${OUTPUT_DIR}/discord-export.json"
REPORT_FILE="${OUTPUT_DIR}/discord-synthesis.md"

# Determine token type
if [[ -n "${DISCORD_USER_TOKEN:-}" ]]; then
  TOKEN_FLAG="--user-token"
  TOKEN_VAL="$DISCORD_USER_TOKEN"
else
  TOKEN_FLAG=""
  TOKEN_VAL="$TOKEN"
fi

if [[ -z "$GUILD_ID" ]]; then
  echo "Error: Set DISCORD_GUILD_ID in .env or environment." >&2
  exit 1
fi

if [[ -z "$TOKEN_VAL" ]]; then
  echo "Error: Set DISCORD_USER_TOKEN (or DISCORD_BOT_TOKEN) in .env or environment." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "==> Exporting messages from guild ${GUILD_ID} (last ${DAYS} days, limit ${LIMIT}/channel)..."
node "${SCRIPT_DIR}/export-discord-server.mjs" \
  --guild-id "$GUILD_ID" \
  --token "$TOKEN_VAL" \
  $TOKEN_FLAG \
  --limit "$LIMIT" \
  --days "$DAYS" \
  --out "$EXPORT_FILE"

AI_REPORT="${OUTPUT_DIR}/ai-synthesis.md"

echo ""
echo "==> AI synthesis (extracting money-making strategies via Gemini)..."
node "${SCRIPT_DIR}/synthesize-ai.mjs" \
  --input "$EXPORT_FILE" \
  --out "$AI_REPORT"

echo ""
echo "Done! Report at: ${AI_REPORT}"
