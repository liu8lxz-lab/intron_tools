#!/usr/bin/env node
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_MANUSCRIPT_CHARS = 120_000;
const WEB_IMAGE_SEQUENCE_LIMIT = 12;
const WEB_QUALITY_FLAG_LIMIT = 12;
const REVIEW_STAGES = [
  { key: "topic_innovation_rationale", title: "Agent 1 选题创新及合理性" },
  { key: "statistical_details", title: "Agent 2 统计学细节" },
  { key: "fulltext_consistency_numerical_audit", title: "Agent 3 全文一致性与数值审计结果" },
  { key: "figure_table_quality", title: "Agent 4 图表质量与呈现完整性" },
  { key: "misc_compliance_expression", title: "Agent 5 杂项与投稿安全表达" }
];
const CLEANER_STAGE_KEY = "issue_list_cleaner";
const ADJUDICATOR_STAGE_KEY = "adjudicator_parameters";
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

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

function requireString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function truncateChars(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[材料因长度限制已截断，原始解析长度 ${value.length} 字符。]`;
}

function buildBaseTaskInfo(task) {
  return [
    `任务 ID：${task.id}`,
    `原始文件名：${task.originalFilename}`,
    `上传时间：${task.createdAt}`,
    `客户信息：${task.customerInfo || "未填写"}`
  ].join("\n");
}

function imageReviewChecklistText(artifactManifest) {
  const sequence = Array.isArray(artifactManifest?.image_sequence) ? artifactManifest.image_sequence : [];
  if (!sequence.length) {
    return "未检测到可按 Word 主文档顺序提取的图片 occurrence。若正文、Figure legends 或 caption 显示应有图片，Agent 4 必须将其作为图表材料缺失风险处理。";
  }
  return sequence
    .map((image) => [
      `${image.image_id}｜document_order=${image.document_order}`,
      `extracted_path: ${image.extracted_path || "未提取"}`,
      `size: ${image.width || "?"}x${image.height || "?"}`,
      `inferred_label: ${image.inferred_label || "无明确 Figure label"}`,
      `label_confidence: ${image.label_confidence || "none"}`,
      `review_status: ${image.review_status || "unknown"}`,
      image.caption_text ? `caption_text: ${image.caption_text}` : "",
      image.nearby_text_before ? `nearby_text_before: ${image.nearby_text_before}` : "",
      image.nearby_text_after ? `nearby_text_after: ${image.nearby_text_after}` : ""
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function artifactSummaryForWebPrompt(artifactManifest) {
  const manifest = artifactManifest || {};
  const counts = manifest.counts || {};
  const sequence = Array.isArray(manifest.image_sequence) ? manifest.image_sequence : [];
  const flags = Array.isArray(manifest.quality_flags) ? manifest.quality_flags : [];
  const captions = manifest.captions || {};
  const captionCounts = {
    figure_captions: Array.isArray(captions.figures) ? captions.figures.length : counts.figure_captions || counts.figure_caption_like || 0,
    table_captions: Array.isArray(captions.tables) ? captions.tables.length : counts.table_captions || 0
  };
  return {
    file_type: manifest.file_type || path.extname(manifest.file_name || "").replace(/^\./, "") || "unknown",
    extraction_status: manifest.extraction_status || manifest.image_extraction_status || "unknown",
    parsed_images: manifest.image_count ?? counts.images ?? counts.image_occurrences ?? sequence.length ?? 0,
    parsed_tables: manifest.table_count ?? counts.tables ?? 0,
    parsed_figure_captions: captionCounts.figure_captions,
    parsed_table_captions: captionCounts.table_captions,
    extracted_images_dir: manifest.extracted_images_dir || "",
    quality_flags: flags.slice(0, WEB_QUALITY_FLAG_LIMIT).map((item) => ({
      level: item.level || "",
      code: item.code || "",
      message: item.message || String(item || "")
    })),
    image_sequence: sequence.slice(0, WEB_IMAGE_SEQUENCE_LIMIT).map((image) => ({
      image_id: image.image_id || "",
      document_order: image.document_order ?? "",
      extracted_path: image.extracted_path || "",
      inferred_label: image.inferred_label || "",
      label_confidence: image.label_confidence || "",
      review_status: image.review_status || "",
      caption_text: image.caption_text || ""
    })),
    image_sequence_truncated: sequence.length > WEB_IMAGE_SEQUENCE_LIMIT,
    image_sequence_total: sequence.length
  };
}

function buildStageUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist) {
  return [
    "以下为 V4 投稿前预审任务材料。请基于当前 Agent 提示词独立单跑评审，并输出纯 TXT。",
    "",
    "【基础任务信息】",
    buildBaseTaskInfo(task),
    "",
    "【Python 文件状态检测结果 artifact_manifest】",
    JSON.stringify(artifactManifest || {}, null, 2),
    "",
    "【图片审阅清单 image_review_checklist】",
    imageReviewChecklist,
    "",
    "【文稿材料】",
    truncateChars(manuscriptText, MAX_MANUSCRIPT_CHARS)
  ].join("\n");
}

function buildStageWebUserInput(task, artifactManifest) {
  return [
    "以下为 V4 网页端纯 TXT 预审任务材料。原始 Word 文稿已经作为附件上传，请以 Word 附件作为全文主材料；不要要求我把全文再次粘贴进 prompt。",
    "本阶段直接使用后台已发布提示词原文，不追加 JSON schema 或程序适配层。输出保存为对应 agentN.txt。",
    "",
    "【基础任务信息】",
    buildBaseTaskInfo(task),
    "",
    "【文件状态检测摘要】",
    JSON.stringify(artifactSummaryForWebPrompt(artifactManifest), null, 2),
    "",
    "【执行要求】",
    "1. 必须阅读已上传的 Word 文稿本体，包括正文、表格、图片、图注、声明区、参考文献和补充材料线索。",
    "2. 当前 Agent 只执行自身职责，不读取其他 Agent 输出，不跨阶段补审。",
    "3. 若 Word 附件、图片或表格无法读取，必须在正文中说明读取限制，不得假装已经审阅。",
    "4. 只输出自然语言 TXT，不追加 agent_report JSON、issue_list JSON 或任何程序 sidecar。",
    "5. 每条 P0/P1 问题必须给出可搜索定位、为什么是问题、投稿风险和低成本处理建议。"
  ].join("\n");
}

function buildCleanerUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist) {
  return [
    "以下为 V4 清洁员任务材料。请只汇总 5 个 Agent TXT 输出，生成纯文本 问题清单.txt。清洁员不得读取原始 Word、文稿全文或任何原文档派生材料，不得回到论文全文重新审稿。",
    "",
    "【基础任务信息】",
    buildBaseTaskInfo(task),
    "",
    "【5 个 Agent 原始审稿报告】",
    "<粘贴 5 个 Agent 的完整输出，按 stage key 分段>"
  ].join("\n");
}

function buildAdjudicatorUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist) {
  return [
    "以下为 V4 裁决者参数任务材料。请读取 Word 文稿和问题清单，只输出纯文本 裁决者参数.txt。",
    "",
    "【基础任务信息】",
    buildBaseTaskInfo(task),
    "",
    "【文稿材料】",
    truncateChars(manuscriptText, MAX_MANUSCRIPT_CHARS),
    "",
    "【问题清单.txt】",
    "<粘贴清洁员生成的问题清单.txt>",
    "",
    "不要追加 JSON 或程序 sidecar。"
  ].join("\n");
}

function buildAdjudicatorWebUserInput(task) {
  return [
    "以下为 V4 网页端裁决者参数任务材料。原始 Word 文稿已经作为附件上传，请以 Word 附件 + 问题清单.txt 作为唯一输入依据。",
    "不要要求我把全文再次粘贴进 prompt；不要追加 JSON 或程序 sidecar。",
    "",
    "【基础任务信息】",
    buildBaseTaskInfo(task),
    "",
    "【问题清单.txt】",
    "<粘贴清洁员生成的问题清单.txt>",
    "",
    "【执行要求】",
    "1. 只输出纯文本 裁决者参数.txt。",
    "2. 不展开完整问题正文，不删改问题清单，不新增问题。",
    "3. 综合评分、六维评分、风险等级、修订工作量、投稿建议和优先问题 ID 必须来自对 Word 与问题清单的裁决。"
  ].join("\n");
}

async function parseManuscript(manuscriptPath, projectRoot) {
  const ext = path.extname(manuscriptPath).toLowerCase();
  const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
  if (ext === ".docx") {
    const mammoth = requireFromProject("mammoth");
    const result = await mammoth.extractRawText({ path: manuscriptPath });
    return normalizeText(result.value);
  }
  if (ext === ".doc") {
    const WordExtractorModule = requireFromProject("word-extractor");
    const WordExtractor = WordExtractorModule.default || WordExtractorModule;
    const extractor = new WordExtractor();
    const doc = await extractor.extract(manuscriptPath);
    return normalizeText(doc.getBody());
  }
  throw new Error("Only .doc and .docx manuscripts are supported");
}

async function analyzeArtifacts(manuscriptPath, projectRoot, imageExtractDir) {
  const analyzerPath = path.join(projectRoot, "scripts", "analyze_docx_artifacts.py");
  const args = [analyzerPath, manuscriptPath];
  if (imageExtractDir) args.push("--extract-dir", imageExtractDir);
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    return {
      schema_version: "artifact_manifest.v1",
      file_path: path.resolve(manuscriptPath || ""),
      file_name: path.basename(manuscriptPath || ""),
      file_type: path.extname(manuscriptPath || "").toLowerCase().replace(/^\./, ""),
      extraction_status: "failed",
      error: error.message || "Python artifact detection failed",
      counts: {},
      images: [],
      image_sequence: [],
      extracted_images_dir: imageExtractDir || null,
      captions: { figures: [], tables: [] },
      quality_flags: [{ level: "P1", code: "artifact_detection_failed", message: error.message || "Python artifact detection failed" }]
    };
  }
}

function renderRequestBlock(title, systemPrompt, userPrompt) {
  return [`【${title}】`, "", "SYSTEM PROMPT:", systemPrompt, "", "USER PROMPT:", userPrompt].join("\n");
}

function outputPackageTemplate(artifactManifest) {
  return [
    "runner_metadata JSON:",
    JSON.stringify({ runner: "manual-or-web-browser", target_model: "填写实际模型名称", workflow_version: "v4-txt-source-only", notes: [] }, null, 2),
    "",
    "artifact_manifest JSON:",
    JSON.stringify(artifactManifest, null, 2),
    "",
    "agent1.txt:",
    "<粘贴 Agent 1 输出全文>",
    "",
    "agent2.txt:",
    "<粘贴 Agent 2 输出全文>",
    "",
    "agent3.txt:",
    "<粘贴 Agent 3 输出全文>",
    "",
    "agent4.txt:",
    "<粘贴 Agent 4 输出全文>",
    "",
    "agent5.txt:",
    "<粘贴 Agent 5 输出全文>",
    "",
    "问题清单.txt:",
    "<粘贴清洁员生成的问题清单.txt>",
    "",
    "裁决者参数.txt:",
    "<粘贴裁决者参数 Agent 生成的裁决者参数.txt>"
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const manuscriptPath = path.resolve(requireString(args.manuscript, "--manuscript"));
const customerInfo = requireString(args["customer-info"], "--customer-info");
const projectRoot = path.resolve(args["project-root"] || "/Users/a682/Documents/New project 2");
const format = String(args.format || "markdown").toLowerCase();

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptsPath = path.resolve(args.prompts || path.join(skillRoot, "references", "prompts.json"));
const promptSnapshot = JSON.parse(await fs.readFile(promptsPath, "utf8"));
const prompts = promptSnapshot.prompts || {};

const task = {
  id: `manual-${crypto.randomUUID()}`,
  originalFilename: path.basename(manuscriptPath),
  createdAt: new Date().toISOString(),
  customerInfo
};
const imageExtractDir = path.resolve(args["image-extract-dir"] || path.join(projectRoot, "storage", "extracted-images", task.id));
const manuscriptText = await parseManuscript(manuscriptPath, projectRoot);
const artifactManifest = await analyzeArtifacts(manuscriptPath, projectRoot, imageExtractDir);
const imageReviewChecklist = imageReviewChecklistText(artifactManifest);

function promptFor(stageKey) {
  const prompt = prompts[stageKey];
  if (!prompt) throw new Error(`Missing prompt in prompts.json: ${stageKey}`);
  return prompt;
}

const stageRequests = REVIEW_STAGES.map((stage) => {
  const prompt = promptFor(stage.key);
  return {
    stage: stage.key,
    title: prompt.title || stage.title,
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    prompt_hash: prompt.effectiveContentHash || prompt.contentHash || "",
    adapter_version: prompt.adapterVersion || promptSnapshot.adapterVersion || "",
    systemPrompt: prompt.content,
    userPrompt: buildStageUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist),
    webUserPrompt: buildStageWebUserInput(task, artifactManifest)
  };
});

const cleanerPrompt = promptFor(CLEANER_STAGE_KEY);
const adjudicatorPrompt = promptFor(ADJUDICATOR_STAGE_KEY);
const cleanerRequest = {
  stage: CLEANER_STAGE_KEY,
  title: cleanerPrompt.title,
  systemPrompt: cleanerPrompt.content,
  userPromptTemplate: buildCleanerUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist)
};
const adjudicatorRequest = {
  stage: ADJUDICATOR_STAGE_KEY,
  title: adjudicatorPrompt.title,
  systemPrompt: adjudicatorPrompt.content,
  userPromptTemplate: buildAdjudicatorUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist),
  webUserPromptTemplate: buildAdjudicatorWebUserInput(task)
};

const context = {
  generatedAt: new Date().toISOString(),
  sourcePromptSnapshot: promptsPath,
  promptAdapterVersion: promptSnapshot.adapterVersion || "",
  workflowVersion: "v3-single-run",
  projectRoot,
  manuscript: { path: manuscriptPath, originalFilename: task.originalFilename, parsedCharCount: manuscriptText.length, maxManuscriptChars: MAX_MANUSCRIPT_CHARS, wasTruncated: manuscriptText.length > MAX_MANUSCRIPT_CHARS },
  task,
  artifactManifest,
  imageExtractDir,
  imageReviewChecklist,
  stageRequests,
  cleanerRequest,
  adjudicatorRequest,
  outputPackageTemplate: outputPackageTemplate(artifactManifest)
};

if (format === "json") {
  console.log(JSON.stringify(context, null, 2));
} else {
  const lines = [
    "# 投稿前预审质控 V4 人工代跑上下文",
    "",
    `任务 ID：${task.id}`,
    `原始文件名：${task.originalFilename}`,
    `客户信息：${customerInfo}`,
    `解析字符数：${manuscriptText.length}`,
    `提示词快照：${promptsPath}`,
    `程序适配层版本：${promptSnapshot.adapterVersion || "-"}`,
    "",
    "## 使用要求",
    "",
    "1. 5 个 Agent 各自独立单跑，不做双跑，不运行通用一致性比较器。",
    "2. 每个 Agent 只输出纯 TXT，分别保存为 agent1.txt 至 agent5.txt，不追加 JSON sidecar。",
    "3. 清洁员只读取 5 个 Agent TXT，不上传原文，生成纯文本 问题清单.txt。",
    "4. 裁决者参数 Agent 读取 Word + 问题清单.txt，只生成纯文本 裁决者参数.txt，评分采用六维。",
    "5. PDF/Word 由后台严格映射 问题清单.txt + 裁决者参数.txt；缺关键字段直接报错，不做程序兜底。",
    "",
    "## Python 文件状态检测 artifact_manifest",
    "",
    "```json",
    JSON.stringify(artifactManifest, null, 2),
    "```",
    "",
    "## 图片审阅清单 image_review_checklist",
    "",
    "```text",
    imageReviewChecklist,
    "```",
    "",
    "## 5 Agent 单跑请求",
    ""
  ];

  for (const [index, request] of stageRequests.entries()) {
    lines.push("=".repeat(88));
    lines.push(`${index + 1}. ${request.title}`);
    lines.push(`stage：${request.stage}`);
    lines.push(`prompt_id：${request.prompt_id}`);
    lines.push(`prompt_version：${request.prompt_version}`);
    lines.push(`effective_prompt_hash：${request.prompt_hash || "-"}`);
    lines.push(`adapter_version：${request.adapter_version || "-"}`);
    lines.push("");
    lines.push(renderRequestBlock(request.title, request.systemPrompt, request.userPrompt));
    lines.push("");
  }

  lines.push("=".repeat(88), "## 清洁员请求", "", renderRequestBlock(cleanerRequest.title, cleanerRequest.systemPrompt, cleanerRequest.userPromptTemplate), "");
  lines.push("=".repeat(88), "## 裁决者参数请求", "", renderRequestBlock(adjudicatorRequest.title, adjudicatorRequest.systemPrompt, adjudicatorRequest.userPromptTemplate), "");
  lines.push("## 后台粘贴格式模板", "", outputPackageTemplate(artifactManifest));
  console.log(lines.join("\n"));
}
