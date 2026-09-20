# Discord Server Synth

Exports messages from a Discord channel or thread, with optional local synthesis scripts.

## Requirements

- Node.js 18 or newer
- No npm packages are required for export or the GUI. Both use Node.js built-in modules.
- The AI synthesis script additionally expects the `gemini` CLI; the export GUI does not use it.

## Run the lightweight export GUI

1. Put the Discord credential and default server ID in this folder's `.env` file. Use either `DISCORD_USER_TOKEN` or `DISCORD_BOT_TOKEN`, plus `DISCORD_GUILD_ID`. Do not share or commit the token; `.env` is gitignored.
2. From this folder, start the local GUI:

   ```sh
   node gui/server.mjs
   ```

3. Open `http://127.0.0.1:4173` in a browser. Enter the server ID, choose Thread or Channel, enter that ID, set the message limit, and click **Export messages**. Bot messages are included by default. The GUI applies no date filter.
4. Each export writes JSON and a matching HTML chat log under `outputs/gui/`, plus a small ZIP and archive listing under `outputs/archives/`. Use **Download ZIP with media** when you want attachments and embed images collected into a ZIP on your device. Attachments are fetched again when requested and are never retained on the server.

The server ID field starts with the value from `.env` in the server-side page only. Credentials stay in Node.js and are never sent to the browser.

## Deploy with Coolify

The repository includes a Dockerfile for Coolify's Dockerfile build pack. Set the application's exposed port to `4173` and its domain to the desired root URL. Configure these environment variables in Coolify before deployment:

- `GUI_USERNAME` (optional; defaults to `admin`)
- `GUI_PASSWORD` (required; set a strong private password)
- `DISCORD_USER_TOKEN` or `DISCORD_BOT_TOKEN` (the exporter credential)
- `DISCORD_GUILD_ID` (optional default server ID; users can change it in the GUI)

The container binds to `0.0.0.0:4173`. The GUI requires HTTP Basic Authentication on public interfaces; the export is downloaded through the authenticated GUI. Do not put secrets in Git or in the Docker build context.

Add a Coolify **Volume Mount** with destination `/app/outputs` before deployment so raw exports, generated chat viewers, ZIPs, and archive indexes survive redeployments. The container runs as the `node` user and the Docker image creates that directory as that user. Existing files in the container are not copied into a new volume automatically; use `node scripts/chat-archive.mjs --input outputs --archives outputs/archives` to package local JSON exports, then copy the resulting `outputs/archives` files into the mounted volume when restoring them to Coolify.

The regular ZIP contains `chat-log/index.html`, `chat-log/messages.json`, and a short README. **Download ZIP with media** refetches Discord attachments and embed media at request time, then streams them directly into a ZIP download without saving them to the Coolify volume. Extract that ZIP and open `chat-log/index.html` to view images, video, and audio inline. Profile pictures use letter initials. Exports above the standard ZIP 4 GiB limit must be split into smaller channel or thread exports. The viewer can switch between a Discord-like Tailwind CDN theme and NES.css, search by message text or user, filter by user and date, and sort chronologically. The `/archives` page lists every generated bundle and lets the user retrieve media again for any export.

## Windows

The exporter and GUI run on Windows with Node.js 18+; install no npm packages. In PowerShell:

```powershell
cd path\to\discord-server-synth
node .\gui\server.mjs
```

Then open `http://127.0.0.1:4173`. The `.mjs` export script is cross-platform. The convenience scripts `scripts/run-pipeline.sh` and `scripts/batch-export.sh` require Bash (for example, Git Bash or WSL) and are not needed for the GUI.

## Command-line export

The standalone exporter remains available:

```sh
node scripts/export-discord-server.mjs \
  --guild-id "$DISCORD_GUILD_ID" \
  --threads "THREAD_ID" \
  --limit 100000 \
  --include-bots \
  --out ./outputs/thread-export.json
```

Use `--channels "CHANNEL_ID"` instead of `--threads` for a channel. Omit both to export eligible channels from the entire server.
