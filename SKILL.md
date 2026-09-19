---
name: discord-server-synth
description: Extract and synthesize Discord server data through the official Discord bot API. Use when Codex needs to ingest guild channels/messages, produce structured JSON exports, summarize server activity, or answer questions from Discord server history.
---

# Discord Server Synth

Use this skill to pull Discord server messages and synthesize them into actionable intelligence, with a default focus on TikTok ad creator servers.

## Workflow

1. Use only official Discord bot access. Do not scrape the Electron app cache and do not use user tokens.
2. Confirm credentials:
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`.
3. If setup is missing, read `references/discord-bot-setup.md`.
4. If server jargon is custom, read `references/tiktok-ads-taxonomy.md` and adjust terms.
5. Export raw data with `scripts/export-discord-server.mjs`.
6. Synthesize report with `scripts/synthesize-discord-export.mjs`.
7. Answer user questions using both report and raw JSON, including channel and date context.

## Quick Commands

```bash
export DISCORD_BOT_TOKEN="your-bot-token"
export DISCORD_GUILD_ID="your-guild-id"

node scripts/export-discord-server.mjs \
  --guild-id "$DISCORD_GUILD_ID" \
  --limit 250 \
  --days 30 \
  --out ./outputs/discord-export.json

node scripts/synthesize-discord-export.mjs \
  --input ./outputs/discord-export.json \
  --focus tiktok-ads \
  --out ./outputs/discord-synthesis.md
```

## Export Script Options

- `--guild-id <id>`: Discord guild/server id. Falls back to `DISCORD_GUILD_ID`.
- `--token <token>`: Bot token. Falls back to `DISCORD_BOT_TOKEN`.
- `--channels <id1,id2,...>`: Optional channel id allow-list.
- `--threads <id1,id2,...>`: Optional thread id allow-list (mutually exclusive with `--channels`). Pass Discord thread IDs directly; the script fetches each thread's metadata and messages. The token must be able to view the thread and its message history.
- `--limit <n>`: Max messages per channel (default `250`).
- `--days <n>`: Keep only messages newer than last `n` days.
- `--include-bots`: Include bot-authored messages.
- `--out <path>`: JSON output file path.

To export a specific thread instead of a channel, use `--threads`:

```bash
node scripts/export-discord-server.mjs \
  --guild-id "$DISCORD_GUILD_ID" \
  --threads "THREAD_ID" \
  --limit 500 \
  --days 30 \
  --out ./outputs/discord-thread-export.json
```

Use `--channels "CHANNEL_ID"` to export a channel as before, or omit both selectors to export all eligible server channels. Do not provide both selectors in the same command.

## Synthesis Output

The synthesis script generates (default `--focus tiktok-ads`):

- Snapshot metrics (channels, messages, authors, date range)
- Key points from recurring tactical discussions
- Main strategies discussed (creative, media buying, offer/CVR, monetization, policy risk)
- Monetization signals (metrics like ROAS/CPA/CTR/margin/revenue)
- Suggested action plan from dominant strategy clusters
- Most active channels and contributors
- Recurring keywords
- Open questions (messages containing `?`)
- Recent highlights with jump URLs

Use these outputs to produce final narrative synthesis for the user.
