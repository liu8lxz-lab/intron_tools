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
const REVIEW_STAGES = [
  { key: "selection_innovation", title: "选题创新预审" },
  { key: "clinical_methods", title: "临床方法预审" },
  { key: "statistical_results", title: "统计结果预审" },
  { key: "numerical_audit", title: "数值审计预审" },
  { key: "figure_table_visual_audit", title: "图表与视觉材料审计" },
  { key: "submission_safety_expression", title: "投稿安全与表达预审" }
];
const FINAL_STAGE_KEY = "final_adjudication";
const ADJUDICATOR_STAGE_KEY = "adjudicator_review";
const COMPARATOR_STAGE_KEY = "consistency_comparator";
const GLOBAL_STAGE_KEY = "global_system";
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

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

function buildSystemPrompt(globalPrompt, stagePrompt) {
  return [
    "【全局系统提示词】",
    globalPrompt,
    "",
    "【当前调用点提示词】",
    stagePrompt
  ].join("\n");
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
    return "未检测到可按 Word 主文档顺序提取的图片 occurrence。若正文、Figure legends 或 caption 显示应有图片，Agent 5 必须将其作为图表材料缺失风险处理。";
  }

  return sequence
    .map((image) => {
      const lines = [
        `${image.image_id}｜document_order=${image.document_order}`,
        `extracted_path: ${image.extracted_path || "未提取"}`,
        `media_path: ${image.media_path || "未知"}`,
        `size: ${image.width || "?"}x${image.height || "?"}`,
        `inferred_label: ${image.inferred_label || "无明确 Figure label"}`,
        `label_confidence: ${image.label_confidence || "none"}`,
        `placement_confidence: ${image.placement_confidence || "unknown"}`,
        `review_status: ${image.review_status || "unknown"}`
      ];
      if (image.caption_text) lines.push(`caption_text: ${image.caption_text}`);
      if (image.nearby_text_before) lines.push(`nearby_text_before: ${image.nearby_text_before}`);
      if (image.nearby_text_after) lines.push(`nearby_text_after: ${image.nearby_text_after}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildStageUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist) {
  return [
    "以下为投稿前预审任务材料。请基于当前提示词独立评审。",
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

function buildAdjudicatorUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist, consistencyReportsText, mergedIssueListsText) {
  return [
    "以下为裁决者裁定材料。请严格返回 adjudicator_review JSON。",
    "紧凑裁定要求：只输出 final_issue_decisions、priority_issue_ids、source_issue_coverage、adjudication_decisions、excluded_issues 和统计/诊断字段；不要输出 report_text、report_sections 或完整客户报告正文。",
    "后端物化要求：成立问题的 issue_narrative、submission_risk、evidence_quotes、revision_path 会由后端从六 Agent 合并问题清单继承。你只负责判断每个候选问题保留、合并、排除、升级或降级。",
    "覆盖表硬性要求：必须输出 source_issue_coverage，逐条覆盖六 Agent 合并问题清单中的每一个来源问题。每条记录必须写 source_stage、source_issue_id 或 source_issue_title、source_severity、action（kept_as / merged_into / excluded）、target_issue_id、reason。",
    "不得无记录丢弃问题。只有同一定位、同一投稿风险、同一低成本修改动作的问题才允许合并；同根因但修改动作不同的子问题必须保留为独立客户可执行问题。P0/P1 若排除，reason 必须写明证据不足、重复或不成立的具体理由。",
    "候选项基线要求：若六 Agent 合并问题候选项总数不少于 10 项，final_issue_decisions 不得低于候选项总数的 65%。若低于 65%，不要只补解释，必须恢复被过度合并的问题或逐项重裁。",
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
    truncateChars(manuscriptText, MAX_MANUSCRIPT_CHARS),
    "",
    "【六 Agent 一致性比较结果】",
    consistencyReportsText,
    "",
    "【六 Agent 合并问题清单】",
    mergedIssueListsText
  ].join("\n");
}

function buildFinalUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist, adjudicatorReviewText, consistencyReportsText, mergedIssueListsText) {
  return [
    "以下为终稿输出材料。请严格返回 final_adjudication JSON，并优先基于 adjudicator_review JSON 生成客户版报告字段。",
    "报告层输出要求：终稿只输出摘要、总体结论、模型模糊评分、优势短板、六维诊断、投稿建议、风险等级、修订工作量、priority_issue_ids、检查清单和客户版材料完成度摘要。",
    "一一对应要求：终稿不得二次合并、删减、拆分、重排或降级裁决者问题池。report_content.final_issue_list 可留空或只给 id 引用；后端会从裁决者问题池补全完整问题正文。",
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
    truncateChars(manuscriptText, MAX_MANUSCRIPT_CHARS),
    "",
    "【adjudicator_review JSON（裁决者裁定结果；标准输入）】",
    adjudicatorReviewText,
    "",
    "【六 Agent 一致性比较结果】",
    consistencyReportsText,
    "",
    "【六 Agent 合并问题清单（兜底输入；若 adjudicator_review JSON 不完整才参考）】",
    mergedIssueListsText
  ].join("\n");
}

function buildComparatorUserInput(task, stage, artifactManifest, imageReviewChecklist) {
  return [
    "以下为同一 Agent 的两次独立审稿输出。请按当前比较器提示词进行一致性比较，并返回严格 JSON。",
    "",
    "【基础任务信息】",
    buildBaseTaskInfo(task),
    "",
    "【当前 Agent】",
    `stage：${stage.key}`,
    `title：${stage.title}`,
    "",
    "【Python 文件状态检测结果 artifact_manifest】",
    JSON.stringify(artifactManifest || {}, null, 2),
    "",
    "【图片审阅清单 image_review_checklist】",
    imageReviewChecklist,
    "",
    "【第 1 次独立审稿输出 run_1】",
    `<粘贴 ${stage.key} 第 1 次审稿输出>`,
    "",
    "【第 2 次独立审稿输出 run_2】",
    `<粘贴 ${stage.key} 第 2 次审稿输出>`
  ].join("\n");
}

async function parseManuscript(manuscriptPath, projectRoot) {
  const ext = path.extname(manuscriptPath).toLowerCase();
  const requireFromProject = createRequire(path.join(projectRoot, "package.json"));

  if (ext === ".docx") {
    const mammoth = requireFromProject("mammoth");
    const result = await mammoth.extractRawText({ path: manuscriptPath });
    const text = normalizeText(result.value);
    if (!text) throw new Error("No reviewable text parsed from docx");
    return text;
  }

  if (ext === ".doc") {
    const WordExtractorModule = requireFromProject("word-extractor");
    const WordExtractor = WordExtractorModule.default || WordExtractorModule;
    const extractor = new WordExtractor();
    const doc = await extractor.extract(manuscriptPath);
    const text = normalizeText(doc.getBody());
    if (!text) throw new Error("No reviewable text parsed from doc");
    return text;
  }

  throw new Error("Only .doc and .docx manuscripts are supported");
}

async function analyzeArtifacts(manuscriptPath, projectRoot, imageExtractDir) {
  const analyzerPath = path.join(projectRoot, "scripts", "analyze_docx_artifacts.py");
  const args = [analyzerPath, manuscriptPath];
  if (imageExtractDir) args.push("--extract-dir", imageExtractDir);
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, args, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024
    });
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
      quality_flags: [
        {
          level: "P1",
          code: "artifact_detection_failed",
          message: error.message || "Python artifact detection failed"
        }
      ]
    };
  }
}

function renderRequestBlock(title, systemPrompt, userPrompt) {
  return [
    `【${title}】`,
    "",
    "SYSTEM PROMPT:",
    systemPrompt,
    "",
    "USER PROMPT:",
    userPrompt
  ].join("\n");
}

function emptyConsistencyTemplate() {
  return Object.fromEntries(
    REVIEW_STAGES.map((stage) => [
      stage.key,
      {
        overallOverlapRate: 0,
        p0p1OverlapRate: 0,
        consistencyLevel: "high|medium|low",
        onlyInRun1: [],
        onlyInRun2: [],
        overlapIssues: [],
        notes: "替换为该 Agent 双跑一致性比较结果"
      }
    ])
  );
}

function emptyMergedIssueTemplate() {
  return Object.fromEntries(
    REVIEW_STAGES.map((stage) => [
      stage.key,
      [
        {
          severity: "P0|P1|P2|P3",
          category: stage.key,
          issue: "合并后的问题",
          evidence: "文稿证据 / Python 检测证据 / 需人工核对",
          location: "位置线索",
          recommendation: "修改建议",
          confidence: 0.8,
          source_runs: ["run_1", "run_2"]
        }
      ]
    ])
  );
}

function emptyAdjudicatorTemplate() {
  return {
    adjudication_summary: "200字以内裁决摘要",
    overall_judgment: {},
    final_issue_decisions: [
      {
        id: "JR-001",
        action: "keep",
        severity: "P1",
        category: "clinical_methods",
        primary_dimension: "研究设计与临床逻辑",
        issue: "最终问题短标题",
        source_issue_ids: ["clinical_methods:A2-M01"],
        reason: "保留、合并、升级或降级的裁定理由"
      }
    ],
    priority_issue_ids: ["JR-001"],
    source_issue_coverage: [
      {
        source_stage: "clinical_methods",
        source_issue_id: "A2-M01",
        source_issue_title: "来源问题标题",
        source_severity: "P1",
        action: "kept_as",
        target_issue_id: "JR-001",
        reason: "保留、合并或排除的具体理由"
      }
    ],
    adjudication_decisions: [],
    excluded_issues: [],
    severity_counts: { P0: 0, P1: 0, P2: 0, P3: 0, total: 0 },
    issue_distribution: {},
    consistency_metrics: {},
    artifact_quality_summary: {},
    manuscript_strengths: [],
    major_weaknesses: [],
    dimension_diagnosis: {}
  };
}

function outputPackageTemplate(artifactManifest) {
  const agentRuns = Object.fromEntries(
    REVIEW_STAGES.map((stage) => [
      stage.key,
      {
        run_1: { issues: [], positive_findings: [], review_summary: "" },
        run_2: { issues: [], positive_findings: [], review_summary: "" }
      }
    ])
  );

  return [
    "runner_metadata JSON:",
    JSON.stringify(
      {
        runner: "manual-or-web-browser",
        target_model: "填写实际模型名称",
        authorization_mode: "task-level-preapproval",
        fidelity_contract_version: "source-coverage.v1",
        fidelity_validation_mode: "strict",
        notes: []
      },
      null,
      2
    ),
    "",
    "artifact_manifest JSON:",
    JSON.stringify(artifactManifest, null, 2),
    "",
    "agent_runs:",
    JSON.stringify(agentRuns, null, 2),
    "",
    "agent_consistency_reports:",
    JSON.stringify(emptyConsistencyTemplate(), null, 2),
    "",
    "agent_merged_issue_lists:",
    JSON.stringify(emptyMergedIssueTemplate(), null, 2),
    "",
    "adjudicator_review JSON:",
    JSON.stringify(emptyAdjudicatorTemplate(), null, 2),
    "",
    "final_adjudication JSON:",
    JSON.stringify(
      {
        summary: "200字以内摘要",
        overall_conclusion: "总体预审结论",
        must_fix: [],
        suggested_fix: [],
        text_and_figure_comments: [],
        compliance_risk: [],
        pre_submission_checklist: [],
        final_review_text: "完整报告正文",
        report_content: {}
      },
      null,
      2
    )
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
const globalPrompt = prompts[GLOBAL_STAGE_KEY];
if (!globalPrompt) throw new Error("Missing global_system prompt in prompts.json");

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

const stageRequests = REVIEW_STAGES.map((stage) => {
  const prompt = prompts[stage.key];
  if (!prompt) throw new Error(`Missing prompt in prompts.json: ${stage.key}`);
  return {
    stage: stage.key,
    title: prompt.title || stage.title,
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    prompt_hash: prompt.effectiveContentHash || prompt.contentHash || "",
    raw_prompt_hash: prompt.rawContentHash || "",
    adapter_version: prompt.adapterVersion || promptSnapshot.adapterVersion || "",
    global_prompt_id: globalPrompt.id,
    global_prompt_version: globalPrompt.version,
    global_prompt_hash: globalPrompt.effectiveContentHash || globalPrompt.contentHash || "",
    systemPrompt: buildSystemPrompt(globalPrompt.content, prompt.content),
    userPrompt: buildStageUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist)
  };
});

const finalPrompt = prompts[FINAL_STAGE_KEY];
if (!finalPrompt) throw new Error("Missing final_adjudication prompt in prompts.json");
const adjudicatorPrompt = prompts[ADJUDICATOR_STAGE_KEY];
if (!adjudicatorPrompt) throw new Error("Missing adjudicator_review prompt in prompts.json");
const comparatorPrompt = prompts[COMPARATOR_STAGE_KEY];
if (!comparatorPrompt) throw new Error("Missing consistency_comparator prompt in prompts.json");

const comparatorRequests = REVIEW_STAGES.map((stage) => ({
  stage: COMPARATOR_STAGE_KEY,
  title: comparatorPrompt.title,
  targetStage: stage.key,
  targetTitle: stage.title,
  prompt_id: comparatorPrompt.id,
  prompt_version: comparatorPrompt.version,
  prompt_hash: comparatorPrompt.effectiveContentHash || comparatorPrompt.contentHash || "",
  adapter_version: comparatorPrompt.adapterVersion || promptSnapshot.adapterVersion || "",
  global_prompt_id: globalPrompt.id,
  global_prompt_version: globalPrompt.version,
  global_prompt_hash: globalPrompt.effectiveContentHash || globalPrompt.contentHash || "",
  systemPrompt: buildSystemPrompt(globalPrompt.content, comparatorPrompt.content),
  userPromptTemplate: buildComparatorUserInput(task, stage, artifactManifest, imageReviewChecklist)
}));

const consistencyPlaceholder = JSON.stringify(emptyConsistencyTemplate(), null, 2);
const mergedPlaceholder = JSON.stringify(emptyMergedIssueTemplate(), null, 2);
const adjudicatorPlaceholder = JSON.stringify(emptyAdjudicatorTemplate(), null, 2);
const adjudicatorRequest = {
  stage: ADJUDICATOR_STAGE_KEY,
  title: adjudicatorPrompt.title,
  prompt_id: adjudicatorPrompt.id,
  prompt_version: adjudicatorPrompt.version,
  prompt_hash: adjudicatorPrompt.effectiveContentHash || adjudicatorPrompt.contentHash || "",
  adapter_version: adjudicatorPrompt.adapterVersion || promptSnapshot.adapterVersion || "",
  global_prompt_id: globalPrompt.id,
  global_prompt_version: globalPrompt.version,
  global_prompt_hash: globalPrompt.effectiveContentHash || globalPrompt.contentHash || "",
  systemPrompt: buildSystemPrompt(globalPrompt.content, adjudicatorPrompt.content),
  userPromptTemplate: buildAdjudicatorUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist, consistencyPlaceholder, mergedPlaceholder)
};
const finalRequest = {
  stage: FINAL_STAGE_KEY,
  title: finalPrompt.title,
  prompt_id: finalPrompt.id,
  prompt_version: finalPrompt.version,
  prompt_hash: finalPrompt.effectiveContentHash || finalPrompt.contentHash || "",
  adapter_version: finalPrompt.adapterVersion || promptSnapshot.adapterVersion || "",
  global_prompt_id: globalPrompt.id,
  global_prompt_version: globalPrompt.version,
  global_prompt_hash: globalPrompt.effectiveContentHash || globalPrompt.contentHash || "",
  systemPrompt: buildSystemPrompt(globalPrompt.content, finalPrompt.content),
  userPromptTemplate: buildFinalUserInput(task, manuscriptText, artifactManifest, imageReviewChecklist, adjudicatorPlaceholder, consistencyPlaceholder, mergedPlaceholder)
};

const context = {
  generatedAt: new Date().toISOString(),
  sourcePromptSnapshot: promptsPath,
  promptAdapterVersion: promptSnapshot.adapterVersion || "",
  projectRoot,
  manuscript: {
    path: manuscriptPath,
    originalFilename: task.originalFilename,
    parsedCharCount: manuscriptText.length,
    maxManuscriptChars: MAX_MANUSCRIPT_CHARS,
    wasTruncated: manuscriptText.length > MAX_MANUSCRIPT_CHARS
  },
  task,
  artifactManifest,
  imageExtractDir,
  imageReviewChecklist,
  stageRequests,
  comparatorRequests,
  adjudicatorRequest,
  finalRequest,
  outputPackageTemplate: outputPackageTemplate(artifactManifest)
};

if (format === "json") {
  console.log(JSON.stringify(context, null, 2));
} else {
  const lines = [
    "# 投稿前预审质控 V2.1 人工代跑上下文",
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
    "1. 以下 6 个 Agent 请求必须按 stage key 顺序处理。",
    "2. 每个 Agent 必须独立运行两次，第二次不得参考第一次输出。",
    "3. 不同 Agent 之间不要互相引用输出；每次只使用当前 Agent 提示词、文稿、客户信息和 artifact_manifest。",
    "4. 每个 Agent 双跑完成后，先做一致性比较，再合并为该 Agent 问题清单。",
    "5. 裁决者裁定阶段读取 artifact_manifest、六份一致性比较和六份合并问题清单，只运行一次，返回 adjudicator_review JSON。",
    "6. 终稿输出阶段优先读取 adjudicator_review JSON，并返回 final_adjudication JSON。",
    "7. 图表与视觉材料审计必须优先使用 artifact_manifest；若图片数为 0，不得输出图片无问题。",
    "8. 若 image_sequence 存在 extracted_path，运行 Agent 4/5 前必须逐张打开图片审阅；证据引用稳定编号如 img_001 / inferred_label: Figure 1。",
    "9. 若图片无法打开、格式不可审阅或仅有 caption/正文引用，必须说明审图受限，不得假装已审图。",
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
    "## 六 Agent 双跑请求",
    ""
  ];

  for (const [index, request] of stageRequests.entries()) {
    lines.push("=".repeat(88));
    lines.push(`${index + 1}. ${request.title}`);
    lines.push(`stage：${request.stage}`);
    lines.push(`prompt_id：${request.prompt_id}`);
    lines.push(`prompt_version：${request.prompt_version}`);
    lines.push(`effective_prompt_hash：${request.prompt_hash || "-"}`);
    lines.push(`raw_prompt_hash：${request.raw_prompt_hash || "-"}`);
    lines.push(`adapter_version：${request.adapter_version || "-"}`);
    lines.push("运行要求：用以下同一请求分别生成 run_1 和 run_2；两次之间保持独立。`issues` 必须结构化，并为每条问题填写 `issue_narrative` 长篇审稿正文。");
    lines.push("");
    lines.push(renderRequestBlock(request.title, request.systemPrompt, request.userPrompt));
    lines.push("");
  }

  lines.push("=".repeat(88));
  lines.push("## 一致性比较与合并要求");
  lines.push("");
  lines.push("每个 Agent 完成 run_1 / run_2 后，使用以下通用一致性比较器提示词进行比较与合并。");
  lines.push("");
  for (const [index, request] of comparatorRequests.entries()) {
    lines.push("-".repeat(88));
    lines.push(`${index + 1}. ${request.targetTitle}`);
    lines.push(`target_stage：${request.targetStage}`);
    lines.push(`comparator_prompt_id：${request.prompt_id}`);
    lines.push(`comparator_prompt_version：${request.prompt_version}`);
    lines.push(`effective_prompt_hash：${request.prompt_hash || "-"}`);
    lines.push(`adapter_version：${request.adapter_version || "-"}`);
    lines.push("");
    lines.push(renderRequestBlock(`${request.targetTitle} - ${request.title}`, request.systemPrompt, request.userPromptTemplate));
    lines.push("");
  }
  lines.push("");
  lines.push("## 裁决者裁定请求模板");
  lines.push("");
  lines.push("完成六 Agent 合并问题清单后，将模板中的占位内容替换为实际一致性比较和合并问题清单。裁决者只运行一次。");
  lines.push(`prompt_id：${adjudicatorRequest.prompt_id}`);
  lines.push(`prompt_version：${adjudicatorRequest.prompt_version}`);
  lines.push(`effective_prompt_hash：${adjudicatorRequest.prompt_hash || "-"}`);
  lines.push(`adapter_version：${adjudicatorRequest.adapter_version || "-"}`);
  lines.push("");
  lines.push(renderRequestBlock(adjudicatorRequest.title, adjudicatorRequest.systemPrompt, adjudicatorRequest.userPromptTemplate));
  lines.push("");
  lines.push("## 终稿输出请求模板");
  lines.push("");
  lines.push("完成裁决者裁定后，将模板中的 adjudicator_review 占位内容替换为实际裁决者 JSON。");
  lines.push(`prompt_id：${finalRequest.prompt_id}`);
  lines.push(`prompt_version：${finalRequest.prompt_version}`);
  lines.push(`effective_prompt_hash：${finalRequest.prompt_hash || "-"}`);
  lines.push(`adapter_version：${finalRequest.adapter_version || "-"}`);
  lines.push("");
  lines.push(renderRequestBlock(finalRequest.title, finalRequest.systemPrompt, finalRequest.userPromptTemplate));
  lines.push("");
  lines.push("## 后台粘贴格式模板");
  lines.push("");
  lines.push(outputPackageTemplate(artifactManifest));
  console.log(lines.join("\n"));
}
