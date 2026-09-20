#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createChatArchive } from "./chat-archive.mjs";

const API_BASE = "https://discord.com/api/v10";
const MESSAGE_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

function printHelp() {
  console.log(`export-discord-server.mjs

Usage:
  node scripts/export-discord-server.mjs [options]

Options:
  --guild-id <id>          Discord guild/server id (or DISCORD_GUILD_ID)
  --token <token>          Bot token (or DISCORD_BOT_TOKEN / DISCORD_TOKEN)
  --user-token             Treat the token as a user token (no "Bot" prefix)
  --channels <id,id,...>   Optional channel allow-list
  --threads <id,id,...>    Optional thread allow-list (mutually exclusive with --channels)
  --limit <n>              Max messages per channel or thread (default: 250)
  --days <n>               Keep only messages from the last n days
  --after <YYYY-MM-DD>     Only include messages after this date
  --before <YYYY-MM-DD>    Only include messages before this date
  --include-bots           Include bot-authored messages
  --out <path>             Output JSON file (default: ./outputs/discord-export.json)
  --help                   Show this help
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function asPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received "${value}".`);
  }
  return parsed;
}

function splitCsv(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function discordRequest(pathname, token, isUserToken = false) {
  const url = `${API_BASE}${pathname}`;
  let attempt = 0;
  while (attempt < 7) {
    attempt += 1;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: isUserToken ? token : `Bot ${token}`,
      },
    });

    if (response.status === 429) {
      const payload = await safeJson(response);
      const retryMs = Math.ceil((payload?.retry_after ?? 1) * 1000) + 100;
      await sleep(retryMs);
      continue;
    }

    if (response.status >= 500 && response.status < 600) {
      await sleep(attempt * 600);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(
        `Discord API ${response.status} on ${pathname}: ${text.slice(0, 240)}`,
      );
      error.status = response.status;
      throw error;
    }

    if (response.status === 204) {
      return null;
    }
    return safeJson(response);
  }
  throw new Error(`Discord API failed repeatedly for ${pathname}.`);
}

function normalizeMessage(raw) {
  return {
    id: raw.id,
    channelId: raw.channel_id ?? null,
    timestamp: raw.timestamp ?? null,
    editedTimestamp: raw.edited_timestamp ?? null,
    type: raw.type,
    content: raw.content ?? "",
    author: {
      id: raw.author?.id ?? null,
      username: raw.author?.username ?? null,
      globalName: raw.author?.global_name ?? null,
      bot: Boolean(raw.author?.bot),
    },
    attachments: (raw.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      size: attachment.size,
      url: attachment.url,
      proxyUrl: attachment.proxy_url ?? null,
      contentType: attachment.content_type ?? null,
    })),
    embeds: (raw.embeds ?? []).map((embed) => ({
      type: embed.type ?? null,
      title: embed.title ?? null,
      description: embed.description ?? null,
      url: embed.url ?? null,
      imageUrl: embed.image?.proxy_url ?? embed.image?.url ?? null,
      thumbnailUrl: embed.thumbnail?.proxy_url ?? embed.thumbnail?.url ?? null,
      videoUrl: embed.video?.url ?? null,
    })),
    reactions: (raw.reactions ?? []).map((reaction) => ({
      emoji: reaction.emoji?.name ?? reaction.emoji?.id ?? "unknown",
      count: reaction.count ?? 0,
    })),
    referencedMessageId: raw.message_reference?.message_id ?? null,
    jumpUrl: raw.guild_id
      ? `https://discord.com/channels/${raw.guild_id}/${raw.channel_id}/${raw.id}`
      : null,
  };
}

async function fetchChannelMessages({
  token,
  isUserToken,
  channelId,
  limit,
  includeBots,
  minTimestampMs,
  maxTimestampMs,
}) {
  const messages = [];
  let before = null;

  // If we have a maxTimestampMs (--before), convert to a Discord snowflake to start pagination there
  if (maxTimestampMs) {
    // Discord epoch is 1420070400000
    const snowflake = BigInt(maxTimestampMs - 1420070400000) << 22n;
    before = snowflake.toString();
  }

  let reachedDateFloor = false;

  while (messages.length < limit) {
    const pageLimit = Math.min(100, limit - messages.length);
    let endpoint = `/channels/${channelId}/messages?limit=${pageLimit}`;
    if (before) {
      endpoint += `&before=${before}`;
    }

    const page = await discordRequest(endpoint, token, isUserToken);
    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    for (const raw of page) {
      const timestamp = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
      if (Number.isFinite(minTimestampMs) && Number.isFinite(timestamp) && timestamp < minTimestampMs) {
        reachedDateFloor = true;
        continue;
      }
      if (!includeBots && raw.author?.bot) {
        continue;
      }

      messages.push(normalizeMessage(raw));
      if (messages.length >= limit) {
        break;
      }
    }

    before = page[page.length - 1]?.id ?? null;
    if (!before || reachedDateFloor) {
      break;
    }
  }

  return messages;
}

function authorLabel(message) {
  return (
    message.author?.globalName ||
    message.author?.username ||
    message.author?.id ||
    "unknown"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const guildId = args["guild-id"] ?? process.env.DISCORD_GUILD_ID;
  const isUserToken = Boolean(args["user-token"]) || Boolean(process.env.DISCORD_USER_TOKEN);
  const token =
    args.token ??
    (isUserToken ? process.env.DISCORD_USER_TOKEN : null) ??
    process.env.DISCORD_TOKEN ??
    process.env.DISCORD_BOT_TOKEN;

  if (!guildId) {
    throw new Error("Missing guild id. Set --guild-id or DISCORD_GUILD_ID.");
  }
  if (!token) {
    throw new Error(
      isUserToken
        ? "Missing user token. Set --token or DISCORD_USER_TOKEN."
        : "Missing bot token. Set --token or DISCORD_BOT_TOKEN.",
    );
  }

  const limit = asPositiveInt(args.limit, 250);
  const days = args.days === undefined ? null : asPositiveInt(args.days, null);

  let minTimestampMs = days === null ? null : Date.now() - days * 24 * 60 * 60 * 1000;
  let maxTimestampMs = null;

  if (args.after) {
    const parsed = Date.parse(args.after);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid --after date: "${args.after}"`);
    minTimestampMs = parsed;
  }
  if (args.before) {
    const parsed = Date.parse(args.before);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid --before date: "${args.before}"`);
    maxTimestampMs = parsed;
  }

  const includeBots = Boolean(args["include-bots"]);
  const selectedChannelIds = splitCsv(args.channels);
  const selectedThreadIds = splitCsv(args.threads);
  if (selectedChannelIds.length > 0 && selectedThreadIds.length > 0) {
    throw new Error("Use either --channels or --threads, not both.");
  }
  const outputPath = path.resolve(args.out ?? "./outputs/discord-export.json");

  let guildName = null;
  try {
    const guild = await discordRequest(`/guilds/${guildId}`, token, isUserToken);
    guildName = guild?.name ?? null;
  } catch {
    guildName = null;
  }

  let targets;
  if (selectedThreadIds.length > 0) {
    targets = await Promise.all(selectedThreadIds.map(async (id) => {
      const thread = await discordRequest(`/channels/${id}`, token, isUserToken);
      if (!thread || ![10, 11, 12].includes(thread.type)) {
        throw new Error(`ID ${id} is not a thread visible to this account.`);
      }
      if (thread.guild_id && thread.guild_id !== guildId) {
        throw new Error(`Thread ${id} belongs to a different server than --guild-id.`);
      }
      return thread;
    }));
  } else {
    const channels = await discordRequest(`/guilds/${guildId}/channels`, token, isUserToken);
    if (!Array.isArray(channels)) {
      throw new Error("Unable to load guild channels.");
    }

    const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
    const eligibleChannels = channels.filter((channel) =>
      MESSAGE_CHANNEL_TYPES.has(channel.type),
    );

    targets = selectedChannelIds.length > 0
      ? selectedChannelIds.map((id) => channelsById.get(id) ?? { id, name: `unknown-${id}`, type: null })
      : eligibleChannels;
  }

  const outChannels = [];
  const authorCounts = new Map();
  let totalMessages = 0;

  for (const channel of targets) {
    try {
      const messages = await fetchChannelMessages({
        token,
        isUserToken,
        channelId: channel.id,
        limit,
        includeBots,
        minTimestampMs,
        maxTimestampMs,
      });
      for (const message of messages) {
        const key = authorLabel(message);
        authorCounts.set(key, (authorCounts.get(key) ?? 0) + 1);
      }
      totalMessages += messages.length;
      outChannels.push({
        id: channel.id,
        name: channel.name ?? null,
        type: channel.type ?? null,
        topic: channel.topic ?? null,
        parentId: channel.parent_id ?? null,
        messageCount: messages.length,
        messages,
      });
    } catch (error) {
      outChannels.push({
        id: channel.id,
        name: channel.name ?? null,
        type: channel.type ?? null,
        topic: channel.topic ?? null,
        parentId: channel.parent_id ?? null,
        messageCount: 0,
        messages: [],
        error: error.message,
      });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: isUserToken ? "discord-rest-v10-user" : "discord-rest-v10-bot",
    guild: {
      id: guildId,
      name: guildName,
    },
    filters: {
      selectedChannelIds,
      selectedThreadIds,
      targetType: selectedThreadIds.length > 0 ? "thread" : "channel",
      limitPerChannel: limit,
      includeBots,
      days,
    },
    totals: {
      targetsRequested: targets.length,
      targetType: selectedThreadIds.length > 0 ? "thread" : "channel",
      channelsRequested: targets.length,
      channelsSucceeded: outChannels.filter((channel) => !channel.error).length,
      channelsFailed: outChannels.filter((channel) => channel.error).length,
      totalMessages,
      uniqueAuthors: authorCounts.size,
    },
    channels: outChannels,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote Discord export: ${outputPath}`);
  const dataDir = path.resolve(process.env.EXPORT_DATA_DIR ?? "./outputs");
  const archive = await createChatArchive(outputPath, path.join(dataDir, "archives"));
  console.log(`CHAT_ARCHIVE ${JSON.stringify(archive)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
