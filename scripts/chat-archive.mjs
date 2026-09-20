#!/usr/bin/env node

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const viewerTemplatePath = path.resolve(scriptDir, "../gui/chat-viewer.html");

function slugify(value) {
  return String(value ?? "export")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "export";
}

function identifyExport(payload, inputPath) {
  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  const filters = payload.filters ?? {};
  const threadIds = filters.selectedThreadIds ?? [];
  const channelIds = filters.selectedChannelIds ?? [];
  let targetType = filters.targetType;
  if (!targetType) {
    if (threadIds.length > 0) targetType = "thread";
    else if (channelIds.length === 1 && channels.length === 1) targetType = "channel";
    else targetType = "server";
  }

  const singleTarget = channels.length === 1 ? channels[0] : null;
  let targetTitle;
  if (targetType === "thread" || targetType === "channel") {
    targetTitle = singleTarget?.name ?? singleTarget?.id ?? path.basename(inputPath, path.extname(inputPath));
  } else {
    targetTitle = `${channels.length} channels`;
  }

  const serverName = payload.guild?.name ?? "Discord server";
  const totalMessages = payload.totals?.totalMessages
    ?? channels.reduce((sum, channel) => sum + (channel.messages?.length ?? 0), 0);
  return {
    serverName,
    targetTitle,
    targetType,
    title: `${serverName} - ${targetTitle}`,
    totalMessages,
    channelCount: channels.length,
    generatedAt: payload.generatedAt ?? null,
  };
}

function buildViewerHtml(template, payload) {
  const safeData = JSON.stringify(payload)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return template.replace("__EXPORT_JSON_DATA__", safeData);
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  const stamp = dosDateTime(new Date());
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const compressed = deflateRawSync(content, { level: 6 });
    const checksum = crc32(content);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.dosTime, 10);
    local.writeUInt16LE(stamp.dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.dosTime, 12);
    central.writeUInt16LE(stamp.dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    localOffset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function atomicWrite(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, data);
  await fs.rename(tempPath, filePath);
}

export async function createChatArchive(inputPath, archiveDir) {
  const rawJson = await fs.readFile(inputPath);
  const payload = JSON.parse(rawJson.toString("utf8"));
  const details = identifyExport(payload, inputPath);
  const hash = createHash("sha256").update(rawJson).digest("hex").slice(0, 8);
  const key = `${slugify(`${details.title}-${path.basename(inputPath, path.extname(inputPath))}`)}-${hash}`;
  const zipName = `export-${key}.zip`;
  const viewerName = `export-${key}.html`;
  const metaName = `export-${key}.meta.json`;
  const template = await fs.readFile(viewerTemplatePath, "utf8");
  const viewer = buildViewerHtml(template, payload);
  const readme = [
    details.title,
    "",
    "Open index.html in a modern browser to view and search the chat log.",
    "The viewer uses the included JSON data and also includes messages.json as the raw export.",
    "The style toggle loads NES.css and Tailwind from their public CDNs.",
    "",
  ].join("\n");
  const archive = createZip([
    { name: "chat-log/index.html", data: viewer },
    { name: "chat-log/messages.json", data: rawJson },
    { name: "chat-log/README.txt", data: readme },
  ]);

  const metadata = {
    ...details,
    file: zipName,
    viewerFile: viewerName,
    sourceFile: path.basename(inputPath),
    generatedAt: details.generatedAt,
  };
  await atomicWrite(path.join(archiveDir, zipName), archive);
  await atomicWrite(path.join(archiveDir, viewerName), viewer);
  const siblingViewer = `${path.basename(inputPath, path.extname(inputPath))}.html`;
  await atomicWrite(path.join(path.dirname(inputPath), siblingViewer), viewer);
  await atomicWrite(path.join(archiveDir, metaName), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function listJsonFiles(directory) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(fullPath);
    }
  }
  await visit(directory);
  return files;
}

export async function backfillChatArchives(inputPath, archiveDir) {
  const inputStat = await fs.stat(inputPath);
  const files = inputStat.isDirectory()
    ? await listJsonFiles(inputPath)
    : [inputPath];
  const archiveRoot = path.resolve(archiveDir);
  const candidates = files.filter((file) => {
    const relative = path.relative(archiveRoot, path.resolve(file));
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  const results = [];
  for (const file of candidates) {
    try {
      results.push(await createChatArchive(file, archiveDir));
    } catch (error) {
      results.push({ sourceFile: path.basename(file), error: error.message });
    }
  }
  return results;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const next = argv[i + 1];
    args[item.slice(2)] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log("Usage: node scripts/chat-archive.mjs --input <json-file-or-directory> [--archives <directory>]");
    return;
  }
  const inputPath = path.resolve(args.input);
  const archiveDir = path.resolve(args.archives ?? "./outputs/archives");
  const results = await backfillChatArchives(inputPath, archiveDir);
  for (const result of results) {
    if (result.error) console.error(`Skipped ${result.sourceFile}: ${result.error}`);
    else console.log(`${result.title} — ${result.totalMessages} messages — ${result.file}`);
  }
  console.log(`Created ${results.filter((result) => !result.error).length} archive(s).`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
