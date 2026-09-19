/**
 * Discord DevTools Console Export Script
 *
 * Paste this entire script into Discord's DevTools console (Cmd+Shift+I > Console)
 * while viewing the server you want to export. It will:
 *   1. Detect the current guild
 *   2. Fetch messages from all accessible text channels
 *   3. Download a JSON file compatible with the synthesis pipeline
 *
 * Config (edit these before running):
 */
const EXPORT_CONFIG = {
  guildId: "1147171668721160194",  // hardcoded guild ID (set to null to auto-detect from current view)
  limitPerChannel: 500,   // max messages per channel
  days: 30,               // only last N days (0 = no limit)
  includeBots: false,     // include bot messages?
  delayMs: 400,           // delay between API calls (avoid rate limits)
};

(async () => {
  "use strict";

  // --- Grab token from Discord internals ---
  let token;
  try {
    const mods = [];
    webpackChunkdiscord_app.push([["__export__"], {}, (e) => {
      for (const c in e.c) mods.push(e.c[c]);
    }]);
    webpackChunkdiscord_app.pop();
    const tokenMod = mods.find((m) => m?.exports?.default?.getToken);
    token = tokenMod.exports.default.getToken();
  } catch {
    console.error("[Export] Could not extract token. Are you in the Discord desktop app?");
    return;
  }

  if (!token) {
    console.error("[Export] Token is empty.");
    return;
  }

  // --- Get guild ---
  let guildId = EXPORT_CONFIG.guildId;
  let guildName = null;
  try {
    const mods2 = [];
    webpackChunkdiscord_app.push([["__export2__"], {}, (e) => {
      for (const c in e.c) mods2.push(e.c[c]);
    }]);
    webpackChunkdiscord_app.pop();

    if (!guildId) {
      const selectedGuildMod = mods2.find(
        (m) => m?.exports?.default?.getLastSelectedGuildId
      );
      guildId = selectedGuildMod?.exports?.default?.getLastSelectedGuildId?.();
    }

    if (!guildId) {
      const match = location.href.match(/\/channels\/(\d+)\//);
      guildId = match?.[1];
    }

    const guildStoreMod = mods2.find((m) => m?.exports?.default?.getGuild);
    const guild = guildStoreMod?.exports?.default?.getGuild?.(guildId);
    guildName = guild?.name ?? null;
  } catch {
    console.error("[Export] Could not detect current guild.");
    return;
  }

  if (!guildId) {
    console.error("[Export] No guild ID configured and none detected. Set EXPORT_CONFIG.guildId or navigate to a server.");
    return;
  }

  console.log(`[Export] Starting export of "${guildName}" (${guildId})...`);

  const API = "https://discord.com/api/v10";
  const TEXT_TYPES = new Set([0, 5, 10, 11, 12]);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function apiGet(path) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(`${API}${path}`, {
        headers: { Authorization: token },
      });

      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const wait = Math.ceil((body.retry_after ?? 2) * 1000) + 200;
        console.warn(`[Export] Rate limited, waiting ${wait}ms...`);
        await sleep(wait);
        continue;
      }

      if (res.status >= 500) {
        await sleep((attempt + 1) * 800);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
      }

      return res.status === 204 ? null : await res.json();
    }
    throw new Error(`API failed repeatedly for ${path}`);
  }

  function normalizeMsg(raw) {
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
      attachments: (raw.attachments ?? []).map((a) => ({
        id: a.id, filename: a.filename, size: a.size,
        url: a.url, contentType: a.content_type ?? null,
      })),
      embeds: (raw.embeds ?? []).map((e) => ({
        type: e.type ?? null, title: e.title ?? null,
        description: e.description ?? null, url: e.url ?? null,
      })),
      reactions: (raw.reactions ?? []).map((r) => ({
        emoji: r.emoji?.name ?? r.emoji?.id ?? "unknown",
        count: r.count ?? 0,
      })),
      referencedMessageId: raw.message_reference?.message_id ?? null,
      jumpUrl: `https://discord.com/channels/${guildId}/${raw.channel_id}/${raw.id}`,
    };
  }

  // --- Fetch channels ---
  const channels = await apiGet(`/guilds/${guildId}/channels`);
  const textChannels = channels.filter((ch) => TEXT_TYPES.has(ch.type));
  console.log(`[Export] Found ${textChannels.length} text channels.`);

  const { limitPerChannel, days, includeBots, delayMs } = EXPORT_CONFIG;
  const minTs = days > 0 ? Date.now() - days * 86400000 : null;

  const outChannels = [];
  const authorCounts = new Map();
  let totalMessages = 0;

  for (let i = 0; i < textChannels.length; i++) {
    const ch = textChannels[i];
    console.log(`[Export] (${i + 1}/${textChannels.length}) #${ch.name}...`);

    try {
      const messages = [];
      let before = null;
      let done = false;

      while (messages.length < limitPerChannel && !done) {
        const pageSize = Math.min(100, limitPerChannel - messages.length);
        let url = `/channels/${ch.id}/messages?limit=${pageSize}`;
        if (before) url += `&before=${before}`;

        const page = await apiGet(url);
        if (!Array.isArray(page) || page.length === 0) break;

        for (const raw of page) {
          const ts = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
          if (minTs && Number.isFinite(ts) && ts < minTs) { done = true; continue; }
          if (!includeBots && raw.author?.bot) continue;
          messages.push(normalizeMsg(raw));
          if (messages.length >= limitPerChannel) break;
        }

        before = page[page.length - 1]?.id;
        if (!before) break;
        await sleep(delayMs);
      }

      for (const m of messages) {
        const key = m.author.globalName || m.author.username || m.author.id || "unknown";
        authorCounts.set(key, (authorCounts.get(key) ?? 0) + 1);
      }
      totalMessages += messages.length;

      outChannels.push({
        id: ch.id, name: ch.name ?? null, type: ch.type ?? null,
        topic: ch.topic ?? null, parentId: ch.parent_id ?? null,
        messageCount: messages.length, messages,
      });
    } catch (err) {
      console.warn(`[Export] Failed #${ch.name}: ${err.message}`);
      outChannels.push({
        id: ch.id, name: ch.name ?? null, type: ch.type ?? null,
        topic: ch.topic ?? null, parentId: ch.parent_id ?? null,
        messageCount: 0, messages: [], error: err.message,
      });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: "devtools-console",
    guild: { id: guildId, name: guildName },
    filters: { selectedChannelIds: [], limitPerChannel, includeBots, days: days || null },
    totals: {
      channelsRequested: textChannels.length,
      channelsSucceeded: outChannels.filter((c) => !c.error).length,
      channelsFailed: outChannels.filter((c) => c.error).length,
      totalMessages,
      uniqueAuthors: authorCounts.size,
    },
    channels: outChannels,
  };

  // --- Download ---
  const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (guildName ?? guildId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  a.href = url;
  a.download = `discord-export-${safeName}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);

  console.log(`[Export] Done! ${totalMessages} messages from ${outChannels.length} channels downloaded.`);
})();
