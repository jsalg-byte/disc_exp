#!/usr/bin/env node

/**
 * AI-powered synthesis of Discord export data.
 *
 * Feeds messages to Gemini CLI and extracts actionable money-making
 * strategies, tactics, and insights from real conversations.
 *
 * Usage:
 *   node scripts/synthesize-ai.mjs --input outputs/discord-export.json --out outputs/synthesis.md
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function runGemini(prompt, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gemini",
      ["-p", prompt],
      {
        maxBuffer: 1024 * 1024 * 10,
        timeout: 180_000,
        env: { ...process.env },
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Gemini failed: ${err.message}\n${stderr}`));
        resolve(stdout.trim());
      },
    );
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function prepareMessages(exportData) {
  const channels = Array.isArray(exportData.channels) ? exportData.channels : [];
  const rows = [];

  for (const ch of channels) {
    if (ch.error) continue;
    for (const msg of ch.messages ?? []) {
      const content = (msg.content ?? "").trim();
      if (content.length < 15) continue;
      if (msg.author?.bot) continue;

      const author = msg.author?.globalName || msg.author?.username || "anon";
      const date = msg.timestamp ? msg.timestamp.slice(0, 10) : "";
      const channel = ch.name ?? ch.id;

      rows.push({ date, channel, author, content });
    }
  }

  // Sort by date descending
  rows.sort((a, b) => (b.date > a.date ? 1 : -1));
  return rows;
}

function formatForLLM(rows) {
  return rows.map((r) => `[${r.date}] #${r.channel} | ${r.author}: ${r.content}`).join("\n");
}

// Split into chunks if needed (by char count)
function chunkText(text, maxChars = 120_000) {
  if (text.length <= maxChars) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

const EXTRACT_PROMPT = `You are an analyst reading Discord messages from a TikTok ad creator community. Your job is to extract ACTIONABLE money-making intelligence for someone who wants to earn money with TikTok ads/content.

Read the messages provided on stdin and extract:

## 1. MONEY-MAKING METHODS
List every distinct method/strategy people mention for making money. For each:
- What the method is (be specific)
- How it works step by step (as much as can be inferred)
- Who mentioned it or does it successfully
- Any numbers mentioned (earnings, costs, timeframes)
- Difficulty/barrier to entry

## 2. WHAT'S WORKING RIGHT NOW
Specific tactics, tools, offers, or approaches people say are currently working. Include context and any specifics shared.

## 3. EARNINGS & BENCHMARKS
Any concrete numbers people share — monthly earnings, per-video rates, CPAs, ROAS, deal sizes, etc. Attribute to the person who shared them.

## 4. TOOLS, PLATFORMS & RESOURCES
Any tools, platforms, software, services, or resources mentioned that help make money.

## 5. MISTAKES & WARNINGS
Things people say to avoid, common mistakes, ban risks, scams, or pitfalls mentioned.

## 6. STEP-BY-STEP PLAYBOOKS
If enough info exists to construct a playbook for any method, write it as a numbered step-by-step guide a beginner could follow.

## 7. KEY PEOPLE TO FOLLOW
People who seem most knowledgeable or successful based on what they share. Note what they specialize in.

## 8. UNANSWERED QUESTIONS & GAPS
Important questions people asked that went unanswered, or areas where more info would be valuable.

Rules:
- Be extremely specific. No vague advice. Quote actual numbers, names, and details from the messages.
- If someone shares a real anecdote about making money, include it with full context.
- Organize by actionability — the reader should be able to act on this immediately.
- Skip generic chat, greetings, off-topic messages. Only extract money-relevant intelligence.
- If a message is ambiguous, include it with a note about what's unclear.
- Use markdown formatting with headers, bullets, and bold for key info.`;

const REFINE_PROMPT = `You are refining a synthesis of money-making strategies from a TikTok ad creator Discord community.

You have partial extractions from multiple chunks of messages. Combine, deduplicate, and refine them into a single cohesive document.

Prioritize:
1. Specificity — real numbers, real names, real tactics
2. Actionability — a reader should know exactly what to do
3. Recency — newer info takes precedence
4. Credibility — info from people with demonstrated results > speculation

Keep the same section structure. Remove any fluff or repetition. Add a TL;DR at the top with the 5 most actionable takeaways.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log("Usage: node scripts/synthesize-ai.mjs --input <export.json> [--out <output.md>]");
    return;
  }

  const inputPath = args.input ? path.resolve(args.input) : null;
  if (!inputPath) throw new Error("Missing --input <path>");

  const outPath = path.resolve(args.out ?? "./outputs/ai-synthesis.md");
  const raw = await fs.readFile(inputPath, "utf8");
  const data = JSON.parse(raw);

  console.log("Preparing messages...");
  const rows = prepareMessages(data);
  console.log(`Found ${rows.length} substantive messages.`);

  const fullText = formatForLLM(rows);
  const chunks = chunkText(fullText, 120_000);
  console.log(`Split into ${chunks.length} chunk(s) for analysis.`);

  const extractions = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`Analyzing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
    const result = await runGemini(EXTRACT_PROMPT, chunks[i]);
    extractions.push(result);
  }

  let finalReport;

  if (extractions.length === 1) {
    finalReport = extractions[0];
  } else {
    console.log("Combining and refining extractions...");
    const combined = extractions.map((e, i) => `--- CHUNK ${i + 1} ---\n${e}`).join("\n\n");
    finalReport = await runGemini(REFINE_PROMPT, combined);
  }

  // Add header
  const header = [
    "# TikTok Ad Creator Discord — Money-Making Intelligence",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Source: ${data.guild?.name ?? "unknown"} (${data.guild?.id ?? "unknown"})`,
    `Messages analyzed: ${rows.length}`,
    `Time window: ${rows[rows.length - 1]?.date ?? "?"} to ${rows[0]?.date ?? "?"}`,
    "",
    "---",
    "",
  ].join("\n");

  const report = header + finalReport + "\n";

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, report, "utf8");
  console.log(`\nDone! Report at: ${outPath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
