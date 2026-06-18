#!/usr/bin/env node
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STAGES = [
  { key: "topic_innovation_rationale", title: "Agent 1 选题创新及合理性" },
  { key: "statistical_details", title: "Agent 2 统计学细节" },
  { key: "fulltext_consistency_numerical_audit", title: "Agent 3 全文一致性与数值审计结果" },
  { key: "figure_table_quality", title: "Agent 4 图表质量与呈现完整性" },
  { key: "misc_compliance_expression", title: "Agent 5 杂项与投稿安全表达" },
  { key: "issue_list_cleaner", title: "清洁员 Agent：问题清单整理" },
  { key: "adjudicator_parameters", title: "裁决者参数 Agent" }
];

const DEFAULT_PROMPTS = {
  topic_innovation_rationale: "你是 Agent 1：选题创新及合理性审稿人。请审查稿件的研究问题、选题发表价值、创新性、临床合理性、证据增量、研究定位、文献基础和结论外推是否适合投稿。",
  statistical_details: "你是 Agent 2：统计学细节审稿人。请审查统计方法、模型、样本量与事件数、混杂控制、亚组/敏感性分析和结果解释是否足以支撑主要结论。",
  fulltext_consistency_numerical_audit: "你是 Agent 3：全文一致性与数值审计审稿人。请核对摘要、正文、表格、图片、图注和补充材料之间的样本量、分母、百分比、P 值、效应值、CI、单位、变量名和结论表述是否一致。",
  figure_table_quality: "你是 Agent 4：图表质量与呈现完整性审稿人。请审查图表体系、图片本体可审阅性、图注表题、编号、图表工作量、可读性和 SCI 呈现风格。",
  misc_compliance_expression: "你是 Agent 5：杂项、投稿安全与表达审稿人。请审查伦理、知情同意、注册、声明区、版权授权、隐私、AI/模板残留、语言、缩写术语、参考文献和投稿安全风险。",
  issue_list_cleaner: "你是清洁员 Agent。请汇总前 5 个 Agent 的审稿报告，去重、清洗、编号和归类，生成问题清单.txt 和 issue_list JSON。不得重新审稿或新增前述 Agent 均未提出的问题。",
  adjudicator_parameters: "你是裁决者参数 Agent。请读取原始 Word 文稿和问题清单，只输出评分、风险等级、修订工作量、投稿建议、优先问题 ID、摘要、总体结论、页面级报告文本和六维诊断等结论参数。"
};

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
  const stageVersions = Array.isArray(versions) && versions.length
    ? versions
    : [
        {
          id: `default-${stage.key}`,
          stage: stage.key,
          title: stage.title,
          version: 1,
          status: "published",
          content: DEFAULT_PROMPTS[stage.key],
          createdAt: new Date().toISOString(),
          publishedAt: new Date().toISOString()
        }
      ];
  const published = stageVersions.filter((item) => item.status === "published");
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
  schema_version: "prompt_snapshot.v3",
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
