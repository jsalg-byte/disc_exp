/*
 * Vencord Plugin: Server Export
 *
 * Exports messages from the current guild's channels to a JSON file
 * compatible with the discord-server-synth synthesis pipeline.
 *
 * Installation:
 *   1. Copy this file to your Vencord userplugins directory:
 *        ~/.config/Vencord/src/userplugins/serverExport.ts
 *      (on macOS: ~/Library/Application Support/Vencord/src/userplugins/serverExport.ts)
 *      OR if using Vencord from source:
 *        /path/to/Vencord/src/userplugins/serverExport/index.ts
 *   2. Rebuild Vencord (pnpm build) or let it hot-reload.
 *   3. Enable "ServerExport" in Vencord settings.
 *   4. Open any server, run the slash command /export-server or use the toolbar button.
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, GuildStore, MessageStore, UserStore } from "@webpack/common";
import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

const RestAPI = findByPropsLazy("getAPIBaseURL");
const MessageFetcher = findByPropsLazy("fetchMessages", "getMessages");

interface ExportChannel {
    id: string;
    name: string | null;
    type: number | null;
    topic: string | null;
    parentId: string | null;
    messageCount: number;
    messages: ExportMessage[];
    error?: string;
}

interface ExportMessage {
    id: string;
    channelId: string | null;
    timestamp: string | null;
    editedTimestamp: string | null;
    type: number;
    content: string;
    author: {
        id: string | null;
        username: string | null;
        globalName: string | null;
        bot: boolean;
    };
    attachments: Array<{
        id: string;
        filename: string;
        size: number;
        url: string;
        contentType: string | null;
    }>;
    embeds: Array<{
        type: string | null;
        title: string | null;
        description: string | null;
        url: string | null;
    }>;
    reactions: Array<{
        emoji: string;
        count: number;
    }>;
    referencedMessageId: string | null;
    jumpUrl: string | null;
}

const MESSAGE_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

const settings = definePluginSettings({
    limitPerChannel: {
        type: OptionType.NUMBER,
        description: "Max messages to fetch per channel",
        default: 250,
    },
    days: {
        type: OptionType.NUMBER,
        description: "Only include messages from last N days (0 = no limit)",
        default: 30,
    },
    includeBots: {
        type: OptionType.BOOLEAN,
        description: "Include bot messages in export",
        default: false,
    },
});

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeMessage(raw: any, guildId: string): ExportMessage {
    return {
        id: raw.id,
        channelId: raw.channel_id ?? null,
        timestamp: raw.timestamp ?? null,
        editedTimestamp: raw.edited_timestamp ?? raw.editedTimestamp ?? null,
        type: raw.type ?? 0,
        content: raw.content ?? "",
        author: {
            id: raw.author?.id ?? null,
            username: raw.author?.username ?? null,
            globalName: raw.author?.globalName ?? raw.author?.global_name ?? null,
            bot: Boolean(raw.author?.bot),
        },
        attachments: (raw.attachments ?? []).map((a: any) => ({
            id: a.id,
            filename: a.filename,
            size: a.size,
            url: a.url,
            contentType: a.content_type ?? a.contentType ?? null,
        })),
        embeds: (raw.embeds ?? []).map((e: any) => ({
            type: e.type ?? null,
            title: e.title ?? null,
            description: e.description ?? null,
            url: e.url ?? null,
        })),
        reactions: (raw.reactions ?? []).map((r: any) => ({
            emoji: r.emoji?.name ?? r.emoji?.id ?? "unknown",
            count: r.count ?? 0,
        })),
        referencedMessageId: raw.messageReference?.message_id ?? raw.message_reference?.message_id ?? null,
        jumpUrl: `https://discord.com/channels/${guildId}/${raw.channel_id}/${raw.id}`,
    };
}

async function fetchChannelMessagesViaAPI(
    channelId: string,
    guildId: string,
    limit: number,
    includeBots: boolean,
    minTimestampMs: number | null,
): Promise<ExportMessage[]> {
    const messages: ExportMessage[] = [];
    let before: string | null = null;
    let reachedDateFloor = false;

    while (messages.length < limit) {
        const pageLimit = Math.min(100, limit - messages.length);
        let endpoint = `/channels/${channelId}/messages?limit=${pageLimit}`;
        if (before) {
            endpoint += `&before=${before}`;
        }

        let page: any[];
        try {
            const resp = await RestAPI.get({ url: endpoint });
            page = resp?.body ?? [];
        } catch (err: any) {
            if (err?.status === 429) {
                const retryMs = Math.ceil((err?.body?.retry_after ?? 1) * 1000) + 200;
                await sleep(retryMs);
                continue;
            }
            throw err;
        }

        if (!Array.isArray(page) || page.length === 0) break;

        for (const raw of page) {
            const ts = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
            if (minTimestampMs !== null && Number.isFinite(ts) && ts < minTimestampMs) {
                reachedDateFloor = true;
                continue;
            }
            if (!includeBots && raw.author?.bot) continue;
            messages.push(normalizeMessage(raw, guildId));
            if (messages.length >= limit) break;
        }

        before = page[page.length - 1]?.id ?? null;
        if (!before || reachedDateFloor) break;

        // small delay to avoid rate-limits
        await sleep(350);
    }

    return messages;
}

function downloadJSON(data: object, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

async function exportCurrentGuild() {
    const { limitPerChannel, days, includeBots } = settings.store;
    const minTimestampMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

    // Get current guild from selected channel
    const selectedChannelId = ChannelStore.getChannelId();
    const selectedChannel = ChannelStore.getChannel(selectedChannelId);
    if (!selectedChannel?.guild_id) {
        BdApi?.showToast?.("No server selected. Navigate to a server first.", { type: "error" });
        console.error("[ServerExport] No guild selected.");
        return;
    }

    const guildId = selectedChannel.guild_id;
    const guild = GuildStore.getGuild(guildId);
    const guildName = guild?.name ?? null;

    // Get all text channels in the guild
    const allChannels = Object.values(ChannelStore.getMutableGuildChannelsForGuild(guildId)) as any[];
    const textChannels = allChannels.filter((ch: any) => MESSAGE_CHANNEL_TYPES.has(ch.type));

    console.log(`[ServerExport] Exporting ${textChannels.length} channels from "${guildName}" (${guildId})`);

    const outChannels: ExportChannel[] = [];
    const authorCounts = new Map<string, number>();
    let totalMessages = 0;

    for (let i = 0; i < textChannels.length; i++) {
        const channel = textChannels[i];
        console.log(`[ServerExport] (${i + 1}/${textChannels.length}) #${channel.name}`);

        try {
            const messages = await fetchChannelMessagesViaAPI(
                channel.id,
                guildId,
                limitPerChannel,
                includeBots,
                minTimestampMs,
            );

            for (const msg of messages) {
                const key = msg.author.globalName || msg.author.username || msg.author.id || "unknown";
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
        } catch (err: any) {
            console.warn(`[ServerExport] Failed channel #${channel.name}: ${err.message}`);
            outChannels.push({
                id: channel.id,
                name: channel.name ?? null,
                type: channel.type ?? null,
                topic: channel.topic ?? null,
                parentId: channel.parent_id ?? null,
                messageCount: 0,
                messages: [],
                error: err.message,
            });
        }
    }

    const output = {
        generatedAt: new Date().toISOString(),
        source: "vencord-plugin",
        guild: { id: guildId, name: guildName },
        filters: {
            selectedChannelIds: [],
            limitPerChannel,
            includeBots,
            days: days > 0 ? days : null,
        },
        totals: {
            channelsRequested: textChannels.length,
            channelsSucceeded: outChannels.filter(c => !c.error).length,
            channelsFailed: outChannels.filter(c => c.error).length,
            totalMessages,
            uniqueAuthors: authorCounts.size,
        },
        channels: outChannels,
    };

    const safeName = (guildName ?? guildId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const filename = `discord-export-${safeName}-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJSON(output, filename);
    console.log(`[ServerExport] Done! ${totalMessages} messages from ${outChannels.length} channels.`);
}

export default definePlugin({
    name: "ServerExport",
    description: "Export current server's messages to JSON for the discord-server-synth pipeline",
    authors: [Devs.Ven],
    settings,

    commands: [
        {
            name: "export-server",
            description: "Export all accessible channels from the current server to JSON",
            execute: async () => {
                await exportCurrentGuild();
                return { content: "Export started - check your downloads folder." };
            },
        },
    ],

    toolboxActions: {
        "Export Server": exportCurrentGuild,
    },
});
