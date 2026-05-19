#!/usr/bin/env node
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STAGES = [
  { key: "global_system", title: "全局系统提示词" },
  { key: "selection_innovation", title: "选题创新预审" },
  { key: "clinical_methods", title: "临床方法预审" },
  { key: "statistical_results", title: "统计结果预审" },
  { key: "numerical_audit", title: "数值审计预审" },
  { key: "figure_table_visual_audit", title: "图表与视觉材料审计" },
  { key: "submission_safety_expression", title: "投稿安全与表达预审" },
  { key: "consistency_comparator", title: "通用一致性比较器" },
  { key: "adjudicator_review", title: "裁决者裁定" },
  { key: "final_adjudication", title: "终稿输出" }
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function requireString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(requireString(args["project-root"], "--project-root"));
const dbPath = path.join(projectRoot, ".data", "db.json");
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(skillRoot, "references", "prompts.json");
const adapterModule = await import(pathToFileURL(path.join(projectRoot, "src", "promptAdapters.js")).href);
const { buildEffectivePrompt, getPromptAdapterMetadata, PROMPT_ADAPTER_VERSION } = adapterModule;

const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
const exported = {};

function hashPromptContent(content) {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

for (const stage of STAGES) {
  const versions = db.prompts?.[stage.key];
  if (!Array.isArray(versions)) {
    throw new Error(`Missing prompt stage: ${stage.key}`);
  }
  const published = versions.filter((item) => item.status === "published");
  if (published.length !== 1) {
    throw new Error(`Expected exactly one published prompt for ${stage.key}, got ${published.length}`);
  }
  const prompt = published[0];
  const rawContent = String(prompt.content || "");
  const content = buildEffectivePrompt(stage.key, rawContent);
  const adapter = getPromptAdapterMetadata(stage.key);
  const effectiveContentHash = hashPromptContent(content);
  exported[stage.key] = {
    key: stage.key,
    title: prompt.title || stage.title,
    id: prompt.id,
    version: prompt.version,
    status: prompt.status,
    content,
    contentHash: effectiveContentHash,
    rawContentHash: hashPromptContent(rawContent),
    rawContentLength: rawContent.length,
    adapterVersion: adapter.version,
    adapterHash: adapter.contentHash,
    adapterLength: adapter.contentLength,
    effectiveContentHash,
    effectiveContentLength: content.length
  };
  if (!exported[stage.key].content.trim()) {
    throw new Error(`Published prompt is empty: ${stage.key}`);
  }
}

const snapshot = {
  exportedAt: new Date().toISOString(),
  sourceProjectRoot: projectRoot,
  schema_version: "prompt_snapshot.v2",
  adapterVersion: PROMPT_ADAPTER_VERSION,
  stages: STAGES,
  prompts: exported
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

for (const stage of STAGES) {
  const prompt = exported[stage.key];
  console.log(`${stage.key}\tv${prompt.version}\t${prompt.id}`);
}
console.log(`Wrote ${outputPath}`);
