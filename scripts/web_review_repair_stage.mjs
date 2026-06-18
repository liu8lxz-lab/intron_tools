#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function requireArg(args, key) {
  const value = String(args[key] || "").trim();
  if (!value) throw new Error(`Missing required argument: --${key}`);
  return value;
}

function stageJsonName(stage) {
  if (stage === "issue_list_cleaner") return "issue_list.json";
  if (stage === "adjudicator_parameters") return "conclusion_parameters.json";
  return `${stage}.json`;
}

function extractJson(source) {
  const value = String(source || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(value);
  } catch {
    // Continue to balanced extraction.
  }
  const start = value.indexOf("{");
  if (start < 0) throw new Error("No JSON object start found");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(value.slice(start, index + 1));
    }
  }
  throw new Error("No balanced JSON object found");
}

function validateStageObject(stage, obj) {
  if (stage === "adjudicator_parameters") {
    if (typeof obj?.overall_score !== "number") throw new Error("conclusion_parameters JSON missing overall_score");
  } else if (!Array.isArray(obj?.issues)) {
    throw new Error(`${stage} JSON missing issues array`);
  }
}

async function disconnect(browser) {
  try {
    const result = browser._connection?.close?.();
    if (result && typeof result.then === "function") await result;
  } catch {
    // Best-effort disconnect only; never close the user's Chrome process.
  }
}

async function main() {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
  process.env.NO_PROXY = "127.0.0.1,localhost,::1";

  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(requireArg(args, "run-dir"));
  const stage = requireArg(args, "stage");
  const conversationUrl = requireArg(args, "conversation-url");
  const endpoint = args["cdp-endpoint"] || "http://127.0.0.1:9222";
  const info = JSON.parse(execFileSync("/usr/bin/curl", ["--noproxy", "*", "-fsS", new URL("/json/version", endpoint).toString()], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  }));
  const browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl);
  try {
    const context = browser.contexts()[0];
    const page = context.pages().find((item) => item.url().startsWith("https://chatgpt.com")) || await context.newPage();
    if (page.url() !== conversationUrl) await page.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    const body = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
    if (/登录以获取|免费注册|Log in|Sign up|Sign in/i.test(body)) throw new Error("ChatGPT page appears logged out; user login required");

    const repairPrompt = [
      `请只修复并完整返回你上一条 ${stage} 输出的严格 JSON。`,
      "不要重新审稿，不要新增、删除、合并问题，不要改变问题级别、问题正文、建议或评分。",
      "上一条输出在本地 JSON 解析失败，原因是输出截断或格式不完整。",
      "请返回一个完整 JSON 对象；禁止 Markdown 代码块，禁止 JSON 之外任何文字。"
    ].join("\n");
    await page.evaluate(async (text) => navigator.clipboard.writeText(text), repairPrompt);
    const composer = page.locator("#prompt-textarea, [data-testid='composer-input'], [contenteditable='true'][data-placeholder], div[contenteditable='true'], textarea").last();
    await composer.click({ timeout: 20000 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => null);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
    await page.waitForTimeout(3000);
    const beforeAssistant = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
    await composer.click({ timeout: 10000 }).catch(() => null);
    await page.keyboard.press("Enter");

    let stable = 0;
    let lastLen = -1;
    let lastText = "";
    const started = Date.now();
    while (Date.now() - started < 20 * 60 * 1000) {
      const pageText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const count = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
      lastText = count ? await page.locator("[data-message-author-role='assistant']").last().innerText({ timeout: 5000 }).catch(() => "") : "";
      const busy = /正在思考|停止回答|Stop generating|Stop responding|停止生成/i.test(pageText);
      if (count > beforeAssistant && !busy && lastText.length > 100 && lastText.length === lastLen) stable += 1;
      else stable = 0;
      lastLen = lastText.length;
      if (stable >= 3) break;
      await page.waitForTimeout(5000);
    }

    let rawText = "";
    const copyButtons = page.locator("button[aria-label*='复制'], button[aria-label*='Copy'], button[data-testid*='copy']");
    const copyCount = await copyButtons.count().catch(() => 0);
    for (let index = copyCount - 1; index >= 0; index -= 1) {
      const button = copyButtons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click({ force: true, timeout: 10000 }).catch(() => null);
      await page.waitForTimeout(1000);
      rawText = await page.evaluate(async () => navigator.clipboard.readText()).catch(() => "");
      if (rawText.trim().startsWith("{")) break;
    }
    if (!rawText.trim().startsWith("{")) rawText = lastText;
    const obj = extractJson(rawText);
    validateStageObject(stage, obj);

    const rawDir = path.join(runDir, "raw");
    const jsonDir = path.join(runDir, "json");
    await fs.mkdir(rawDir, { recursive: true });
    await fs.mkdir(jsonDir, { recursive: true });
    const rawPath = path.join(rawDir, `${stage}.raw.txt`);
    const backupPath = path.join(rawDir, `${stage}.before_repair.raw.txt`);
    try {
      await fs.copyFile(rawPath, backupPath);
    } catch {
      // No prior raw file.
    }
    const jsonPath = path.join(jsonDir, stageJsonName(stage));
    await fs.writeFile(rawPath, rawText.trim() + "\n");
    await fs.writeFile(jsonPath, `${JSON.stringify(obj, null, 2)}\n`);

    const metadataPath = path.join(runDir, "runner_metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    const index = metadata.conversations.findIndex((item) => item.stage === stage);
    const patch = {
      stage,
      run_number: 1,
      status: "succeeded_after_format_repair",
      format_fix_count: 1,
      conversation_url: conversationUrl,
      raw_path: rawPath,
      json_path: jsonPath,
      extraction: {
        method: rawText === lastText ? "assistant-dom" : "copy-button-force-via-cdp",
        strict_json_valid: true,
        recovery: "same-conversation complete JSON repair after invalid or truncated output",
        semantic_change: false
      }
    };
    if (index >= 0) metadata.conversations[index] = { ...metadata.conversations[index], ...patch };
    else metadata.conversations.push(patch);
    metadata.format_repairs = Array.isArray(metadata.format_repairs) ? metadata.format_repairs : [];
    metadata.format_repairs.push({ stage, count: 1, type: "same_conversation_json_repair", semantic_change: false });
    metadata.notes = Array.isArray(metadata.notes) ? metadata.notes : [];
    metadata.notes.push({ time: new Date().toISOString(), stage, note: "Recovered complete strict JSON in the same conversation without semantic edits." });
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    console.log(JSON.stringify({ ok: true, stage, json_path: jsonPath, raw_path: rawPath }, null, 2));
  } finally {
    await disconnect(browser);
    process.exit(0);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
