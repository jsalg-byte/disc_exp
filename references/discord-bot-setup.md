# Discord Bot Setup For Server Ingestion

Use this setup when `discord-server-synth` needs to pull server messages.

## 1. Create Bot Application

1. Open Discord Developer Portal.
2. Create a new application.
3. Add a bot user under the `Bot` tab.
4. Enable `MESSAGE CONTENT INTENT` (required to read message text).
5. Copy the bot token and keep it secret.

## 2. Add Bot To Target Server

Use OAuth2 URL generation with:

- Scope: `bot`
- Bot permissions:
  - `View Channels`
  - `Read Message History`

Invite the bot into the target server.

## 3. Collect IDs

1. In Discord client settings, enable Developer Mode.
2. Copy:
  - Server id (`guild id`)
  - Optional channel ids to restrict ingestion

## 4. Configure Environment

```bash
export DISCORD_BOT_TOKEN="your-bot-token"
export DISCORD_GUILD_ID="your-guild-id"
```

## 5. Run The Pipeline

```bash
node scripts/export-discord-server.mjs \
  --guild-id "$DISCORD_GUILD_ID" \
  --limit 250 \
  --days 30 \
  --out ./outputs/discord-export.json

node scripts/synthesize-discord-export.mjs \
  --input ./outputs/discord-export.json \
  --out ./outputs/discord-synthesis.md
```

## Security Notes

- Never use your personal Discord user token.
- Never scrape Discord desktop app cache for auth or messages.
- Rotate bot token immediately if exposed.
