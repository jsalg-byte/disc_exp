# User Token Setup (No Admin Required)

Two methods to export messages from a server you're a member of.

## Method A: User Token + Export Script (Recommended)

### 1. Get Your User Token

1. Open Discord desktop app (with Vencord).
2. Press `Cmd+Shift+I` (or `Ctrl+Shift+I`) to open DevTools.
3. Go to the **Console** tab.
4. Paste this and press Enter:

```js
(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken).exports.default.getToken()
```

5. Copy the returned string (your token).

**Alternative (Network tab):**
1. Open DevTools > **Network** tab.
2. Perform any action in Discord (switch channels, send a message).
3. Click any request to `discord.com/api`.
4. In the request headers, find `Authorization:` — that value is your token.

### 2. Get the Guild (Server) ID

1. In Discord, go to Settings > Advanced > enable **Developer Mode**.
2. Right-click the server icon > **Copy Server ID**.

### 3. Run the Export

```bash
export DISCORD_USER_TOKEN="your-token-here"
export DISCORD_GUILD_ID="your-guild-id"

node scripts/export-discord-server.mjs \
  --guild-id "$DISCORD_GUILD_ID" \
  --user-token \
  --limit 500 \
  --days 30 \
  --out ./outputs/discord-export.json
```

### 4. Synthesize

```bash
node scripts/synthesize-discord-export.mjs \
  --input ./outputs/discord-export.json \
  --out ./outputs/discord-synthesis.md
```

Or use the unified script:

```bash
./scripts/run-pipeline.sh
```

## Method B: Vencord Plugin (In-Client)

No token copying needed. The plugin runs inside Discord itself.

### 1. Install the Plugin

Copy the plugin file to your Vencord userplugins directory:

```bash
# macOS (Vencord installed via installer)
cp vencord-plugin/serverExport.ts \
  ~/Library/Application\ Support/Vencord/src/userplugins/serverExport.ts

# If using Vencord from source
cp vencord-plugin/serverExport.ts \
  /path/to/Vencord/src/userplugins/serverExport/index.ts
```

### 2. Rebuild Vencord

```bash
cd /path/to/Vencord && pnpm build
```

Or if Vencord auto-reloads, just restart Discord.

### 3. Enable the Plugin

1. Open Discord > Settings > Vencord > Plugins.
2. Find "ServerExport" and enable it.
3. Configure settings (limit, days, include bots).

### 4. Export

- Navigate to any server.
- Type `/export-server` in the chat box, or click the Vencord toolbox icon and select "Export Server".
- A JSON file will download to your browser/downloads folder.
- Move it to `./outputs/discord-export.json` and run the synthesis script.

## Security Notes

- Your user token grants full access to your account. Never share it.
- Store it only in environment variables, not in files checked into git.
- The `.env` file is gitignored for safety.
- If you suspect your token was exposed, change your Discord password immediately (this rotates the token).
