import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import express from "express";
import mammoth from "mammoth";
import multer from "multer";
import WordExtractor from "word-extractor";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  TextRun
} from "docx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".data");
const STORAGE_DIR = path.join(ROOT, "storage");
const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
const REPORT_DIR = path.join(STORAGE_DIR, "reports");
const STAGE_OUTPUT_DIR = path.join(STORAGE_DIR, "stage-outputs");
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH = path.join(DATA_DIR, "db.json");
const MASTER_KEY_PATH = path.join(DATA_DIR, "master.key");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@123";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
const MAX_MANUSCRIPT_CHARS = Number(process.env.MAX_MANUSCRIPT_CHARS || 120_000);

const REVIEW_STAGES = [
  { key: "clinical_rationality", title: "临床合理性预审" },
  { key: "statistical_rationality", title: "统计合理性预审" },
  { key: "figure_table_consistency", title: "图表一致性预审" },
  { key: "compliance_risk", title: "合规 / 风险预审" },
  { key: "minimal_revision", title: "最小修稿预审" }
];

const GLOBAL_STAGE = { key: "global_system", title: "全局系统提示词" };
const FINAL_STAGE = { key: "final_adjudication", title: "GPT 裁决者终审" };
const PROMPT_STAGES = [GLOBAL_STAGE, ...REVIEW_STAGES, FINAL_STAGE];

const STATUS_TEXT = {
  queued: "排队中",
  parsing: "解析材料中",
  stage1_running: "GPT 预审组审稿中",
  stage2_running: "GPT 裁决者终审中",
  manual_stage_pending: "待人工预审输出",
  manual_final_pending: "待人工终审输出",
  docx_generating: "生成质控报告中",
  succeeded: "预审完成",
  failed: "预审失败",
  cancelled: "任务已取消"
};

const DEFAULT_PROMPTS = {
  global_system: `你是临床 SCI 稿件投稿前预审质控系统的专业审稿助手。

全局约束：
1. 只基于用户上传文稿、客户信息、任务信息和当前调用允许接收的阶段材料进行判断，不得编造文稿中没有的信息。
2. 使用中文输出，语气专业、克制、可执行，面向投稿前内部质控。
3. 优先识别可能影响投稿、返修、拒稿、伦理合规和结果可信度的问题。
4. 对无法从材料中确认的信息，明确写为“需人工核对”或“建议补充”，不要假定其存在。
5. 不输出与审稿无关的隐私信息、营销话术或泛泛鼓励。
6. 所有修改建议应尽量具体到作者可以执行的动作。`,
  clinical_rationality: `你是临床 SCI 稿件投稿前预审专家，负责“临床合理性预审”。

请只从临床问题、研究假设、入排标准、终点设置、干预/暴露定义、临床解释、外推边界等角度独立审阅稿件。
不要引用其他预审阶段，也不要假设你看过其他阶段结果。

输出要求：
1. 按“主要问题”“次要问题”“建议补充/修改”“投稿风险”分节。
2. 每条意见要给出问题、依据、修改方向。
3. 避免空泛表述，优先指出投稿前必须处理的临床逻辑缺陷。`,
  statistical_rationality: `你是临床 SCI 稿件投稿前预审专家，负责“统计合理性预审”。

请只从研究设计、样本量、变量定义、统计方法、模型选择、混杂控制、缺失值、敏感性分析、亚组分析、P 值/置信区间解读、表格统计呈现等角度独立审阅稿件。
不要引用其他预审阶段，也不要假设你看过其他阶段结果。

输出要求：
1. 按“统计设计问题”“统计方法问题”“结果呈现问题”“建议修订”分节。
2. 每条意见要说明风险等级、问题依据、具体修改建议。
3. 对可能导致拒稿或重大质疑的问题标记为“必须修改”。`,
  figure_table_consistency: `你是临床 SCI 稿件投稿前预审专家，负责“图表一致性预审”。

请只从正文、表格、图片、图注、legend、补充材料之间的一致性进行独立审阅，包括编号、变量名、单位、样本量、统计符号、缩写、显著性标记、结果方向是否一致。
不要引用其他预审阶段，也不要假设你看过其他阶段结果。

输出要求：
1. 按“正文-表格一致性”“正文-图片一致性”“表格/图片内部一致性”“格式与可读性建议”分节。
2. 对每条不一致尽量指出位置线索、冲突内容、建议修正方式。
3. 如无法判断具体图表内容，也要指出需要人工核对的清单。`,
  compliance_risk: `你是临床 SCI 稿件投稿前预审专家，负责“合规 / 风险预审”。

请只从伦理审批、知情同意、注册、数据来源、隐私保护、利益冲突、基金声明、作者贡献、AI 使用声明、临床研究报告规范、期刊政策风险等角度独立审阅稿件。
不要引用其他预审阶段，也不要假设你看过其他阶段结果。

输出要求：
1. 按“伦理与注册”“数据与隐私”“声明完整性”“期刊政策风险”“建议补充文本”分节。
2. 明确区分“必须补充”和“建议补充”。
3. 给出可直接用于作者修改的中文建议。`,
  minimal_revision: `你是临床 SCI 稿件投稿前预审专家，负责“最小修稿预审”。

请站在投稿前交付质控角度，识别最小必要修改集合：哪些修改最能降低拒稿风险，哪些问题可以后续返修处理。
不要引用其他预审阶段，也不要假设你看过其他阶段结果。

输出要求：
1. 输出“最小必须修改清单”“高性价比建议修改”“可暂缓处理问题”“提交前最后核对”。
2. 每条意见都要简洁、可执行。
3. 优先控制修改成本和投稿前风险。`,
  final_adjudication: `你是“GPT 裁决者终审”，负责汇总 5 组独立预审意见并生成投稿前预审质控结论。

你会收到：
1. 文稿材料。
2. 客户信息。
3. 5 组固定预审阶段输出。

你的任务：
1. 对 5 组意见去重、合并、裁决优先级。
2. 将真正影响投稿风险的问题放入 must_fix。
3. 将改进性建议放入 suggested_fix。
4. 输出结构化 JSON，禁止输出 Markdown 代码块，禁止输出 JSON 之外的任何文字。

必须返回以下 JSON 结构：
{
  "summary": "200字以内摘要",
  "overall_conclusion": "总体预审结论",
  "must_fix": [],
  "suggested_fix": [],
  "text_and_figure_comments": [],
  "compliance_risk": [],
  "pre_submission_checklist": [],
  "final_review_text": "完整报告正文"
}

数组项可以是字符串，也可以是包含 title/detail/priority 的对象。summary 必须不超过 200 个中文字符。`
};

const FIELD_LABELS = {
  summary: "200字以内摘要",
  overall_conclusion: "总体预审结论",
  must_fix: "必须修改问题",
  suggested_fix: "建议修改问题",
  text_and_figure_comments: "正文 / 图表修改意见",
  compliance_risk: "合规与风险提示",
  pre_submission_checklist: "投稿前检查清单",
  final_review_text: "完整报告正文"
};

let db;
let masterKey;
let activeWorker = false;
const adminSessions = new Map();

async function ensureDirs() {
  await Promise.all([
    fsp.mkdir(DATA_DIR, { recursive: true }),
    fsp.mkdir(UPLOAD_DIR, { recursive: true }),
    fsp.mkdir(REPORT_DIR, { recursive: true }),
    fsp.mkdir(STAGE_OUTPUT_DIR, { recursive: true })
  ]);
}

async function loadMasterKey() {
  try {
    const raw = await fsp.readFile(MASTER_KEY_PATH, "utf8");
    const key = Buffer.from(raw.trim(), "base64");
    if (key.length !== 32) throw new Error("Invalid master key length");
    return key;
  } catch {
    const key = crypto.randomBytes(32);
    await fsp.writeFile(MASTER_KEY_PATH, key.toString("base64"), { mode: 0o600 });
    return key;
  }
}

async function loadDb() {
  try {
    const raw = await fsp.readFile(DB_PATH, "utf8");
    return normalizeDb(JSON.parse(raw));
  } catch {
    return createInitialDb();
  }
}

function createInitialDb() {
  const now = new Date().toISOString();
  const prompts = {};
  for (const stage of PROMPT_STAGES) {
    prompts[stage.key] = [
      {
        id: crypto.randomUUID(),
        stage: stage.key,
        title: stage.title,
        version: 1,
        status: "published",
        content: DEFAULT_PROMPTS[stage.key],
        createdAt: now,
        publishedAt: now
      }
    ];
  }

  return {
    apiConfigs: [],
    prompts,
    tasks: []
  };
}

function normalizeDb(value) {
  const loaded = value && typeof value === "object" ? value : {};
  loaded.apiConfigs = Array.isArray(loaded.apiConfigs) ? loaded.apiConfigs : [];
  loaded.prompts = loaded.prompts && typeof loaded.prompts === "object" ? loaded.prompts : {};
  loaded.tasks = Array.isArray(loaded.tasks) ? loaded.tasks : [];

  const now = new Date().toISOString();
  for (const stage of PROMPT_STAGES) {
    if (!Array.isArray(loaded.prompts[stage.key]) || loaded.prompts[stage.key].length === 0) {
      loaded.prompts[stage.key] = [
        {
          id: crypto.randomUUID(),
          stage: stage.key,
          title: stage.title,
          version: 1,
          status: "published",
          content: DEFAULT_PROMPTS[stage.key],
          createdAt: now,
          publishedAt: now
        }
      ];
    }
  }

  return loaded;
}

async function saveDb() {
  const tmpPath = `${DB_PATH}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(db, null, 2));
  await fsp.rename(tmpPath, DB_PATH);
}

function encryptText(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64")).join(".");
}

function decryptText(value) {
  if (!value) return "";
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  const iv = Buffer.from(ivRaw, "base64");
  const tag = Buffer.from(tagRaw, "base64");
  const encrypted = Buffer.from(encryptedRaw, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function maskKey(encryptedKey) {
  if (!encryptedKey) return "";
  try {
    const key = decryptText(encryptedKey);
    if (key.length <= 8) return "********";
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
  } catch {
    return "********";
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map((part) => part.trim());
  const found = parts.find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
}

function requireAdmin(req, res, next) {
  const token = getCookie(req, "admin_token") || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: "未登录或登录已失效" });
  }
  const session = adminSessions.get(token);
  session.lastSeenAt = new Date().toISOString();
  return next();
}

function jsonError(res, status, message, details) {
  return res.status(status).json({ error: message, details });
}

function nowIso() {
  return new Date().toISOString();
}

function toPublicTask(task) {
  return {
    id: task.id,
    originalFilename: task.originalFilename,
    customerInfo: task.customerInfo,
    status: task.status,
    statusText: STATUS_TEXT[task.status] || task.status,
    summary: task.summary || "",
    error: task.error || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    reportAvailable: task.status === "succeeded" && Boolean(task.reportPath)
  };
}

function toAdminTask(task) {
  return {
    ...toPublicTask(task),
    manualMode: Boolean(task.manualMode),
    manualReason: task.manualReason || "",
    stageOutputsCount: task.stageOutputs?.length || 0,
    finalJson: task.finalJson || null,
    progressLog: task.progressLog || []
  };
}

function toPublicConfig(config) {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    proxyUrl: config.proxyUrl || "",
    model: config.model,
    timeout: config.timeout,
    temperature: config.temperature,
    temperatureParam: config.temperatureParam || "auto",
    reasoningEffort: config.reasoningEffort || "high",
    maxTokens: config.maxTokens,
    maxTokensParam: config.maxTokensParam || "auto",
    enabled: config.enabled,
    apiKeyMasked: maskKey(config.apiKeyEnc),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

function findTask(taskId) {
  return db.tasks.find((task) => task.id === taskId);
}

function getEnabledConfig() {
  return db.apiConfigs.find((config) => config.enabled);
}

function getPublishedPrompt(stageKey) {
  const versions = db.prompts[stageKey] || [];
  const published = versions.find((item) => item.status === "published");
  if (!published) {
    throw new Error(`未找到已发布提示词：${stageKey}`);
  }
  return published;
}

function getPromptTitle(stageKey) {
  return PROMPT_STAGES.find((item) => item.key === stageKey)?.title || stageKey;
}

function nextPromptVersion(stageKey) {
  const versions = db.prompts[stageKey] || [];
  return versions.reduce((max, item) => Math.max(max, item.version || 0), 0) + 1;
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

function buildManualRequestText(title, systemPrompt, userInput) {
  return [
    `【${title}】`,
    "",
    "请将 SYSTEM PROMPT 和 USER PROMPT 作为一次独立 GPT 请求提交。",
    "",
    "SYSTEM PROMPT:",
    systemPrompt,
    "",
    "USER PROMPT:",
    userInput
  ].join("\n");
}

function buildManualStageInputText(task, manuscriptText) {
  const globalPrompt = getPublishedPrompt(GLOBAL_STAGE.key);
  const parts = [
    "投稿前预审质控系统 - 人工代跑材料",
    "",
    "使用说明：",
    "1. 以下 5 个预审请求必须分别提交给 GPT。",
    "2. 不要使用同一个 conversation/thread 连续执行 5 个阶段。",
    "3. 不要把前一阶段输出传给后一阶段。",
    "4. 每个阶段完成后，将输出粘贴回后台“人工代跑工作台”。",
    "",
    `任务 ID：${task.id}`,
    `原始文件名：${task.originalFilename}`,
    `客户信息：${task.customerInfo || "未填写"}`,
    `全局提示词版本：v${globalPrompt.version} (${globalPrompt.id})`,
    ""
  ];

  for (const [index, stage] of REVIEW_STAGES.entries()) {
    const prompt = getPublishedPrompt(stage.key);
    parts.push("=".repeat(88));
    parts.push(`${index + 1}. ${stage.title}`);
    parts.push(`stage：${stage.key}`);
    parts.push(`prompt_id：${prompt.id}`);
    parts.push(`prompt_version：${prompt.version}`);
    parts.push("");
    parts.push(buildManualRequestText(stage.title, buildSystemPrompt(globalPrompt.content, prompt.content), buildStageUserInput(task, manuscriptText)));
    parts.push("");
  }

  return parts.join("\n");
}

function buildManualFinalInputText(task, manuscriptText) {
  if ((task.stageOutputs || []).length < REVIEW_STAGES.length) {
    throw new Error("请先提交完整五阶段人工预审输出");
  }

  const globalPrompt = getPublishedPrompt(GLOBAL_STAGE.key);
  const finalPrompt = getPublishedPrompt(FINAL_STAGE.key);
  return [
    "投稿前预审质控系统 - 人工终审材料",
    "",
    "使用说明：",
    "1. 将以下 SYSTEM PROMPT 和 USER PROMPT 作为一次 GPT 请求提交。",
    "2. GPT 必须只返回 JSON，不要返回 Markdown 代码块。",
    "3. 将 GPT 返回内容完整粘贴回后台“终审 JSON / 输出”。",
    "",
    `任务 ID：${task.id}`,
    `原始文件名：${task.originalFilename}`,
    `全局提示词版本：v${globalPrompt.version} (${globalPrompt.id})`,
    `终审提示词版本：v${finalPrompt.version} (${finalPrompt.id})`,
    "",
    buildManualRequestText(FINAL_STAGE.title, buildSystemPrompt(globalPrompt.content, finalPrompt.content), buildFinalUserInput(task, manuscriptText, task.stageOutputs))
  ].join("\n");
}

function cleanFilename(name) {
  return path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, "_");
}

function validateUploadFile(file) {
  if (!file) throw new Error("请上传 Word 文稿");
  const ext = path.extname(file.originalname).toLowerCase();
  if (![".doc", ".docx"].includes(ext)) {
    throw new Error("当前仅支持 doc / docx，暂不支持 PDF");
  }
}

function pushProgress(task, status, message) {
  task.status = status;
  task.updatedAt = nowIso();
  task.progressLog = task.progressLog || [];
  task.progressLog.push({
    status,
    statusText: STATUS_TEXT[status] || status,
    message,
    time: task.updatedAt
  });
}

async function parseManuscript(task) {
  const ext = path.extname(task.originalFilename).toLowerCase();
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: task.uploadPath });
    const text = normalizeText(result.value);
    if (!text) throw new Error("未能从 docx 中解析到可审阅文本");
    return text;
  }

  if (ext === ".doc") {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(task.uploadPath);
    const text = normalizeText(doc.getBody());
    if (!text) throw new Error("未能从 doc 中解析到可审阅文本");
    return text;
  }

  throw new Error("当前仅支持 doc / docx，暂不支持 PDF");
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

function buildStageUserInput(task, manuscriptText) {
  return [
    "以下为投稿前预审任务材料。请基于当前提示词独立评审。",
    "",
    "【基础任务信息】",
    buildBaseTaskInfo(task),
    "",
    "【文稿材料】",
    truncateChars(manuscriptText, MAX_MANUSCRIPT_CHARS)
  ].join("\n");
}

function buildFinalUserInput(task, manuscriptText, stageOutputs) {
  const stageText = stageOutputs
    .map((item, index) => {
      return [
        `【${index + 1}. ${item.title}】`,
        `stage：${item.stage}`,
        `model：${item.model || ""}`,
        `global_prompt_id：${item.global_prompt_id || ""}`,
        `prompt_id：${item.prompt_id || ""}`,
        "",
        item.output || ""
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "以下为 GPT 裁决者终审材料。请严格返回 JSON。",
    "",
    "【基础任务信息】",
    buildBaseTaskInfo(task),
    "",
    "【文稿材料】",
    truncateChars(manuscriptText, MAX_MANUSCRIPT_CHARS),
    "",
    "【五阶段独立预审输出】",
    stageText
  ].join("\n");
}

function chatCompletionsUrl(baseUrl) {
  const cleaned = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!cleaned) throw new Error("Base URL 不能为空");
  if (/\/chat\/completions$/i.test(cleaned)) return cleaned;
  if (/\/v\d+$/i.test(cleaned)) return `${cleaned}/chat/completions`;
  if (/api\.openai\.com/i.test(cleaned)) return `${cleaned}/v1/chat/completions`;
  return `${cleaned}/chat/completions`;
}

function normalizeProxyUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function normalizeMaxTokensParam(value) {
  const normalized = String(value || "auto").trim();
  return ["auto", "max_tokens", "max_completion_tokens"].includes(normalized) ? normalized : "auto";
}

function normalizeTemperatureParam(value) {
  const normalized = String(value || "auto").trim();
  return ["auto", "send", "omit"].includes(normalized) ? normalized : "auto";
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || "high").trim().toLowerCase();
  return ["auto", "none", "minimal", "low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "high";
}

async function callChatModel(config, systemPrompt, userInput) {
  const apiKey = decryptText(config.apiKeyEnc);
  if (!apiKey) throw new Error("当前 API 配置未填写 API Key");

  const startedAt = Date.now();
  const requestUrl = chatCompletionsUrl(config.baseUrl);
  const requestBody = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput }
    ]
  };
  if (shouldSendTemperature(config)) {
    requestBody.temperature = Number(config.temperature ?? 0.2);
  }
  if (shouldSendReasoningEffort(config)) {
    requestBody.reasoning_effort = normalizeReasoningEffort(config.reasoningEffort);
  }
  requestBody[resolveMaxTokensParam(config)] = Number(config.maxTokens || 4096);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
  let rawText;
  let ok;
  let status;
  try {
    if (config.proxyUrl) {
      const proxied = await postJsonViaHttpProxy(requestUrl, normalizeProxyUrl(config.proxyUrl), headers, requestBody, Number(config.timeout || 120000));
      rawText = proxied.text;
      ok = proxied.status >= 200 && proxied.status < 300;
      status = proxied.status;
    } else {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(Number(config.timeout || 120000)),
        body: JSON.stringify(requestBody)
      });
      rawText = await response.text();
      ok = response.ok;
      status = response.status;
    }
  } catch (error) {
    throw new Error(formatNetworkError(error, requestUrl));
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { raw: rawText };
  }

  if (!ok) {
    const message = data?.error?.message || data?.message || rawText || `HTTP ${status}`;
    throw new Error(`模型调用失败：${message}`);
  }

  const output = extractModelOutput(data);
  const finishReason = data?.choices?.[0]?.finish_reason || data?.finish_reason || null;
  const usage = {
    inputTokens: data?.usage?.prompt_tokens ?? data?.usage?.input_tokens ?? null,
    outputTokens: data?.usage?.completion_tokens ?? data?.usage?.output_tokens ?? null,
    totalTokens: data?.usage?.total_tokens ?? null,
    reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? data?.usage?.output_tokens_details?.reasoning_tokens ?? null
  };

  if (!String(output || "").trim()) {
    throw new Error(buildEmptyModelOutputError(config, usage, finishReason));
  }

  return {
    output: String(output || "").trim(),
    usage,
    finishReason,
    latencyMs: Date.now() - startedAt
  };
}

function extractModelOutput(data) {
  const messageContent = data?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text || part?.content || part?.value || "";
      })
      .join("");
  }
  return data?.choices?.[0]?.text || data?.output_text || data?.raw || "";
}

function buildEmptyModelOutputError(config, usage, finishReason) {
  const maxParam = resolveMaxTokensParam(config);
  const maxTokens = Number(config.maxTokens || 4096);
  const effort = normalizeReasoningEffort(config.reasoningEffort);
  const outputTokens = usage?.outputTokens ?? "-";
  const reasoningTokens = usage?.reasoningTokens ?? "-";
  const finish = finishReason ? `finish_reason=${finishReason}，` : "";
  return [
    `模型返回了空的可见输出，${finish}${maxParam}=${maxTokens}，output_tokens=${outputTokens}，reasoning_tokens=${reasoningTokens}。`,
    "如果使用 GPT-5.5 的 high/xhigh reasoning，最大输出 tokens 会同时消耗隐藏推理 token；当前预算可能被推理过程耗尽。",
    "请把“最大输出 tokens”提高到至少 16000；xhigh 建议 32000 或更高，或降低 reasoning effort 后重试。"
  ].join("");
}

function postJsonViaHttpProxy(requestUrl, proxyUrl, headers, body, timeoutMs) {
  const target = new URL(requestUrl);
  const proxy = new URL(proxyUrl);
  const protocol = proxy.protocol.toLowerCase();
  if (!["http:", "https:"].includes(protocol)) {
    throw new Error(`当前仅支持 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890；暂不支持 ${proxy.protocol}`);
  }

  if (target.protocol === "https:") {
    return postHttpsJsonViaConnectProxy(target, proxy, headers, body, timeoutMs);
  }
  if (target.protocol === "http:") {
    return postHttpJsonViaForwardProxy(target, proxy, headers, body, timeoutMs);
  }
  throw new Error(`不支持的 Base URL 协议：${target.protocol}`);
}

function postHttpsJsonViaConnectProxy(target, proxy, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const connectOptions = {
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: proxyAuthorizationHeaders(proxy)
    };
    const connectRequest = (proxy.protocol === "https:" ? https : http).request(connectOptions);
    const timer = setTimeout(() => {
      connectRequest.destroy(new Error("代理连接超时"));
    }, timeoutMs);

    connectRequest.once("connect", (connectResponse, socket, head) => {
      if (connectResponse.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：HTTP ${connectResponse.statusCode}`));
        return;
      }
      if (head?.length) socket.unshift(head);
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname
      });
      sendJsonOverRequest(https, target, headers, body, timeoutMs, tlsSocket)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });

    connectRequest.once("timeout", () => connectRequest.destroy(new Error("代理连接超时")));
    connectRequest.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    connectRequest.end();
  });
}

function postHttpJsonViaForwardProxy(target, proxy, headers, body, timeoutMs) {
  if (proxy.protocol !== "http:") {
    throw new Error("HTTP 目标地址当前仅支持 http:// 代理");
  }
  return sendJsonOverRequest(
    http,
    target,
    {
      ...headers,
      ...proxyAuthorizationHeaders(proxy),
      Host: target.host
    },
    body,
    timeoutMs,
    null,
    {
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      path: target.toString()
    }
  );
}

function sendJsonOverRequest(module, target, headers, body, timeoutMs, socket, overrides = {}) {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(body);
    const request = module.request({
      host: overrides.host || target.hostname,
      port: overrides.port || Number(target.port || (target.protocol === "https:" ? 443 : 80)),
      method: "POST",
      path: overrides.path || `${target.pathname}${target.search}`,
      socket,
      createConnection: socket ? () => socket : undefined,
      headers: {
        ...headers,
        "Content-Length": Buffer.byteLength(bodyText),
        Accept: "application/json"
      },
      timeout: timeoutMs
    });

    let text = "";
    request.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode || 0, text });
      });
    });
    request.on("timeout", () => request.destroy(new Error("模型接口连接超时")));
    request.on("error", reject);
    request.end(bodyText);
  });
}

function proxyAuthorizationHeaders(proxy) {
  if (!proxy.username && !proxy.password) return {};
  const username = decodeURIComponent(proxy.username || "");
  const password = decodeURIComponent(proxy.password || "");
  return {
    "Proxy-Authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  };
}

function resolveMaxTokensParam(config) {
  const configured = String(config.maxTokensParam || "auto").trim();
  if (configured === "max_tokens" || configured === "max_completion_tokens") return configured;
  if (isOpenAiNewReasoningStyleModel(config)) {
    return "max_completion_tokens";
  }
  return "max_tokens";
}

function shouldSendTemperature(config) {
  const configured = String(config.temperatureParam || "auto").trim();
  if (configured === "send") return true;
  if (configured === "omit") return false;
  return !isOpenAiNewReasoningStyleModel(config);
}

function shouldSendReasoningEffort(config) {
  return normalizeReasoningEffort(config.reasoningEffort) !== "auto";
}

function isOpenAiNewReasoningStyleModel(config) {
  const model = String(config.model || "").toLowerCase();
  const baseUrl = String(config.baseUrl || "").toLowerCase();
  return baseUrl.includes("api.openai.com") && /^(gpt-5|o\d|o[1-9]|o[1-9]-)/.test(model);
}

function formatNetworkError(error, requestUrl) {
  const code = error?.cause?.code || error?.code || "";
  const hostname = error?.cause?.hostname || "";
  const target = hostname || safeUrlHost(requestUrl) || requestUrl;
  const message = error?.message || "网络请求失败";

  if (/代理|proxy/i.test(message)) {
    return `模型接口代理连接失败：${message}。请检查代理地址、端口、协议以及代理软件是否允许本地 Node 进程访问。`;
  }
  if (error?.name === "TimeoutError" || code === "UND_ERR_ABORTED") {
    return `模型接口连接超时：${target}。请检查网络、代理、Base URL 和 timeout 设置。`;
  }
  if (code === "ENOTFOUND") {
    return `模型接口 DNS 解析失败：${target}。当前后端环境无法解析该域名，请检查网络/DNS，或改用可访问的 OpenAI 兼容 Base URL。`;
  }
  if (code === "ECONNREFUSED") {
    return `模型接口拒绝连接：${target}。请检查 Base URL、端口或代理服务是否可用。`;
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `模型接口连接超时：${target}。请检查网络连通性或代理设置。`;
  }
  if (code && /CERT|TLS|SSL|VERIFY/i.test(code)) {
    return `模型接口 TLS/证书校验失败：${target} (${code})。请检查 HTTPS 证书或代理证书配置。`;
  }
  return `模型接口网络请求失败：${target}${code ? ` (${code})` : ""}，原始错误：${message}`;
}

function safeUrlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function stripJsonFence(text) {
  const value = String(text || "").trim();
  if (value.startsWith("```")) {
    return value
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }
  return value;
}

function parseFinalJson(text) {
  const cleaned = stripJsonFence(text);
  try {
    return normalizeFinalJson(JSON.parse(cleaned));
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return normalizeFinalJson(JSON.parse(cleaned.slice(first, last + 1)));
      } catch {
        // Fall through to fallback report.
      }
    }
  }

  return normalizeFinalJson({
    summary: truncateChars(cleaned.replace(/\s+/g, " "), 200),
    overall_conclusion: "终审模型未返回可解析 JSON，系统已保留原始终审输出供人工复核。",
    must_fix: ["请管理员检查 final_adjudication 提示词，要求模型严格返回 JSON。"],
    suggested_fix: [],
    text_and_figure_comments: [],
    compliance_risk: [],
    pre_submission_checklist: ["复核终审原始输出并人工确认报告内容。"],
    final_review_text: cleaned
  });
}

function normalizeFinalJson(value) {
  const result = {
    summary: "",
    overall_conclusion: "",
    must_fix: [],
    suggested_fix: [],
    text_and_figure_comments: [],
    compliance_risk: [],
    pre_submission_checklist: [],
    final_review_text: ""
  };

  for (const key of Object.keys(result)) {
    if (Array.isArray(result[key])) {
      result[key] = Array.isArray(value?.[key]) ? value[key] : value?.[key] ? [value[key]] : [];
    } else {
      result[key] = String(value?.[key] || "").trim();
    }
  }

  result.summary = result.summary.replace(/\s+/g, " ").slice(0, 200);
  return result;
}

function textRun(text, options = {}) {
  return new TextRun({
    text: String(text || ""),
    font: "Microsoft YaHei",
    size: options.size || 22,
    bold: options.bold || false,
    color: options.color
  });
}

function paragraph(text, options = {}) {
  return new Paragraph({
    heading: options.heading,
    alignment: options.alignment,
    spacing: { after: options.after ?? 160, before: options.before ?? 0 },
    children: [textRun(text, options)]
  });
}

function renderTextBlock(text, options = {}) {
  const rawLines = String(text || "无").split("\n");
  const lines = [];
  for (const line of rawLines) {
    const safeLine = line || " ";
    if (safeLine.length <= 900) {
      lines.push(safeLine);
      continue;
    }
    for (let i = 0; i < safeLine.length; i += 900) {
      lines.push(safeLine.slice(i, i + 900));
    }
  }
  return lines.map((line) => paragraph(line, options));
}

function formatItem(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item ?? "");
  const parts = [];
  if (item.priority) parts.push(`优先级：${item.priority}`);
  if (item.title) parts.push(`问题：${item.title}`);
  if (item.detail) parts.push(`说明：${item.detail}`);
  if (item.suggestion) parts.push(`建议：${item.suggestion}`);
  const remaining = Object.entries(item)
    .filter(([key]) => !["priority", "title", "detail", "suggestion"].includes(key))
    .map(([key, value]) => `${key}：${typeof value === "object" ? JSON.stringify(value) : value}`);
  return [...parts, ...remaining].join("；") || JSON.stringify(item);
}

function renderList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return [paragraph("无")];
  }
  return items.flatMap((item, index) => renderTextBlock(`${index + 1}. ${formatItem(item)}`));
}

async function generateReport(task) {
  const finalJson = task.finalJson || {};
  const reportStatus = task.status === "docx_generating" ? "succeeded" : task.status;
  const children = [
    paragraph("投稿前预审质控报告与修改意见", {
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      size: 32,
      bold: true,
      after: 360
    }),
    paragraph("一、文稿基本信息", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    paragraph(`任务 ID：${task.id}`),
    paragraph(`原始文件名：${task.originalFilename}`),
    paragraph(`任务状态：${STATUS_TEXT[reportStatus] || reportStatus}`),
    paragraph(`创建时间：${task.createdAt}`),
    paragraph(`完成时间：${task.updatedAt}`),
    paragraph("二、客户信息", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderTextBlock(task.customerInfo || "未填写"),
    paragraph("三、总体预审结论", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderTextBlock(finalJson.overall_conclusion),
    paragraph("四、200字以内摘要", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderTextBlock(finalJson.summary),
    paragraph("五、必须修改问题", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderList(finalJson.must_fix),
    paragraph("六、建议修改问题", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderList(finalJson.suggested_fix),
    paragraph("七、正文 / 图表修改意见", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderList(finalJson.text_and_figure_comments),
    paragraph("八、合规与风险提示", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderList(finalJson.compliance_risk),
    paragraph("九、投稿前检查清单", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderList(finalJson.pre_submission_checklist),
    paragraph("十、完整报告正文", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 }),
    ...renderTextBlock(finalJson.final_review_text),
    paragraph("十一、附录：GPT 预审组分项意见", { heading: HeadingLevel.HEADING_1, bold: true, size: 28 })
  ];

  for (const [index, stage] of (task.stageOutputs || []).entries()) {
    children.push(paragraph(`${index + 1}. ${stage.title}`, { heading: HeadingLevel.HEADING_2, bold: true, size: 24 }));
    children.push(paragraph(`stage：${stage.stage}`));
    children.push(paragraph(`model：${stage.model || ""}`));
    children.push(paragraph(`global_prompt_id：${stage.global_prompt_id || ""}`));
    children.push(paragraph(`global_prompt_version：${stage.global_prompt_version || ""}`));
    children.push(paragraph(`prompt_id：${stage.prompt_id || ""}`));
    children.push(paragraph(`prompt_version：${stage.prompt_version || ""}`));
    children.push(paragraph(`token input / output：${stage.tokens?.inputTokens ?? "-"} / ${stage.tokens?.outputTokens ?? "-"}`));
    children.push(paragraph(`reasoning tokens：${stage.tokens?.reasoningTokens ?? "-"}`));
    children.push(paragraph(`finish_reason：${stage.finishReason ?? "-"}`));
    children.push(paragraph(`latency：${stage.latencyMs ?? "-"} ms`));
    children.push(...renderTextBlock(stage.output || "无"));
  }

  const doc = new Document({
    creator: "SCI Pre-submission Review System",
    title: "投稿前预审质控报告与修改意见",
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.PORTRAIT },
            margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 }
          }
        },
        children
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  const reportPath = path.join(REPORT_DIR, `${task.id}_投稿前预审质控报告与修改意见.docx`);
  await fsp.writeFile(reportPath, buffer);
  return reportPath;
}

function ensureNotCancelled(task) {
  if (task.status === "cancelled" || task.cancelRequested) {
    task.status = "cancelled";
    task.updatedAt = nowIso();
    throw new Error("__CANCELLED__");
  }
}

async function processTask(taskId) {
  const task = findTask(taskId);
  if (!task || task.status === "cancelled") return;

  try {
    task.error = "";
    task.stageOutputs = [];
    task.finalJson = null;
    task.summary = "";
    pushProgress(task, "parsing", "开始解析 Word 文稿");
    await saveDb();

    const manuscriptText = await parseManuscript(task);
    task.parsedCharCount = manuscriptText.length;
    ensureNotCancelled(task);

    const globalPrompt = getPublishedPrompt(GLOBAL_STAGE.key);
    const config = getEnabledConfig();
    if (!config) {
      task.manualMode = true;
      task.manualReason = "后台尚未启用 OpenAI 兼容 API 配置，任务已进入人工代跑模式";
      pushProgress(task, "manual_stage_pending", "已生成可下载的五阶段人工预审材料");
      await saveDb();
      return;
    }

    pushProgress(task, "stage1_running", "开始执行五阶段固定提示词预审");
    await saveDb();

    for (const stage of REVIEW_STAGES) {
      ensureNotCancelled(task);
      const prompt = getPublishedPrompt(stage.key);
      const result = await callChatModel(config, buildSystemPrompt(globalPrompt.content, prompt.content), buildStageUserInput(task, manuscriptText));
      task.stageOutputs.push({
        stage: stage.key,
        title: stage.title,
        model: config.model,
        prompt_id: prompt.id,
        prompt_version: prompt.version,
        global_prompt_id: globalPrompt.id,
        global_prompt_version: globalPrompt.version,
        tokens: result.usage,
        finishReason: result.finishReason,
        latencyMs: result.latencyMs,
        output: result.output,
        createdAt: nowIso()
      });
      task.updatedAt = nowIso();
      await saveDb();
    }

    ensureNotCancelled(task);
    pushProgress(task, "stage2_running", "开始执行 GPT 裁决者终审");
    await saveDb();

    const finalPrompt = getPublishedPrompt(FINAL_STAGE.key);
    const finalResult = await callChatModel(config, buildSystemPrompt(globalPrompt.content, finalPrompt.content), buildFinalUserInput(task, manuscriptText, task.stageOutputs));
    task.finalOutput = {
      stage: FINAL_STAGE.key,
      title: FINAL_STAGE.title,
      model: config.model,
      prompt_id: finalPrompt.id,
      prompt_version: finalPrompt.version,
      global_prompt_id: globalPrompt.id,
      global_prompt_version: globalPrompt.version,
      tokens: finalResult.usage,
      finishReason: finalResult.finishReason,
      latencyMs: finalResult.latencyMs,
      output: finalResult.output,
      createdAt: nowIso()
    };
    task.finalJson = parseFinalJson(finalResult.output);
    task.summary = task.finalJson.summary;
    await saveDb();

    ensureNotCancelled(task);
    pushProgress(task, "docx_generating", "开始生成 Word 质控报告");
    await saveDb();

    task.reportPath = await generateReport(task);
    pushProgress(task, "succeeded", "预审完成，可下载报告");
    delete task.cancelRequested;
    await saveDb();
  } catch (error) {
    if (error.message === "__CANCELLED__") {
      task.status = "cancelled";
      task.error = "";
      task.updatedAt = nowIso();
    } else {
      task.status = "failed";
      task.error = error.message || "任务执行失败";
      task.updatedAt = nowIso();
      task.progressLog = task.progressLog || [];
      task.progressLog.push({
        status: "failed",
        statusText: STATUS_TEXT.failed,
        message: task.error,
        time: task.updatedAt
      });
    }
    await saveDb();
  }
}

function enqueueTask(taskId) {
  const task = findTask(taskId);
  if (!task) return;
  if (task.status !== "queued") {
    task.status = "queued";
    task.updatedAt = nowIso();
  }
  runWorker().catch((error) => {
    console.error("Task worker failed:", error);
  });
}

async function runWorker() {
  if (activeWorker) return;
  activeWorker = true;
  try {
    while (true) {
      const next = db.tasks.find((task) => task.status === "queued");
      if (!next) return;
      await processTask(next.id);
    }
  } finally {
    activeWorker = false;
  }
}

function buildStageOutputText(task) {
  const lines = [
    `任务 ID：${task.id}`,
    `原始文件名：${task.originalFilename}`,
    `任务状态：${STATUS_TEXT[task.status] || task.status} (${task.status})`,
    `导出时间：${nowIso()}`,
    ""
  ];

  for (const item of task.stageOutputs || []) {
    lines.push("=".repeat(72));
    lines.push(`阶段中文标题：${item.title}`);
    lines.push(`stage 英文字段：${item.stage}`);
    lines.push(`model：${item.model || ""}`);
    lines.push(`global_prompt_id：${item.global_prompt_id || ""}`);
    lines.push(`global_prompt_version：${item.global_prompt_version || ""}`);
    lines.push(`prompt_id：${item.prompt_id || ""}`);
    lines.push(`prompt_version：${item.prompt_version || ""}`);
    lines.push(`token input / output：${item.tokens?.inputTokens ?? "-"} / ${item.tokens?.outputTokens ?? "-"}`);
    lines.push(`reasoning tokens：${item.tokens?.reasoningTokens ?? "-"}`);
    lines.push(`finish_reason：${item.finishReason ?? "-"}`);
    lines.push(`latency：${item.latencyMs ?? "-"} ms`);
    lines.push("完整输出内容：");
    lines.push(item.output || "");
    lines.push("");
  }

  return lines.join("\n");
}

async function writeStageOutputFile(task) {
  const exportPath = path.join(STAGE_OUTPUT_DIR, `${task.id}_五阶段独立审稿输出.txt`);
  await fsp.writeFile(exportPath, buildStageOutputText(task));
  return exportPath;
}

function setDownloadHeaders(res, filename, contentType) {
  const asciiFallback = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, "%2A");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${asciiFallback}`);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}_${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

async function bootstrap() {
  await ensureDirs();
  masterKey = await loadMasterKey();
  db = await loadDb();
  await saveDb();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(PUBLIC_DIR));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, time: nowIso() });
  });

  app.post("/api/v1/review-tasks", upload.single("file"), async (req, res) => {
    try {
      validateUploadFile(req.file);
      const task = {
        id: crypto.randomUUID(),
        originalFilename: cleanFilename(req.file.originalname),
        storedFilename: req.file.filename,
        uploadPath: req.file.path,
        customerInfo: String(req.body.customerInfo || "").trim(),
        status: "queued",
        summary: "",
        error: "",
        stageOutputs: [],
        progressLog: [
          {
            status: "queued",
            statusText: STATUS_TEXT.queued,
            message: "任务已提交，等待处理",
            time: nowIso()
          }
        ],
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      db.tasks.unshift(task);
      await saveDb();
      enqueueTask(task.id);
      res.status(201).json(toPublicTask(task));
    } catch (error) {
      if (req.file?.path) {
        await fsp.rm(req.file.path, { force: true });
      }
      jsonError(res, 400, error.message || "上传失败");
    }
  });

  app.get("/api/v1/review-tasks/:taskId", (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    return res.json(toPublicTask(task));
  });

  app.get("/api/v1/review-tasks/:taskId/report", async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    if (task.status !== "succeeded" || !task.reportPath) return jsonError(res, 400, "报告尚未生成");
    setDownloadHeaders(res, "投稿前预审质控报告与修改意见.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return res.sendFile(path.resolve(task.reportPath));
  });

  app.post("/api/v1/admin/login", (req, res) => {
    const { username, password } = req.body || {};
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return jsonError(res, 401, "用户名或密码错误");
    }
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.set(token, { createdAt: nowIso(), lastSeenAt: nowIso() });
    res.setHeader("Set-Cookie", `admin_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    return res.json({ ok: true });
  });

  app.post("/api/v1/admin/logout", requireAdmin, (req, res) => {
    const token = getCookie(req, "admin_token");
    if (token) adminSessions.delete(token);
    res.setHeader("Set-Cookie", "admin_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return res.json({ ok: true });
  });

  app.get("/api/v1/admin/me", requireAdmin, (_req, res) => {
    res.json({ username: ADMIN_USERNAME });
  });

  app.get("/api/v1/admin/api-configs", requireAdmin, (_req, res) => {
    res.json(db.apiConfigs.map(toPublicConfig));
  });

  app.post("/api/v1/admin/api-configs", requireAdmin, async (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.baseUrl || !body.apiKey || !body.model) {
      return jsonError(res, 400, "配置名称、Base URL、API Key、模型名均必填");
    }
    const now = nowIso();
    const enabled = Boolean(body.enabled);
    if (enabled) db.apiConfigs.forEach((item) => (item.enabled = false));
    const config = {
      id: crypto.randomUUID(),
      name: String(body.name).trim(),
      baseUrl: String(body.baseUrl).trim(),
      proxyUrl: normalizeProxyUrl(body.proxyUrl),
      apiKeyEnc: encryptText(String(body.apiKey)),
      model: String(body.model).trim(),
      timeout: Number(body.timeout || 120000),
      temperature: Number(body.temperature ?? 0.2),
      temperatureParam: normalizeTemperatureParam(body.temperatureParam),
      reasoningEffort: normalizeReasoningEffort(body.reasoningEffort),
      maxTokens: Number(body.maxTokens || 4096),
      maxTokensParam: normalizeMaxTokensParam(body.maxTokensParam),
      enabled,
      createdAt: now,
      updatedAt: now
    };
    db.apiConfigs.push(config);
    await saveDb();
    res.status(201).json(toPublicConfig(config));
  });

  app.put("/api/v1/admin/api-configs/:configId", requireAdmin, async (req, res) => {
    const config = db.apiConfigs.find((item) => item.id === req.params.configId);
    if (!config) return jsonError(res, 404, "API 配置不存在");
    const body = req.body || {};
    for (const key of ["name", "baseUrl", "model"]) {
      if (body[key] !== undefined) config[key] = String(body[key]).trim();
    }
    if (body.proxyUrl !== undefined) config.proxyUrl = normalizeProxyUrl(body.proxyUrl);
    if (body.apiKey) config.apiKeyEnc = encryptText(String(body.apiKey));
    if (body.timeout !== undefined) config.timeout = Number(body.timeout);
    if (body.temperature !== undefined) config.temperature = Number(body.temperature);
    if (body.temperatureParam !== undefined) config.temperatureParam = normalizeTemperatureParam(body.temperatureParam);
    if (body.reasoningEffort !== undefined) config.reasoningEffort = normalizeReasoningEffort(body.reasoningEffort);
    if (body.maxTokens !== undefined) config.maxTokens = Number(body.maxTokens);
    if (body.maxTokensParam !== undefined) config.maxTokensParam = normalizeMaxTokensParam(body.maxTokensParam);
    if (body.enabled !== undefined) {
      if (body.enabled) db.apiConfigs.forEach((item) => (item.enabled = false));
      config.enabled = Boolean(body.enabled);
    }
    config.updatedAt = nowIso();
    await saveDb();
    res.json(toPublicConfig(config));
  });

  app.post("/api/v1/admin/api-configs/:configId/enable", requireAdmin, async (req, res) => {
    const config = db.apiConfigs.find((item) => item.id === req.params.configId);
    if (!config) return jsonError(res, 404, "API 配置不存在");
    db.apiConfigs.forEach((item) => (item.enabled = false));
    config.enabled = true;
    config.updatedAt = nowIso();
    await saveDb();
    res.json(toPublicConfig(config));
  });

  app.post("/api/v1/admin/api-configs/:configId/test", requireAdmin, async (req, res) => {
    const config = db.apiConfigs.find((item) => item.id === req.params.configId);
    if (!config) return jsonError(res, 404, "API 配置不存在");
    try {
      const result = await callChatModel(config, "你是连接测试助手。", "请只回复：连接成功");
      res.json({ ok: true, latencyMs: result.latencyMs, output: result.output });
    } catch (error) {
      jsonError(res, 400, error.message || "连接测试失败");
    }
  });

  app.get("/api/v1/admin/prompts", requireAdmin, (_req, res) => {
    const orderedStages = [
      ...PROMPT_STAGES.map((item) => item.key),
      ...Object.keys(db.prompts).filter((stage) => !PROMPT_STAGES.some((item) => item.key === stage))
    ];
    const list = orderedStages.map((stage) => {
      const versions = db.prompts[stage] || [];
      const current = versions.find((item) => item.status === "published") || null;
      return {
        stage,
        title: current?.title || getPromptTitle(stage),
        current,
        versions: versions.length
      };
    });
    res.json(list);
  });

  app.get("/api/v1/admin/prompts/:stage", requireAdmin, (req, res) => {
    const versions = db.prompts[req.params.stage];
    if (!versions) return jsonError(res, 404, "提示词调用点不存在");
    res.json(versions.slice().sort((a, b) => b.version - a.version));
  });

  app.post("/api/v1/admin/prompts/:stage/drafts", requireAdmin, async (req, res) => {
    const versions = db.prompts[req.params.stage];
    if (!versions) return jsonError(res, 404, "提示词调用点不存在");
    const content = String(req.body?.content || "").trim();
    if (!content) return jsonError(res, 400, "提示词内容不能为空");
    const title = versions[0]?.title || getPromptTitle(req.params.stage);
    const draft = {
      id: crypto.randomUUID(),
      stage: req.params.stage,
      title,
      version: nextPromptVersion(req.params.stage),
      status: "draft",
      content,
      createdAt: nowIso(),
      publishedAt: null
    };
    versions.push(draft);
    await saveDb();
    res.status(201).json(draft);
  });

  app.post("/api/v1/admin/prompts/:stage/:promptId/publish", requireAdmin, async (req, res) => {
    const versions = db.prompts[req.params.stage];
    if (!versions) return jsonError(res, 404, "提示词调用点不存在");
    const prompt = versions.find((item) => item.id === req.params.promptId);
    if (!prompt) return jsonError(res, 404, "提示词版本不存在");
    versions.forEach((item) => {
      if (item.status === "published") item.status = "archived";
    });
    prompt.status = "published";
    prompt.publishedAt = nowIso();
    await saveDb();
    res.json(prompt);
  });

  app.post("/api/v1/admin/prompts/:stage/:promptId/rollback", requireAdmin, async (req, res) => {
    const versions = db.prompts[req.params.stage];
    if (!versions) return jsonError(res, 404, "提示词调用点不存在");
    const source = versions.find((item) => item.id === req.params.promptId);
    if (!source) return jsonError(res, 404, "提示词版本不存在");
    versions.forEach((item) => {
      if (item.status === "published") item.status = "archived";
    });
    const rollback = {
      id: crypto.randomUUID(),
      stage: req.params.stage,
      title: source.title,
      version: nextPromptVersion(req.params.stage),
      status: "published",
      content: source.content,
      createdAt: nowIso(),
      publishedAt: nowIso(),
      rollbackFrom: source.id
    };
    versions.push(rollback);
    await saveDb();
    res.json(rollback);
  });

  app.delete("/api/v1/admin/prompts/:stage/:promptId", requireAdmin, async (req, res) => {
    const versions = db.prompts[req.params.stage];
    if (!versions) return jsonError(res, 404, "提示词调用点不存在");
    const index = versions.findIndex((item) => item.id === req.params.promptId);
    if (index === -1) return jsonError(res, 404, "提示词版本不存在");
    const prompt = versions[index];
    if (prompt.status === "published") {
      return jsonError(res, 400, "当前已发布版本不能删除，请先发布其他版本或使用回滚");
    }
    if (versions.length <= 1) {
      return jsonError(res, 400, "至少保留一个提示词版本");
    }
    const [deleted] = versions.splice(index, 1);
    await saveDb();
    res.json({ ok: true, deletedId: deleted.id });
  });

  app.get("/api/v1/admin/review-tasks", requireAdmin, (_req, res) => {
    res.json(db.tasks.map(toAdminTask));
  });

  app.get("/api/v1/admin/review-tasks/:taskId", requireAdmin, (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    res.json({
      ...toAdminTask(task),
      stageOutputs: task.stageOutputs || [],
      finalOutput: task.finalOutput || null
    });
  });

  app.post("/api/v1/admin/review-tasks/:taskId/retry", requireAdmin, async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    if (!["failed", "cancelled", "succeeded"].includes(task.status)) {
      return jsonError(res, 400, "仅已完成、失败或已取消任务支持重试");
    }
    task.status = "queued";
    task.error = "";
    task.summary = "";
    task.stageOutputs = [];
    task.finalJson = null;
    task.finalOutput = null;
    task.reportPath = "";
    delete task.manualMode;
    delete task.manualReason;
    delete task.cancelRequested;
    pushProgress(task, "queued", "管理员已触发重试");
    await saveDb();
    enqueueTask(task.id);
    res.json(toAdminTask(task));
  });

  app.post("/api/v1/admin/review-tasks/:taskId/manual/start", requireAdmin, async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    if (!["failed", "cancelled", "manual_stage_pending", "manual_final_pending"].includes(task.status)) {
      return jsonError(res, 400, "仅失败、已取消或人工代跑中的任务可转入人工代跑");
    }
    await parseManuscript(task);
    task.manualMode = true;
    task.manualReason = "管理员手动转入人工代跑模式";
    task.error = "";
    task.summary = "";
    task.stageOutputs = [];
    task.finalJson = null;
    task.finalOutput = null;
    task.reportPath = "";
    delete task.cancelRequested;
    pushProgress(task, "manual_stage_pending", "已生成可下载的五阶段人工预审材料");
    await saveDb();
    res.json(toAdminTask(task));
  });

  app.post("/api/v1/admin/review-tasks/:taskId/cancel", requireAdmin, async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    if (["succeeded", "failed", "cancelled"].includes(task.status)) {
      return jsonError(res, 400, "当前任务状态不支持取消");
    }
    task.cancelRequested = true;
    task.status = "cancelled";
    task.updatedAt = nowIso();
    task.progressLog = task.progressLog || [];
    task.progressLog.push({
      status: "cancelled",
      statusText: STATUS_TEXT.cancelled,
      message: "管理员已取消任务",
      time: task.updatedAt
    });
    await saveDb();
    res.json(toAdminTask(task));
  });

  app.get("/api/v1/admin/review-tasks/:taskId/manual-stage-inputs/download", requireAdmin, async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    const manuscriptText = await parseManuscript(task);
    const content = buildManualStageInputText(task, manuscriptText);
    setDownloadHeaders(res, `${task.id}_人工代跑_五阶段预审材料.txt`, "text/plain; charset=utf-8");
    res.send(content);
  });

  app.post("/api/v1/admin/review-tasks/:taskId/manual-stage-outputs", requireAdmin, async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    const outputs = req.body?.outputs || {};
    const model = String(req.body?.model || "manual").trim() || "manual";
    const globalPrompt = getPublishedPrompt(GLOBAL_STAGE.key);
    const missingStage = REVIEW_STAGES.find((stage) => !String(outputs[stage.key] || "").trim());
    if (missingStage) return jsonError(res, 400, `请填写${missingStage.title}输出`);

    const stageOutputs = REVIEW_STAGES.map((stage) => {
      const output = String(outputs[stage.key] || "").trim();
      const prompt = getPublishedPrompt(stage.key);
      return {
        stage: stage.key,
        title: stage.title,
        model,
        prompt_id: prompt.id,
        prompt_version: prompt.version,
        global_prompt_id: globalPrompt.id,
        global_prompt_version: globalPrompt.version,
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null },
        finishReason: "manual",
        latencyMs: null,
        output,
        manual: true,
        createdAt: nowIso()
      };
    });

    task.manualMode = true;
    task.stageOutputs = stageOutputs;
    task.finalJson = null;
    task.finalOutput = null;
    task.summary = "";
    task.error = "";
    task.reportPath = "";
    pushProgress(task, "manual_final_pending", "五阶段人工输出已保存，可下载终审材料");
    await saveDb();
    res.json(toAdminTask(task));
  });

  app.get("/api/v1/admin/review-tasks/:taskId/manual-final-input/download", requireAdmin, async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    const manuscriptText = await parseManuscript(task);
    const content = buildManualFinalInputText(task, manuscriptText);
    setDownloadHeaders(res, `${task.id}_人工代跑_终审材料.txt`, "text/plain; charset=utf-8");
    res.send(content);
  });

  app.post("/api/v1/admin/review-tasks/:taskId/manual-final-output", requireAdmin, async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    const output = typeof req.body?.output === "object" ? JSON.stringify(req.body.output) : String(req.body?.output || "").trim();
    if (!output) return jsonError(res, 400, "请填写终审 JSON / 输出");
    if ((task.stageOutputs || []).length < REVIEW_STAGES.length) {
      return jsonError(res, 400, "请先提交完整五阶段人工预审输出");
    }

    const globalPrompt = getPublishedPrompt(GLOBAL_STAGE.key);
    const finalPrompt = getPublishedPrompt(FINAL_STAGE.key);
    task.finalOutput = {
      stage: FINAL_STAGE.key,
      title: FINAL_STAGE.title,
      model: String(req.body?.model || "manual").trim() || "manual",
      prompt_id: finalPrompt.id,
      prompt_version: finalPrompt.version,
      global_prompt_id: globalPrompt.id,
      global_prompt_version: globalPrompt.version,
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null },
      finishReason: "manual",
      latencyMs: null,
      output,
      manual: true,
      createdAt: nowIso()
    };
    task.finalJson = parseFinalJson(output);
    task.summary = task.finalJson.summary;
    task.error = "";
    task.reportPath = "";
    pushProgress(task, "docx_generating", "开始根据人工终审输出生成 Word 质控报告");
    await saveDb();

    task.reportPath = await generateReport(task);
    pushProgress(task, "succeeded", "人工代跑完成，可下载报告");
    await saveDb();
    res.json(toAdminTask(task));
  });

  app.get("/api/v1/admin/review-tasks/:taskId/stage-outputs/download", requireAdmin, async (req, res) => {
    const task = findTask(req.params.taskId);
    if (!task) return jsonError(res, 404, "任务不存在");
    const exportPath = await writeStageOutputFile(task);
    setDownloadHeaders(res, `${task.id}_五阶段独立审稿输出.txt`, "text/plain; charset=utf-8");
    res.sendFile(path.resolve(exportPath));
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return jsonError(res, 400, `文件过大，当前限制为 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
      }
      return jsonError(res, 400, error.message);
    }
    console.error(error);
    return jsonError(res, 500, error.message || "服务器错误");
  });

  app.listen(PORT, () => {
    console.log(`SCI pre-submission review system running at http://localhost:${PORT}`);
  });

  runWorker().catch((error) => console.error("Initial worker failed:", error));
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
