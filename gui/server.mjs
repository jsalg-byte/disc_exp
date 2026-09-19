#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const port = Number.parseInt(process.env.PORT ?? process.env.GUI_PORT ?? "4173", 10);
const bindHost = process.env.HOST ?? "127.0.0.1";
const html = await fs.readFile(path.join(here, "index.html"), "utf8");

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

function runExport({ guildId, targetId, targetType, limit, includeBots, credentials }) {
  return new Promise((resolve) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join("outputs", "gui", `${targetType}-${targetId}-${stamp}.json`);
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
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, outputPath, message: stdout.trim() });
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

  if (request.method === "GET" && requestUrl.pathname === "/api/config") {
    const credentials = await loadCredentials();
    sendJson(response, 200, { guildId: credentials.DISCORD_GUILD_ID ?? "" });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/download") {
    const filename = requestUrl.searchParams.get("file") ?? "";
    if (!/^(channel|thread)-\d+-[\dTZ-]+\.json$/.test(filename)) {
      sendJson(response, 400, { error: "Invalid export file name." });
      return;
    }
    const filePath = path.join(projectDir, "outputs", "gui", filename);
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
    if (result.ok) {
      result.downloadUrl = `/api/download?file=${encodeURIComponent(path.basename(result.outputPath))}`;
    }
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
