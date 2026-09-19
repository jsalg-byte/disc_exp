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
4. Exports are written to `outputs/gui/`; use the **Download JSON** link to save the file to your computer. Keep the terminal running while using the GUI; press Ctrl+C to stop it.

The server ID field starts with the value from `.env` in the server-side page only. Credentials stay in Node.js and are never sent to the browser.

## Deploy with Coolify

The repository includes a Dockerfile for Coolify's Dockerfile build pack. Set the application's exposed port to `4173` and its domain to the desired root URL. Configure these environment variables in Coolify before deployment:

- `GUI_USERNAME` (optional; defaults to `admin`)
- `GUI_PASSWORD` (required; set a strong private password)
- `DISCORD_USER_TOKEN` or `DISCORD_BOT_TOKEN` (the exporter credential)
- `DISCORD_GUILD_ID` (optional default server ID; users can change it in the GUI)

The container binds to `0.0.0.0:4173`. The GUI requires HTTP Basic Authentication on public interfaces; the export is downloaded through the authenticated GUI. Do not put secrets in Git or in the Docker build context.

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
