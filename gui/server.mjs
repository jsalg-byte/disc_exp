#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import { once } from "node:events";
import { createHash, timingSafeEqual } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const port = Number.parseInt(process.env.PORT ?? process.env.GUI_PORT ?? "4173", 10);
const bindHost = process.env.HOST ?? "127.0.0.1";
const html = await fs.readFile(path.join(here, "index.html"), "utf8");
const archivesHtml = await fs.readFile(path.join(here, "archives.html"), "utf8");
const exportDataDir = path.resolve(process.env.EXPORT_DATA_DIR ?? path.join(projectDir, "outputs"));
const exportDir = path.join(exportDataDir, "gui");
const archiveDir = path.join(exportDataDir, "archives");

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadCredentials() {
  let fileValues = {};
  try {
    fileValues = parseEnv(await fs.readFile(path.join(projectDir, ".env"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...process.env, ...fileValues };
}

const startupCredentials = await loadCredentials();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function secureStringEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function isAuthorized(request) {
  const credentials = await loadCredentials();
  const password = credentials.GUI_PASSWORD;
  if (!password) return bindHost === "127.0.0.1" || bindHost === "localhost";

  const authorization = request.headers.authorization ?? "";
  if (!authorization.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = credentials.GUI_USERNAME ?? "admin";
  return secureStringEqual(decoded.slice(0, separator), username)
    && secureStringEqual(decoded.slice(separator + 1), password);
}

function requestAuthentication(response) {
  response.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Discord Export", charset="UTF-8"',
    "Cache-Control": "no-store",
  });
  response.end("Authentication required.");
}

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8_192) throw new Error("Request is too large.");
  }
  return JSON.parse(body);
}

const zipCrcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  zipCrcTable[n] = value >>> 0;
}

function zipTimestamp(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class HttpZipWriter {
  constructor(response) {
    this.response = response;
    this.entries = [];
    this.offset = 0;
  }

  async write(buffer) {
    if (this.response.destroyed) throw new Error("Download connection closed.");
    if (!this.response.write(buffer)) await once(this.response, "drain");
    this.offset += buffer.length;
  }

  async add(name, source, { compress = true } = {}) {
    if (this.entries.length >= 65_000) throw new Error("This export has too many files for a standard ZIP archive.");
    const encodedName = Buffer.from(name, "utf8");
    const method = compress ? 8 : 0;
    const stamp = zipTimestamp();
    const localOffset = this.offset;
    const local = Buffer.alloc(30 + encodedName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(encodedName.length, 26);
    local.writeUInt16LE(0, 28);
    encodedName.copy(local, 30);
    await this.write(local);

    let checksum = 0xffffffff;
    let uncompressedSize = 0;
    let compressedSize = 0;
    const crc = new Transform({
      transform(chunk, _encoding, callback) {
        uncompressedSize += chunk.length;
        for (const byte of chunk) checksum = zipCrcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
        callback(null, chunk);
      },
    });
    const countCompressed = new Transform({
      transform(chunk, _encoding, callback) {
        compressedSize += chunk.length;
        thisZip.offset += chunk.length;
        callback(null, chunk);
      },
    });
    const thisZip = this;
    const input = Buffer.isBuffer(source) || typeof source === "string"
      ? Readable.from([Buffer.isBuffer(source) ? source : Buffer.from(source)])
      : source;
    const chain = compress
      ? [input, crc, createDeflateRaw({ level: 6 }), countCompressed, this.response]
      : [input, crc, countCompressed, this.response];
    await pipeline(...chain, { end: false });
    checksum = (checksum ^ 0xffffffff) >>> 0;
    if (uncompressedSize > 0xffffffff || compressedSize > 0xffffffff || this.offset > 0xffffffff) {
      throw new Error("This export exceeds the standard ZIP 4 GiB limit.");
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);
    await this.write(descriptor);
    this.entries.push({ name: encodedName, method, stamp, checksum, compressedSize, uncompressedSize, localOffset });
  }

  async finish() {
    const centralOffset = this.offset;
    for (const entry of this.entries) {
      const central = Buffer.alloc(46 + entry.name.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0808, 8);
      central.writeUInt16LE(entry.method, 10);
      central.writeUInt16LE(entry.stamp.time, 12);
      central.writeUInt16LE(entry.stamp.date, 14);
      central.writeUInt32LE(entry.checksum, 16);
      central.writeUInt32LE(entry.compressedSize, 20);
      central.writeUInt32LE(entry.uncompressedSize, 24);
      central.writeUInt16LE(entry.name.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(entry.localOffset, 42);
      entry.name.copy(central, 46);
      await this.write(central);
    }
    const directorySize = this.offset - centralOffset;
    if (this.entries.length > 0xffff || directorySize > 0xffffffff || centralOffset > 0xffffffff) {
      throw new Error("This export exceeds the standard ZIP directory limits.");
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    const finished = once(this.response, "finish");
    this.response.end();
    await finished;
  }
}

function isExpiredDiscordUrl(url) {
  try {
    const expires = new URL(url).searchParams.get("ex");
    return expires !== null && Number.parseInt(expires, 16) * 1000 <= Date.now() + 60_000;
  } catch {
    return false;
  }
}

async function readJsonResponse(response) {
  try { return await response.json(); } catch { return null; }
}

async function getCurrentDiscordMessage(channelId, messageId, token, userToken) {
  const endpoint = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const result = await fetch(endpoint, { headers: { Authorization: userToken ? token : `Bot ${token}` } });
    if (result.status === 429) {
      const payload = await readJsonResponse(result);
      await new Promise((resolve) => setTimeout(resolve, Math.ceil((payload?.retry_after ?? 1) * 1000) + 100));
      continue;
    }
    if (result.status >= 500 && result.status < 600) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    return result.ok ? readJsonResponse(result) : null;
  }
  return null;
}

function refreshPayloadMedia(message, raw) {
  const currentAttachments = raw.attachments ?? [];
  for (const [index, attachment] of (message.attachments ?? []).entries()) {
    const current = currentAttachments.find((item) => item.id === attachment.id) ?? currentAttachments[index];
    if (current?.url) attachment.url = current.url;
    if (current?.proxy_url) attachment.proxyUrl = current.proxy_url;
    if (current?.content_type) attachment.contentType = current.content_type;
  }
  for (const [index, embed] of (message.embeds ?? []).entries()) {
    const current = raw.embeds?.[index];
    if (!current) continue;
    embed.imageUrl = current.image?.proxy_url ?? current.image?.url ?? embed.imageUrl ?? null;
    embed.thumbnailUrl = current.thumbnail?.proxy_url ?? current.thumbnail?.url ?? embed.thumbnailUrl ?? null;
    embed.videoUrl = current.video?.url ?? embed.videoUrl ?? null;
  }
}

function extensionForMedia(url, filename, contentType) {
  const known = new Map([
    ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/gif", ".gif"], ["image/webp", ".webp"],
    ["image/avif", ".avif"], ["video/mp4", ".mp4"], ["video/quicktime", ".mov"], ["video/webm", ".webm"],
    ["audio/ogg", ".ogg"], ["audio/mpeg", ".mp3"], ["audio/mp4", ".m4a"], ["audio/wav", ".wav"],
  ]);
  const fromName = path.extname(filename ?? "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  try {
    const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(fromUrl)) return fromUrl;
  } catch {}
  return known.get(String(contentType ?? "").split(";")[0].toLowerCase()) ?? ".bin";
}

function isAllowedMediaHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "discordapp.com" || parsed.hostname.endsWith(".discordapp.com") || parsed.hostname === "discordapp.net" || parsed.hostname.endsWith(".discordapp.net"));
  } catch {
    return false;
  }
}

function messageMediaIsExpired(message) {
  return (message.attachments ?? []).some((item) => isExpiredDiscordUrl(item.url))
    || (message.embeds ?? []).some((item) => (
      (!Object.hasOwn(item, "imageUrl") && !Object.hasOwn(item, "thumbnailUrl") && !Object.hasOwn(item, "videoUrl"))
      || isExpiredDiscordUrl(item.imageUrl)
      || isExpiredDiscordUrl(item.thumbnailUrl)
      || isExpiredDiscordUrl(item.videoUrl)
    ));
}

async function streamOneMedia(zip, url, filename, contentType, target, field, cache, unavailable, fallbackUrl = null) {
  if (!url || !isAllowedMediaHost(url)) return;
  if (cache.has(url)) {
    const existing = cache.get(url);
    if (existing) target[field] = existing;
    return;
  }
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 20);
  const name = `assets/${digest}${extensionForMedia(url, filename, contentType)}`;
  let media = null;
  let failure = "fetch failed";
  const candidates = [...new Set([url, fallbackUrl].filter((item) => item && isAllowedMediaHost(item)))];
  for (const candidate of candidates) {
    try {
      const result = await fetch(candidate);
      if (result.ok && result.body) {
        media = result;
        break;
      }
      failure = `HTTP ${result.status}`;
    } catch (error) {
      failure = error.message;
    }
  }
  if (!media) {
    unavailable.push(`${name} (${failure})`);
    cache.set(url, null);
    return;
  }
  await zip.add(`chat-log/${name}`, Readable.fromWeb(media.body), { compress: false });
  target[field] = name;
  cache.set(url, name);
}

async function streamMediaZip(response, archiveName, metadata, payload, credentials) {
  const outputRoot = path.resolve(archiveDir, "..");
  const sourcePath = await resolveArchiveSource(outputRoot, metadata);
  const stats = await fs.stat(sourcePath);
  if (stats.size > 0xffffffff) throw new Error("The JSON export is too large for a standard ZIP archive.");
  const expectedMediaBytes = (payload.channels ?? []).reduce((sum, channel) => sum + (channel.messages ?? []).reduce((messageSum, message) => messageSum + (message.attachments ?? []).reduce((assetSum, asset) => assetSum + (Number(asset.size) || 0), 0), 0), 0);
  if (expectedMediaBytes > 0xffffffff - stats.size - 10_000_000) {
    throw new Error("This export is over 4 GiB of attachments. Download smaller channel or thread exports separately.");
  }

  response.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${archiveName.replace(/\.zip$/i, "-with-media.zip")}"`,
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  const zip = new HttpZipWriter(response);
  await zip.add("chat-log/README.txt", "This ZIP includes the chat viewer, raw JSON, and media fetched from Discord for this download. Media is not retained on the server. Extract the folder and open index.html.");

  const token = credentials.DISCORD_USER_TOKEN ?? credentials.DISCORD_BOT_TOKEN ?? credentials.DISCORD_TOKEN;
  const userToken = Boolean(credentials.DISCORD_USER_TOKEN);
  let refreshAttempts = 0;
  let refreshUnavailable = 0;
  const assetCache = new Map();
  const unavailable = [];
  for (const channel of payload.channels ?? []) {
    for (const message of channel.messages ?? []) {
      for (const attachment of message.attachments ?? []) delete attachment.archiveAsset;
      for (const embed of message.embeds ?? []) {
        delete embed.archiveImage;
        delete embed.archiveThumbnail;
        delete embed.archiveVideo;
      }
      if (messageMediaIsExpired(message)) {
        refreshAttempts += 1;
        if (token && /^\d+$/.test(String(message.id ?? "")) && /^\d+$/.test(String(message.channelId ?? channel.id ?? ""))) {
          try {
            const current = await getCurrentDiscordMessage(message.channelId ?? channel.id, message.id, token, userToken);
            if (current) refreshPayloadMedia(message, current);
            else refreshUnavailable += 1;
          } catch {
            refreshUnavailable += 1;
          }
        } else refreshUnavailable += 1;
      }
      for (const attachment of message.attachments ?? []) {
        await streamOneMedia(zip, attachment.url, attachment.filename, attachment.contentType, attachment, "archiveAsset", assetCache, unavailable, attachment.proxyUrl);
      }
      for (const embed of message.embeds ?? []) {
        await streamOneMedia(zip, embed.imageUrl, embed.title, null, embed, "archiveImage", assetCache, unavailable);
        await streamOneMedia(zip, embed.thumbnailUrl, embed.title, null, embed, "archiveThumbnail", assetCache, unavailable);
        await streamOneMedia(zip, embed.videoUrl, embed.title, null, embed, "archiveVideo", assetCache, unavailable);
      }
    }
  }

  const templatePayload = JSON.stringify(payload).replace(/&/g, "\\u0026").replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const viewerTemplate = await fs.readFile(path.join(here, "chat-viewer.html"), "utf8");
  const viewer = viewerTemplate.replace("__EXPORT_JSON_DATA__", templatePayload);
  await zip.add("chat-log/index.html", viewer);
  await zip.add("chat-log/messages.json", `${JSON.stringify(payload, null, 2)}\n`);
  if (unavailable.length || refreshUnavailable) {
    const failed = [
      `Could not retrieve ${unavailable.length} media file(s).`,
      `Expired media URLs checked on ${refreshAttempts} message(s); ${refreshUnavailable} message refresh(es) failed.`,
      ...unavailable,
      "",
    ].join("\n");
    await zip.add("chat-log/unavailable-media.txt", failed);
  }
  await zip.finish();
}

async function resolveArchiveSource(outputRoot, metadata) {
  if (metadata.sourcePath) {
    const relative = String(metadata.sourcePath).replace(/\\/g, "/");
    if (relative.startsWith("/") || relative.split("/").includes("..")) throw new Error("Invalid source path in archive metadata.");
    const candidate = path.resolve(outputRoot, relative);
    if (candidate.startsWith(`${outputRoot}${path.sep}`) && (await fs.stat(candidate)).isFile()) return candidate;
  }
  const matches = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && full !== archiveDir) await visit(full);
      else if (entry.isFile() && entry.name === metadata.sourceFile) matches.push(full);
    }
  }
  await visit(outputRoot);
  if (matches.length !== 1) throw new Error(matches.length ? "The archive source filename is ambiguous." : "The source JSON for this archive is no longer available.");
  return matches[0];
}

function runExport({ guildId, targetId, targetType, limit, includeBots, credentials }) {
  return new Promise((resolve) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(exportDir, `${targetType}-${targetId}-${stamp}.json`);
    const scriptPath = path.join(projectDir, "scripts", "export-discord-server.mjs");
    const args = [
      scriptPath,
      "--guild-id", guildId,
      targetType === "thread" ? "--threads" : "--channels",
      targetId,
      "--limit", String(limit),
      "--out", outputPath,
    ];
    if (includeBots) args.push("--include-bots");

    const childEnv = { ...credentials };
    if (credentials.DISCORD_USER_TOKEN) {
      args.push("--user-token");
    } else if (!credentials.DISCORD_BOT_TOKEN && !credentials.DISCORD_TOKEN) {
      resolve({ ok: false, error: "Set DISCORD_USER_TOKEN or DISCORD_BOT_TOKEN in the project .env file." });
      return;
    }

    const child = spawn(process.execPath, args, { cwd: projectDir, env: childEnv, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", async (code) => {
      if (code === 0) {
        try {
          const archiveLine = stdout.split(/\r?\n/).find((line) => line.startsWith("CHAT_ARCHIVE "));
          if (!archiveLine) throw new Error("Exporter did not return archive details.");
          const archive = JSON.parse(archiveLine.slice("CHAT_ARCHIVE ".length));
          resolve({
            ok: true,
            outputPath,
            message: stdout.trim(),
            archiveTitle: archive.title,
            zipDownloadUrl: `/api/archive-download?file=${encodeURIComponent(archive.file)}`,
            mediaZipDownloadUrl: `/api/archive-with-media?file=${encodeURIComponent(archive.file)}`,
            viewerUrl: `/api/archive-viewer?file=${encodeURIComponent(archive.viewerFile)}`,
            rawDownloadUrl: `/api/download?file=${encodeURIComponent(path.basename(outputPath))}`,
          });
        } catch (error) {
          resolve({ ok: false, error: `JSON exported, but chat archive creation failed: ${error.message}` });
        }
      } else {
        resolve({ ok: false, error: (stderr || stdout || `Exporter exited with code ${code}.`).trim() });
      }
    });
  });
}

const server = createServer(async (request, response) => {
  if (!await isAuthorized(request)) {
    requestAuthentication(response);
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/archives") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(archivesHtml);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/config") {
    const credentials = await loadCredentials();
    sendJson(response, 200, { guildId: credentials.DISCORD_GUILD_ID ?? "" });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/archives") {
    try {
      const files = await fs.readdir(archiveDir, { withFileTypes: true });
      const records = await Promise.all(files
        .filter((file) => file.isFile() && /^export-[a-z0-9-]+-[a-f0-9]{8}\.meta\.json$/.test(file.name))
        .map(async (file) => {
          try {
            const metadata = JSON.parse(await fs.readFile(path.join(archiveDir, file.name), "utf8"));
            await fs.access(path.join(archiveDir, metadata.file));
            await fs.access(path.join(archiveDir, metadata.viewerFile));
            return {
              title: metadata.title,
              serverName: metadata.serverName,
              targetTitle: metadata.targetTitle,
              targetType: metadata.targetType,
              totalMessages: metadata.totalMessages,
              channelCount: metadata.channelCount,
              generatedAt: metadata.generatedAt,
              file: metadata.file,
              viewerFile: metadata.viewerFile,
            };
          } catch {
            return null;
          }
        }));
      records.sort((a, b) => (b?.generatedAt ?? "").localeCompare(a?.generatedAt ?? ""));
      sendJson(response, 200, records.filter(Boolean));
    } catch (error) {
      if (error.code === "ENOENT") sendJson(response, 200, []);
      else sendJson(response, 500, { error: "Unable to load archives." });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/archive-download") {
    const filename = requestUrl.searchParams.get("file") ?? "";
    if (!/^export-[a-z0-9-]+-[a-f0-9]{8}\.zip$/.test(filename)) {
      sendJson(response, 400, { error: "Invalid archive file name." });
      return;
    }
    try {
      const filePath = path.join(archiveDir, filename);
      const stat = await fs.stat(filePath);
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      });
      createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
    } catch (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "Archive file not found." });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/archive-with-media") {
    const filename = requestUrl.searchParams.get("file") ?? "";
    if (!/^export-[a-z0-9-]+-[a-f0-9]{8}\.zip$/.test(filename)) {
      sendJson(response, 400, { error: "Invalid archive file name." });
      return;
    }
    try {
      const metadataPath = path.join(archiveDir, filename.replace(/\.zip$/i, ".meta.json"));
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      const sourcePath = await resolveArchiveSource(path.resolve(archiveDir, ".."), metadata);
      const payload = JSON.parse(await fs.readFile(sourcePath, "utf8"));
      await streamMediaZip(response, filename, metadata, payload, await loadCredentials());
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else sendJson(response, error.message.includes("4 GiB") ? 413 : error.code === "ENOENT" ? 404 : 500, { error: error.message });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/archive-viewer") {
    const filename = requestUrl.searchParams.get("file") ?? "";
    if (!/^export-[a-z0-9-]+-[a-f0-9]{8}\.html$/.test(filename)) {
      sendJson(response, 400, { error: "Invalid viewer file name." });
      return;
    }
    try {
      const viewer = await fs.readFile(path.join(archiveDir, filename), "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(viewer);
    } catch (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "Viewer file not found." });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/download") {
    const filename = requestUrl.searchParams.get("file") ?? "";
    if (!/^(channel|thread)-\d+-[\dTZ-]+\.json$/.test(filename)) {
      sendJson(response, 400, { error: "Invalid export file name." });
      return;
    }
    const filePath = path.join(exportDir, filename);
    try {
      const stat = await fs.stat(filePath);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      });
      const stream = createReadStream(filePath);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "Export file not found." });
    }
    return;
  }

  if (request.method !== "POST" || requestUrl.pathname !== "/api/export") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { error: "Requests must come from this GUI." });
        return;
      }
    } catch {
      sendJson(response, 403, { error: "Invalid request origin." });
      return;
    }
  }

  try {
    const body = await readRequestBody(request);
    const { guildId, targetId, targetType } = body;
    const limit = Number(body.limit);
    if (!/^\d+$/.test(String(guildId ?? "")) || !/^\d+$/.test(String(targetId ?? ""))) {
      sendJson(response, 400, { error: "Enter numeric server and channel/thread IDs." });
      return;
    }
    if (!["channel", "thread"].includes(targetType)) {
      sendJson(response, 400, { error: "Choose channel or thread." });
      return;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
      sendJson(response, 400, { error: "Message limit must be from 1 to 1,000,000." });
      return;
    }

    const credentials = await loadCredentials();
    if (!credentials.DISCORD_USER_TOKEN && !credentials.DISCORD_BOT_TOKEN && !credentials.DISCORD_TOKEN) {
      sendJson(response, 400, { error: "Set DISCORD_USER_TOKEN or DISCORD_BOT_TOKEN in the project .env file." });
      return;
    }
    const result = await runExport({ ...body, limit, credentials });
    sendJson(response, result.ok ? 200 : 500, result);
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
});

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid port: ${port}`);
}
if (!["127.0.0.1", "localhost"].includes(bindHost) && !startupCredentials.GUI_PASSWORD) {
  throw new Error("Refusing to listen on a public interface without GUI_PASSWORD.");
}

server.listen(port, bindHost, () => {
  console.log(`Discord export GUI listening on ${bindHost}:${port}`);
  if (["127.0.0.1", "localhost"].includes(bindHost)) {
    console.log("Keep this terminal open while using the GUI. Press Ctrl+C to stop.");
  }
});
