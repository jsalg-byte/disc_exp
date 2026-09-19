#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "any",
  "are",
  "been",
  "being",
  "but",
  "can",
  "cant",
  "did",
  "does",
  "dont",
  "for",
  "from",
  "had",
  "has",
  "have",
  "here",
  "how",
  "http",
  "https",
  "into",
  "its",
  "just",
  "more",
  "not",
  "our",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "those",
  "too",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

const STRATEGY_RULES = [
  {
    id: "creative-hooks",
    title: "Creative Hooks and UGC Format",
    terms: [
      "hook",
      "first 3 second",
      "3 second hook",
      "ugc",
      "pattern interrupt",
      "voiceover",
      "caption",
      "angle",
      "creative brief",
      "cta",
      "call to action",
      "retention",
    ],
    action:
      "Prioritize stronger first-3-second hooks and creator-style UGC variants before scaling spend.",
  },
  {
    id: "creative-testing",
    title: "Creative Testing and Iteration",
    terms: [
      "test",
      "testing",
      "split test",
      "a/b",
      "variant",
      "winner",
      "loser",
      "fatigue",
      "iterate",
      "iteration",
      "refresh creatives",
    ],
    action:
      "Run weekly creative test cycles with clear win/loss thresholds, then refresh fatigued winners quickly.",
  },
  {
    id: "media-buying",
    title: "Media Buying and Scaling",
    terms: [
      "campaign",
      "ad set",
      "budget",
      "spend",
      "scale",
      "scaling",
      "lookalike",
      "retarget",
      "broad",
      "cost cap",
      "bid",
      "frequency",
      "spark ads",
    ],
    action:
      "Keep a stable scaling framework (budget steps, retargeting layers, and bid controls) rather than ad-hoc edits.",
  },
  {
    id: "offer-conversion",
    title: "Offer, Landing Page, and Conversion",
    terms: [
      "offer",
      "landing page",
      "product page",
      "checkout",
      "bundle",
      "upsell",
      "discount",
      "conversion",
      "cvr",
      "aov",
      "funnel",
    ],
    action:
      "Treat offer and landing-page changes as first-class levers, not just ad creative optimizations.",
  },
  {
    id: "unit-economics",
    title: "Unit Economics and Profitability",
    terms: [
      "roas",
      "cpa",
      "cac",
      "cpm",
      "ctr",
      "ltv",
      "margin",
      "profit",
      "break even",
      "breakeven",
      "rpc",
      "revenue",
    ],
    action:
      "Anchor decision-making on profit metrics (CPA, margin, LTV) before increasing scale.",
  },
  {
    id: "client-monetization",
    title: "Creator and Agency Monetization",
    terms: [
      "client",
      "retainer",
      "affiliate",
      "commission",
      "revenue share",
      "revshare",
      "whitelisting",
      "creator payout",
      "package",
      "service fee",
    ],
    action:
      "Standardize monetization model by offer type (retainer, performance fee, or affiliate) and track payout risk.",
  },
  {
    id: "policy-risk",
    title: "Policy, Bans, and Compliance Risk",
    terms: [
      "ban",
      "banned",
      "policy",
      "disapproved",
      "appeal",
      "compliance",
      "restricted",
      "violation",
      "flagged",
      "account disabled",
    ],
    action:
      "Maintain compliance checks and backup assets/accounts to limit downtime from policy flags.",
  },
];

const MONETIZATION_TERMS = [
  "roas",
  "cpa",
  "cac",
  "cpm",
  "ctr",
  "ltv",
  "aov",
  "margin",
  "profit",
  "revenue",
  "payback",
  "breakeven",
  "break even",
];

function printHelp() {
  console.log(`synthesize-discord-export.mjs

Usage:
  node scripts/synthesize-discord-export.mjs --input <export.json> [options]

Options:
  --input <path>       Required JSON export path
  --out <path>         Output markdown report (default: ./outputs/discord-synthesis.md)
  --focus <mode>       "tiktok-ads" (default) or "generic"
  --help               Show this help
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

function toDateString(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function messageAuthor(message) {
  return (
    message?.author?.globalName ||
    message?.author?.username ||
    message?.author?.id ||
    "unknown"
  );
}

function cleanSnippet(text, maxLen = 160) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= maxLen) {
    return compact;
  }
  return `${compact.slice(0, maxLen - 1)}…`;
}

function extractKeywords(messages, limit = 20) {
  const counts = new Map();
  for (const message of messages) {
    const content = String(message.content ?? "").toLowerCase();
    const tokens = content.match(/[a-z][a-z0-9'-]{2,}/g) ?? [];
    for (const token of tokens) {
      if (STOP_WORDS.has(token)) {
        continue;
      }
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

function extractDomains(messages, limit = 10) {
  const domainCounts = new Map();
  for (const message of messages) {
    const text = String(message.content ?? "");
    const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
    for (const urlText of urls) {
      try {
        const domain = new URL(urlText).hostname.replace(/^www\./, "");
        domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      } catch {
        // Skip malformed URLs.
      }
    }
  }
  return [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain, count]) => ({ domain, count }));
}

function flattenMessages(channels) {
  const rows = [];
  for (const channel of channels) {
    for (const message of channel.messages ?? []) {
      rows.push({
        channelId: channel.id,
        channelName: channel.name ?? channel.id,
        timestamp: message.timestamp,
        author: messageAuthor(message),
        content: message.content ?? "",
        jumpUrl: message.jumpUrl ?? null,
      });
    }
  }
  return rows;
}

function normalizeText(text) {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function containsTerm(text, term) {
  const source = normalizeText(text);
  const target = term.toLowerCase();
  if (!source || !target) {
    return false;
  }
  return source.includes(target);
}

function analyzeStrategyCoverage(rows) {
  const byRule = STRATEGY_RULES.map((rule) => ({
    id: rule.id,
    title: rule.title,
    action: rule.action,
    mentions: 0,
    channels: new Set(),
    authors: new Set(),
    termHits: new Map(),
    examples: [],
  }));

  const byRuleId = new Map(byRule.map((rule) => [rule.id, rule]));

  for (const row of rows) {
    const text = normalizeText(row.content);
    if (!text) {
      continue;
    }

    for (const strategy of STRATEGY_RULES) {
      const hitTerms = strategy.terms.filter((term) => containsTerm(text, term));
      if (hitTerms.length === 0) {
        continue;
      }

      const bucket = byRuleId.get(strategy.id);
      bucket.mentions += 1;
      bucket.channels.add(row.channelName);
      bucket.authors.add(row.author);
      for (const term of hitTerms) {
        bucket.termHits.set(term, (bucket.termHits.get(term) ?? 0) + 1);
      }
      if (bucket.examples.length < 5) {
        bucket.examples.push({
          timestamp: row.timestamp,
          channelName: row.channelName,
          author: row.author,
          content: row.content,
          jumpUrl: row.jumpUrl,
        });
      }
    }
  }

  return byRule
    .map((entry) => ({
      ...entry,
      channelsCount: entry.channels.size,
      authorsCount: entry.authors.size,
      topTerms: [...entry.termHits.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([term, count]) => ({ term, count })),
    }))
    .sort((a, b) => b.mentions - a.mentions);
}

function analyzeMonetizationSignals(rows) {
  const mentionCounts = new Map();
  const mentionsByChannel = new Map();
  let messagesWithSignals = 0;

  for (const row of rows) {
    const text = normalizeText(row.content);
    if (!text) {
      continue;
    }

    let hasSignal = false;
    for (const term of MONETIZATION_TERMS) {
      if (containsTerm(text, term)) {
        mentionCounts.set(term, (mentionCounts.get(term) ?? 0) + 1);
        hasSignal = true;
      }
    }

    if (hasSignal) {
      messagesWithSignals += 1;
      mentionsByChannel.set(
        row.channelName,
        (mentionsByChannel.get(row.channelName) ?? 0) + 1,
      );
    }
  }

  const topMetrics = [...mentionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([metric, count]) => ({ metric, count }));

  const topChannels = [...mentionsByChannel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([channelName, count]) => ({ channelName, count }));

  return {
    messagesWithSignals,
    topMetrics,
    topChannels,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = args.input ? path.resolve(args.input) : null;
  if (!inputPath) {
    throw new Error("Missing --input <path>.");
  }

  const reportPath = path.resolve(args.out ?? "./outputs/discord-synthesis.md");
  const focus = args.focus ? String(args.focus).toLowerCase() : "tiktok-ads";
  const payloadRaw = await fs.readFile(inputPath, "utf8");
  const payload = JSON.parse(payloadRaw);

  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  const successfulChannels = channels.filter((channel) => !channel.error);
  const allMessages = flattenMessages(successfulChannels);

  const channelActivity = successfulChannels
    .map((channel) => ({
      id: channel.id,
      name: channel.name ?? channel.id,
      count: (channel.messages ?? []).length,
    }))
    .sort((a, b) => b.count - a.count);

  const authorCounts = new Map();
  for (const row of allMessages) {
    authorCounts.set(row.author, (authorCounts.get(row.author) ?? 0) + 1);
  }
  const topAuthors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([author, count]) => ({ author, count }));

  const timestamps = allMessages
    .map((row) => (row.timestamp ? Date.parse(row.timestamp) : NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  const timeStart = timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null;
  const timeEnd =
    timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null;

  const keywordList = extractKeywords(allMessages, 20);
  const domainList = extractDomains(allMessages, 10);

  const questionSamples = allMessages
    .filter((row) => row.content.includes("?"))
    .sort((a, b) => Date.parse(b.timestamp ?? 0) - Date.parse(a.timestamp ?? 0))
    .slice(0, 10);

  const recentHighlights = [...allMessages]
    .filter((row) => row.content.trim().length > 0)
    .sort((a, b) => Date.parse(b.timestamp ?? 0) - Date.parse(a.timestamp ?? 0))
    .slice(0, 14);

  const failedChannels = channels.filter((channel) => channel.error);
  const strategyCoverage = analyzeStrategyCoverage(allMessages);
  const topStrategies = strategyCoverage.filter((rule) => rule.mentions > 0).slice(0, 6);
  const monetization = analyzeMonetizationSignals(allMessages);

  const lines = [];
  lines.push("# Discord Server Synthesis");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source export: ${inputPath}`);
  lines.push(`Focus mode: ${focus}`);
  lines.push("");
  lines.push("## Snapshot");
  lines.push(
    `- Guild: ${payload.guild?.name ?? "unknown"} (${payload.guild?.id ?? "unknown"})`,
  );
  lines.push(`- Channels requested: ${payload.totals?.channelsRequested ?? channels.length}`);
  lines.push(`- Channels analyzed: ${successfulChannels.length}`);
  lines.push(`- Channels failed: ${failedChannels.length}`);
  lines.push(`- Total messages: ${allMessages.length}`);
  lines.push(`- Unique authors: ${authorCounts.size}`);
  lines.push(`- Time window start: ${timeStart ?? "n/a"}`);
  lines.push(`- Time window end: ${timeEnd ?? "n/a"}`);
  lines.push("");

  if (focus === "tiktok-ads") {
    lines.push("## Key Points");
    if (topStrategies.length === 0) {
      lines.push("- No clear TikTok ads strategy themes detected.");
    } else {
      for (const strategy of topStrategies.slice(0, 5)) {
        const leadingExample = strategy.examples[0];
        const snippet = leadingExample
          ? cleanSnippet(leadingExample.content, 140)
          : "No message excerpt available.";
        lines.push(
          `- ${strategy.title}: mentioned in ${strategy.mentions} messages across ${strategy.channelsCount} channels (${strategy.authorsCount} contributors). Example: "${snippet}"`,
        );
      }
    }
    lines.push("");

    lines.push("## Main Strategies Discussed");
    if (topStrategies.length === 0) {
      lines.push("- No strategy clusters identified from the current export.");
    } else {
      for (const strategy of topStrategies) {
        const termText =
          strategy.topTerms.length === 0
            ? "no dominant terms"
            : strategy.topTerms.map((term) => `${term.term} (${term.count})`).join(", ");
        lines.push(
          `- ${strategy.title}: ${strategy.mentions} mentions. Dominant terms: ${termText}.`,
        );
      }
    }
    lines.push("");

    lines.push("## Monetization Signals");
    lines.push(`- Messages with monetization metrics: ${monetization.messagesWithSignals}`);
    if (monetization.topMetrics.length === 0) {
      lines.push("- No strong monetization metric vocabulary detected.");
    } else {
      lines.push(
        `- Top metrics discussed: ${monetization.topMetrics
          .map((entry) => `${entry.metric} (${entry.count})`)
          .join(", ")}`,
      );
    }
    if (monetization.topChannels.length > 0) {
      lines.push(
        `- Channels with most monetization discussion: ${monetization.topChannels
          .map((entry) => `#${entry.channelName} (${entry.count})`)
          .join(", ")}`,
      );
    }
    lines.push("");

    lines.push("## Suggested Action Plan");
    if (topStrategies.length === 0) {
      lines.push("- Gather a larger message window or include more channels to derive a reliable action plan.");
    } else {
      for (const strategy of topStrategies.slice(0, 4)) {
        lines.push(`- ${strategy.action}`);
      }
    }
    lines.push("");
  }

  lines.push("## Most Active Channels");
  if (channelActivity.length === 0) {
    lines.push("- No channel data available.");
  } else {
    for (const item of channelActivity.slice(0, 12)) {
      lines.push(`- #${item.name}: ${item.count} messages`);
    }
  }
  lines.push("");

  lines.push("## Most Active Authors");
  if (topAuthors.length === 0) {
    lines.push("- No author data available.");
  } else {
    for (const item of topAuthors) {
      lines.push(`- ${item.author}: ${item.count} messages`);
    }
  }
  lines.push("");

  lines.push("## Recurring Keywords");
  if (keywordList.length === 0) {
    lines.push("- No keyword signal from message content.");
  } else {
    lines.push(
      `- ${keywordList.map((entry) => `${entry.word} (${entry.count})`).join(", ")}`,
    );
  }
  lines.push("");

  lines.push("## Shared Link Domains");
  if (domainList.length === 0) {
    lines.push("- No link domains detected.");
  } else {
    lines.push(`- ${domainList.map((entry) => `${entry.domain} (${entry.count})`).join(", ")}`);
  }
  lines.push("");

  lines.push("## Open Questions");
  if (questionSamples.length === 0) {
    lines.push("- No recent question messages found.");
  } else {
    for (const row of questionSamples) {
      const date = toDateString(row.timestamp) ?? "n/a";
      const snippet = cleanSnippet(row.content, 180);
      lines.push(`- [${date}] #${row.channelName} ${row.author}: ${snippet}`);
      if (row.jumpUrl) {
        lines.push(`  - ${row.jumpUrl}`);
      }
    }
  }
  lines.push("");

  lines.push("## Recent Highlights");
  if (recentHighlights.length === 0) {
    lines.push("- No recent highlights available.");
  } else {
    for (const row of recentHighlights) {
      const date = toDateString(row.timestamp) ?? "n/a";
      const snippet = cleanSnippet(row.content, 180);
      lines.push(`- [${date}] #${row.channelName} ${row.author}: ${snippet}`);
      if (row.jumpUrl) {
        lines.push(`  - ${row.jumpUrl}`);
      }
    }
  }
  lines.push("");

  if (failedChannels.length > 0) {
    lines.push("## Fetch Failures");
    for (const channel of failedChannels) {
      lines.push(`- ${channel.id} (${channel.name ?? "unknown"}): ${channel.error}`);
    }
    lines.push("");
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote synthesis report: ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
