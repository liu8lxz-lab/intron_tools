#!/usr/bin/env node
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_ENCODED_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_PROFILE_DIR = path.join(ROOT, "storage", "browser-profiles", "chatgpt-web-runner");
const LEGACY_PROFILE_DIR = path.join(LEGACY_ENCODED_ROOT, "storage", "browser-profiles", "chatgpt-web-runner");
const DEFAULT_TARGET_URL = "https://chatgpt.com/";
const DEFAULT_TARGET_MODEL = "GPT-5.5";
const DEFAULT_INTELLIGENCE_LEVEL = "高级";
const INTELLIGENCE_LEVELS = ["极速", "均衡", "高级", "超高", "专业"];
const PRODUCTION_INTELLIGENCE_LEVELS = ["高级", "超高", "专业"];
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONTEXT_BUILDER = path.join(ROOT, "skills", "sci-pre-review-runner", "scripts", "build_review_context.mjs");
const STAGE_ORDER = [
  "topic_innovation_rationale",
  "statistical_details",
  "fulltext_consistency_numerical_audit",
  "figure_table_quality",
  "misc_compliance_expression",
  "issue_list_cleaner",
  "adjudicator_parameters"
];
const AGENT_STAGES = STAGE_ORDER.slice(0, 5);
const WORD_STAGES = new Set([
  ...AGENT_STAGES,
  "adjudicator_parameters"
]);
const JSON_REQUIRED_STAGES = new Set();
const WEB_ONLY_STAGES = new Set([
  ...AGENT_STAGES,
  "adjudicator_parameters"
]);
const DIMENSION_TITLES = {
  topic_innovation_rationale: "选题创新及合理性",
  statistical_details: "统计学细节",
  fulltext_consistency_numerical_audit: "全文一致性与数值审计",
  figure_table_quality: "图表质量与呈现完整性",
  misc_compliance_expression: "杂项、合规与表达"
};
const SCORE_DIMENSIONS = [
  { key: "topic_value", title: "选题价值" },
  { key: "study_design", title: "研究设计" },
  { key: "statistical_analysis", title: "统计分析" },
  { key: "data_credibility", title: "数据可信" },
  { key: "figure_presentation", title: "图表呈现" },
  { key: "writing_expression", title: "写作表达" }
];
const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"];

function parseScoreNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (!text) return null;
  const fraction = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(10|100)\b/);
  if (fraction) {
    const score = Number(fraction[1]);
    const scale = Number(fraction[2]);
    if (Number.isFinite(score)) return scale === 10 ? score * 10 : score;
  }
  const number = Number(text.replace(/分$/, ""));
  return Number.isFinite(number) ? number : null;
}

function ensureLocalhostNoProxy() {
  const required = ["127.0.0.1", "localhost", "::1"];
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const existing = String(process.env[key] || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const host of required) {
      if (!existing.includes(host)) existing.push(host);
    }
    process.env[key] = existing.join(",");
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete process.env[key];
  }
}

ensureLocalhostNoProxy();

let chromiumPromise = null;

async function getChromium() {
  if (!chromiumPromise) {
    chromiumPromise = import("playwright-core").then((mod) => mod.chromium);
  }
  return chromiumPromise;
}

function usage() {
  return `Usage:
  npm run web-review:browser -- prepare-login [--profile-dir DIR] [--target-url URL]
  npm run web-review:browser -- prepare-login-manual [--profile-dir DIR] [--target-url URL]
  npm run web-review:browser -- prepare-cdp [--profile-dir DIR] [--target-url URL] [--cdp-port PORT]
  npm run web-review:browser -- migrate-legacy-profile [--profile-dir DIR]
  npm run web-review:browser -- select-intelligence --cdp --intelligence-level 高级|超高|专业 [--profile-dir DIR] [--target-url URL]
  npm run web-review:browser -- preflight [--profile-dir DIR] [--target-url URL] [--target-model TEXT] [--intelligence-level 高级|超高|专业] [--live-smoke] [--cdp]
  npm run web-review:browser -- doctor [--profile-dir DIR] [--target-url URL] [--target-model TEXT] [--intelligence-level 高级|超高|专业] [--cdp]
  npm run web-review:browser -- run --manuscript FILE --customer-info TEXT --prompts SNAPSHOT_JSON [--run-dir DIR] [--target-model TEXT] [--intelligence-level 高级|超高|专业] [--original-file-name NAME] [--cdp] [--upload-mode local|recent] [--cleaner local|web] [--manual-first-word-upload|--manual-word-upload]
  npm run web-review:browser -- resume --run-dir DIR [--from-stage STAGE] [--original-file-name NAME] [--cdp] [--intelligence-level 高级|超高|专业] [--upload-mode local|recent] [--cleaner local|web] [--manual-first-word-upload|--manual-word-upload]
  npm run web-review:browser -- package --run-dir DIR

Notes:
  - Uses a dedicated visible Chrome profile: storage/browser-profiles/chatgpt-web-runner
  - If ChatGPT blocks Playwright login with a human-verification page, prefer prepare-cdp.
  - CDP mode automatically adds localhost to NO_PROXY/no_proxy so local proxy settings do not intercept DevTools.
  - run/resume default to CDP unless --allow-persistent is passed.
  - Word attachment defaults to local upload. Use --upload-mode recent or --prefer-library to try recent/library first.
  - issue_list_cleaner defaults to web, so the published cleaner prompt is used. Use --cleaner local only as an explicit deterministic fallback.
  - Use --manual-first-word-upload or --manual-word-upload if ChatGPT web upload stalls under automation.
  - ChatGPT's current web UI uses 智能水平. Production runs accept 高级, 超高, or 专业; 极速/均衡 are blocked when detected.
  - Use select-intelligence to switch the dedicated Chrome page before doctor/run, for example: npm run web-review:browser -- select-intelligence --cdp --intelligence-level "超高".
  - migrate-legacy-profile only exists to repair old profiles created under paths with %20.
  - Does not use ChatGPT private APIs and does not read cookies/localStorage.
  - If browser automation cannot safely confirm an action, it records a fallback event and exits with next-step instructions.`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
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

function nowIso() {
  return new Date().toISOString();
}

function sha256(text) {
  const hash = crypto.createHash("sha256");
  if (Buffer.isBuffer(text)) hash.update(text);
  else hash.update(String(text || ""));
  return hash.digest("hex");
}

function ensureAbsolute(filePath) {
  return path.resolve(String(filePath || ""));
}

function normalizeIntelligenceLevel(value, fallback = null) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (/专业|pro|professional/.test(lower)) return "专业";
  if (/超高|ultra|max|maximum/.test(lower)) return "超高";
  if (/高级|advanced|high/.test(lower)) return "高级";
  if (/均衡|balanced|balance/.test(lower)) return "均衡";
  if (/极速|fast|quick|speed/.test(lower)) return "极速";
  return fallback;
}

function intelligenceLevelExplicit(args = {}) {
  return Boolean(args["intelligence-level"] || args["target-intelligence"]);
}

function requestedIntelligenceLevel(args = {}, metadata = {}) {
  return normalizeIntelligenceLevel(
    args["intelligence-level"] ||
      args["target-intelligence"] ||
      metadata.intelligence_level ||
      metadata.requested_intelligence_level ||
      args["target-model"] ||
      metadata.target_model,
    DEFAULT_INTELLIGENCE_LEVEL
  );
}

function allowedIntelligenceLevels(args = {}) {
  const requested = requestedIntelligenceLevel(args);
  return intelligenceLevelExplicit(args) ? [requested] : PRODUCTION_INTELLIGENCE_LEVELS;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, String(value || ""));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function profileAppearsOpen(profileDir) {
  const socketPath = path.join(profileDir, "SingletonSocket");
  try {
    const socketTarget = await fs.readlink(socketPath);
    return fssync.existsSync(socketTarget);
  } catch {
    return false;
  }
}

function cdpEndpoint(args = {}) {
  if (args["cdp-endpoint"]) return String(args["cdp-endpoint"]);
  const port = String(args["cdp-port"] || "9222");
  return `http://127.0.0.1:${port}`;
}

function wantsCdp(args = {}) {
  return Boolean(args.cdp || args["cdp-endpoint"] || args["cdp-port"]);
}

async function cdpAvailable(endpoint) {
  return Boolean(await cdpInfo(endpoint));
}

async function cdpInfo(endpoint) {
  const versionUrl = new URL("/json/version", endpoint).toString();
  try {
    const { stdout } = await execFileAsync("/usr/bin/curl", ["--noproxy", "*", "-fsS", versionUrl], {
      timeout: 3000,
      maxBuffer: 1024 * 1024
    });
    const json = JSON.parse(stdout);
    if (json?.webSocketDebuggerUrl && /^Chrome\//.test(String(json.Browser || ""))) return json;
  } catch {
    // Fall back to fetch below; curl may not exist in non-macOS environments.
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(versionUrl, { signal: controller.signal });
    if (!response.ok) return null;
    const json = await response.json();
    if (!json?.webSocketDebuggerUrl || !/^Chrome\//.test(String(json.Browser || ""))) return null;
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForCdp(endpoint, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const info = await cdpInfo(endpoint);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function stageFileName(stage, suffix) {
  return `${stage}.${suffix}`;
}

function runPaths(runDir) {
  return {
    runDir,
    context: path.join(runDir, "context.json"),
    prompts: path.join(runDir, "prompts"),
    raw: path.join(runDir, "raw"),
    rawCandidates: path.join(runDir, "raw_candidates"),
    json: path.join(runDir, "json"),
    screenshots: path.join(runDir, "screenshots"),
    outputs: path.join(runDir, "outputs"),
    state: path.join(runDir, "stage_state.json"),
    metadata: path.join(runDir, "runner_metadata.json")
  };
}

function defaultRunDir(manuscriptPath) {
  const stem = path.basename(manuscriptPath || "web-run").replace(/\.[^.]+$/, "");
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return path.join(ROOT, "storage", "web-review-runs", `${stamp}-${stem.slice(0, 24)}`);
}

async function initRunDirs(paths) {
  await Promise.all([
    ensureDir(paths.runDir),
    ensureDir(paths.prompts),
    ensureDir(paths.raw),
    ensureDir(paths.rawCandidates),
    ensureDir(paths.json),
    ensureDir(paths.screenshots),
    ensureDir(paths.outputs)
  ]);
}

async function loadMetadata(paths, defaults = {}) {
  const existing = await readJson(paths.metadata, null);
  if (existing) return existing;
  const finalMetadata = await readJson(path.join(paths.runDir, "runner_metadata.final.json"), null);
  if (finalMetadata) return finalMetadata;
  const partialMetadata = await readJson(path.join(paths.runDir, "runner_metadata.partial.json"), null);
  if (partialMetadata) return partialMetadata;
  return {
    runner: "web-browser",
    runner_engine: "playwright-cdp-dedicated-chrome",
    target_model: defaults.targetModel || DEFAULT_TARGET_MODEL,
    intelligence_level: defaults.intelligenceLevel || DEFAULT_INTELLIGENCE_LEVEL,
    allowed_intelligence_levels: defaults.allowedIntelligenceLevels || PRODUCTION_INTELLIGENCE_LEVELS,
    target_url: defaults.targetUrl || DEFAULT_TARGET_URL,
    authorization_mode: "task-level-preapproval",
    workflow_version: "v3-single-run",
    automation_mode: "auto-with-guided-fallback",
    started_at: nowIso(),
    completed_at: null,
    profile_dir: defaults.profileDir || DEFAULT_PROFILE_DIR,
    manuscript: defaults.manuscript || null,
    prompt_snapshot: defaults.prompts || null,
    preflight_results: null,
    conversations: [],
    pause_events: [],
    retries: [],
    format_repairs: [],
    clipboard_hashes: [],
    invalidations: [],
    local_projections: [],
    output_candidates: [],
    notes: []
  };
}

async function saveMetadata(paths, metadata) {
  await writeJson(paths.metadata, metadata);
}

function recordConversation(metadata, stage, patch) {
  const index = metadata.conversations.findIndex((item) => item.stage === stage);
  const next = {
    stage,
    run_number: 1,
    status: "pending",
    format_fix_count: 0,
    ...patch
  };
  if (index >= 0) metadata.conversations[index] = { ...metadata.conversations[index], ...next };
  else metadata.conversations.push(next);
}

function recordRetry(metadata, stage, action, error, status = "failed") {
  metadata.retries.push({
    time: nowIso(),
    stage,
    action,
    status,
    error: error?.message || String(error || "")
  });
}

function recordPause(metadata, stage, reason, detail) {
  metadata.pause_events.push({
    time: nowIso(),
    stage,
    reason,
    detail
  });
}

function jsonPathForStage(paths, stage) {
  if (stage === "issue_list_cleaner") return path.join(paths.json, "issue_list.json");
  if (stage === "adjudicator_parameters") return path.join(paths.json, "conclusion_parameters.json");
  return path.join(paths.json, stageFileName(stage, "json"));
}

function rawPathForStage(paths, stage) {
  return path.join(paths.raw, stageFileName(stage, "raw.txt"));
}

async function loadStageState(paths) {
  const state = await readJson(paths.state, {});
  return state && typeof state === "object" ? state : {};
}

async function saveStageState(paths, state) {
  await writeJson(paths.state, state);
}

async function hashExistingFiles(files) {
  const parts = [];
  for (const file of files) {
    if (!(await fileExists(file))) {
      parts.push(`${path.basename(file)}:missing`);
      continue;
    }
    const buffer = await fs.readFile(file);
    parts.push(`${path.basename(file)}:${sha256(buffer)}`);
  }
  return sha256(parts.join("\n"));
}

async function fileFingerprint(filePath) {
  if (!filePath || !(await fileExists(filePath))) return "missing";
  const stat = await fs.stat(filePath);
  return sha256(`${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`);
}

async function backupIfExists(filePath, reason = "invalidated") {
  if (!(await fileExists(filePath))) return null;
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const backupPath = `${filePath}.${reason}.${stamp}.bak`;
  await fs.rename(filePath, backupPath);
  return backupPath;
}

async function invalidateStageArtifacts(paths, metadata, stage, reason) {
  const files = [rawPathForStage(paths, stage), jsonPathForStage(paths, stage)];
  if (stage === "issue_list_cleaner") {
    files.push(
      path.join(paths.raw, "issue_list_cleaner.issue_list_txt.txt"),
      path.join(paths.raw, "issue_list_cleaner.issue_list_txt.cleaned.txt")
    );
  }
  if (stage === "adjudicator_parameters") {
    files.push(
      path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.txt"),
      path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.cleaned.txt")
    );
  }
  const backups = [];
  for (const file of files) {
    const backup = await backupIfExists(file, "invalidated");
    if (backup) backups.push({ file: path.resolve(file), backup: path.resolve(backup) });
  }
  if (backups.length) {
    metadata.invalidations = Array.isArray(metadata.invalidations) ? metadata.invalidations : [];
    metadata.invalidations.push({ time: nowIso(), stage, reason, backups });
  }
}

function stageRequiredOutputFiles(paths, stage) {
  const files = [rawPathForStage(paths, stage)];
  if (stage === "issue_list_cleaner") {
    files.push(
      path.join(paths.raw, "issue_list_cleaner.issue_list_txt.cleaned.txt")
    );
  }
  if (stage === "adjudicator_parameters") {
    files.push(
      path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.cleaned.txt")
    );
  }
  return files;
}

function stageObjectFromText(stage, text) {
  if (AGENT_STAGES.includes(stage)) {
    const jsonText = extractSection(String(text || ""), /(?:^|\n)\s*agent_report\s+JSON\s*:\s*/i);
    return extractBalancedJson(jsonText || text);
  }
  if (stage === "issue_list_cleaner") {
    const jsonText = extractSection(String(text || ""), /(?:^|\n)\s*issue_list\s+JSON\s*:\s*/i);
    return extractBalancedJson(jsonText || text);
  }
  if (stage === "adjudicator_parameters") {
    const jsonText = extractSection(String(text || ""), /(?:^|\n)\s*conclusion_parameters\s+JSON\s*:\s*/i);
    return extractBalancedJson(jsonText || text);
  }
  return extractBalancedJson(text);
}

function validateStageObject(stage, obj) {
  if (AGENT_STAGES.includes(stage)) {
    if (!Array.isArray(obj?.issues)) throw new Error(`${stage} agent_report JSON sidecar missing issues array`);
    return;
  }
  if (stage === "issue_list_cleaner") {
    if (!Array.isArray(obj?.issues)) throw new Error("issue_list JSON sidecar missing issues array");
    return;
  }
  if (stage === "adjudicator_parameters") {
    if (parseScoreNumber(obj?.overall_score) === null) throw new Error("conclusion_parameters JSON sidecar missing overall_score");
    const scores = Array.isArray(obj?.dimension_scores) ? obj.dimension_scores : [];
    const missing = SCORE_DIMENSIONS.filter((dimension) => {
      const found = scores.find((item) => {
        const key = String(item?.key || "").trim();
        const title = String(item?.title || item?.dimension || "").trim();
        return key === dimension.key || title === dimension.title;
      });
      return parseScoreNumber(found?.score) === null;
    });
    if (missing.length) throw new Error(`conclusion_parameters JSON sidecar missing six dimension_scores: ${missing.map((item) => item.title).join(", ")}`);
    return;
  }
}

function normalizeSeverity(value) {
  const text = String(value || "").toUpperCase();
  const match = text.match(/\bP[0-3]\b/);
  return match ? match[0] : "P3";
}

function sourceIssueId(issue, fallback) {
  const text = String(issue?.issue || issue?.title || "");
  const first = text.split("｜")[0]?.trim();
  if (/^[A-Z]\d+-\d+/.test(first)) return first;
  const narrative = String(issue?.issue_narrative || "");
  const match = narrative.match(/问题编号[:：]\s*([^；;\n]+)/);
  return match ? match[1].trim() : fallback;
}

function issueTitle(issue) {
  const text = String(issue?.issue || issue?.title || "").trim();
  return text || "未命名问题";
}

function localIssueText(issue, field, fallback = "") {
  return String(issue?.[field] || fallback || "").trim();
}

async function readAgentJsons(paths) {
  const reports = {};
  for (const stage of AGENT_STAGES) {
    const obj = await readJson(jsonPathForStage(paths, stage));
    validateStageObject(stage, obj);
    reports[stage] = obj;
  }
  return reports;
}

function buildLocalIssueList(agentJsons) {
  const severityCounts = Object.fromEntries(SEVERITY_ORDER.map((key) => [key, 0]));
  const issueDistribution = Object.fromEntries(AGENT_STAGES.map((stage) => [stage, 0]));
  const issues = [];
  for (const stage of AGENT_STAGES) {
    const stageIssues = Array.isArray(agentJsons[stage]?.issues) ? agentJsons[stage].issues : [];
    issueDistribution[stage] = stageIssues.length;
    for (const rawIssue of stageIssues) {
      const severity = normalizeSeverity(rawIssue?.severity);
      severityCounts[severity] += 1;
      const index = issues.length + 1;
      const originalId = sourceIssueId(rawIssue, `${stage}-${String(index).padStart(2, "0")}`);
      const evidence = localIssueText(rawIssue, "evidence");
      const narrative = localIssueText(rawIssue, "issue_narrative");
      issues.push({
        id: `IL-${String(index).padStart(3, "0")}`,
        severity,
        category: String(rawIssue?.category || stage),
        primary_dimension: DIMENSION_TITLES[stage] || stage,
        issue: issueTitle(rawIssue),
        evidence,
        location: localIssueText(rawIssue, "location"),
        explanation: evidence || narrative,
        submission_risk: localIssueText(rawIssue, "submission_risk"),
        recommendation: localIssueText(rawIssue, "recommendation"),
        source_agents: [stage],
        source_issue_ids: [originalId],
        issue_narrative: narrative,
        confidence: typeof rawIssue?.confidence === "number" ? rawIssue.confidence : rawIssue?.confidence ?? null
      });
    }
  }
  severityCounts.total = issues.length;
  return {
    schema_version: "v3.issue_list.local_deterministic.v1",
    issue_count: issues.length,
    severity_counts: severityCounts,
    issue_distribution: issueDistribution,
    issues
  };
}

function renderIssueListText(issueList) {
  const counts = issueList.severity_counts || {};
  const blocks = [
    "问题清单.txt",
    "",
    `问题总数：${issueList.issue_count || 0}`,
    `严重程度分布：P0=${counts.P0 || 0}；P1=${counts.P1 || 0}；P2=${counts.P2 || 0}；P3=${counts.P3 || 0}`
  ];
  for (const issue of issueList.issues || []) {
    blocks.push(
      "",
      `${issue.id}｜${issue.severity}｜${issue.primary_dimension || issue.category || ""}｜${issue.issue || ""}`,
      `依据：${issue.evidence || ""}`,
      `位置：${issue.location || ""}`,
      `问题说明：${issue.explanation || issue.evidence || issue.issue_narrative || ""}`,
      `低成本处理建议：${issue.recommendation || ""}`,
      `来源：${(issue.source_agents || []).join("；")}；原始问题ID：${(issue.source_issue_ids || []).join("；")}`,
      `问题叙述：${issue.issue_narrative || ""}`,
      `置信度：${issue.confidence ?? ""}`
    );
  }
  return blocks.join("\n").trim() + "\n";
}

async function validateIssueListGate(paths) {
  const issueText = await readIssueListText(paths);
  const issueCount = (issueText.match(/(?:清单序号|问题编号|编号)\s*[:：]\s*(?:Q|IL[-_]?)?\d+/gi) || []).length;
  if (!issueCount) throw new Error("问题清单.txt 未检测到问题编号条目");
  return {
    issueCount
  };
}

async function buildContext(paths, args) {
  if (await fileExists(paths.context)) return readJson(paths.context);
  const manuscript = ensureAbsolute(requireArg(args, "manuscript"));
  const customerInfo = requireArg(args, "customer-info");
  const prompts = ensureAbsolute(requireArg(args, "prompts"));
  const projectRoot = ensureAbsolute(args["project-root"] || ROOT);
  const childArgs = [
    CONTEXT_BUILDER,
    "--manuscript",
    manuscript,
    "--customer-info",
    customerInfo,
    "--project-root",
    projectRoot,
    "--prompts",
    prompts,
    "--format",
    "json"
  ];
  const { stdout } = await execFileAsync(process.execPath, childArgs, {
    cwd: ROOT,
    timeout: 120000,
    maxBuffer: 60 * 1024 * 1024
  });
  await writeText(paths.context, stdout);
  return JSON.parse(stdout);
}

function fullPrompt(systemPrompt, userPrompt) {
  return ["SYSTEM PROMPT:", systemPrompt || "", "", "USER PROMPT:", userPrompt || ""].join("\n").trimEnd() + "\n";
}

function stripRuntimeAdapterPrompt(promptText) {
  return String(promptText || "")
    .replace(/\n+【系统运行时适配层[\s\S]*$/i, "")
    .replace(/\n+---\s*\n+【程序运行时适配层[\s\S]*$/i, "")
    .replace(/\n+【程序运行时适配层[\s\S]*$/i, "")
    .replace(/\n+##\s*程序运行时适配层[\s\S]*$/i, "")
    .trim();
}

function labeledAgentReportsForCleaner(reports) {
  return AGENT_STAGES.map((stage, index) => [
    `agent${index + 1}.txt:`,
    reports[stage] || ""
  ].join("\n")).join("\n\n");
}

function compactIssueListForAdjudicator(issueList) {
  const source = issueList && typeof issueList === "object" && !Array.isArray(issueList) ? issueList : {};
  const issues = Array.isArray(source.issues) ? source.issues : [];
  return {
    schema_version: source.schema_version || "v3.issue_list.compact_anchor.v1",
    issue_count: source.issue_count ?? issues.length,
    severity_counts: source.severity_counts || {},
    issue_distribution: source.issue_distribution || {},
    issues: issues.map((issue) => ({
      id: issue.id || issue.issue_id || issue.issueId || "",
      severity: issue.severity || issue.level || "",
      category: issue.category || "",
      primary_dimension: issue.primary_dimension || issue.primaryDimension || issue.dimension || "",
      issue: issue.issue || issue.title || issue.problem || "",
      location: issue.location || issue.position || ""
    }))
  };
}

function promptManifest(stage, promptText) {
  return {
    stage,
    chars: [...promptText].length,
    bytes: Buffer.byteLength(promptText),
    sha256: sha256(promptText),
    created_at: nowIso()
  };
}

async function buildStagePrompt(paths, stage, context) {
  const promptPath = path.join(paths.prompts, stageFileName(stage, "prompt.txt"));
  const manifestPath = path.join(paths.prompts, stageFileName(stage, "prompt.json"));
  let promptText = "";
  if (AGENT_STAGES.includes(stage)) {
    const request = context.stageRequests.find((item) => item.stage === stage);
    if (!request) throw new Error(`Missing stage request in context: ${stage}`);
    promptText = fullPrompt(
      stripRuntimeAdapterPrompt(request.systemPrompt),
      [
        "原始 Word 文稿已经作为附件上传。请严格按以上提示词完成本阶段审稿。",
        `请在本次聊天回复正文中直接输出 agent${AGENT_STAGES.indexOf(stage) + 1}.txt 的完整纯文本内容；本地 runner 会负责保存文件。`,
        "不要生成附件、文件、下载链接或可下载地址；不要只回复文件链接；不要使用 Markdown 代码块。",
        "不要追加 JSON、不要输出程序 sidecar。"
      ].join("\n")
    );
  } else if (stage === "issue_list_cleaner") {
    const reports = {};
    for (const key of AGENT_STAGES) {
      reports[key] = await fs.readFile(path.join(paths.raw, stageFileName(key, "raw.txt")), "utf8");
    }
    promptText = fullPrompt(
      stripRuntimeAdapterPrompt(context.cleanerRequest.systemPrompt),
      [
        "请只基于以下五个 Agent TXT 输出进行清洗，不要读取或要求上传原 Word，不要回到原文重新审稿。",
        "请严格按你的清洁员提示词，在本次聊天回复正文中直接输出“问题清单.txt”的完整纯文本内容；本地 runner 会负责保存文件。",
        "不要生成附件、文件、下载链接或可下载地址；不要只回复文件链接；不要使用 Markdown 代码块。",
        "不要追加 JSON、不要输出程序 sidecar。",
        "",
        labeledAgentReportsForCleaner(reports)
      ].join("\n")
    );
  } else if (stage === "adjudicator_parameters") {
    const issueText = await readIssueListText(paths);
    promptText = fullPrompt(
      stripRuntimeAdapterPrompt(context.adjudicatorRequest.systemPrompt),
      [
        "原始 Word 文稿已经作为附件上传。请以 Word 附件 + 下方问题清单.txt 为唯一输入材料，严格按以上裁决者提示词输出纯文本“裁决者参数.txt”。",
        "请在本次聊天回复正文中直接输出“裁决者参数.txt”的完整纯文本内容；本地 runner 会负责保存文件。",
        "不要生成附件、文件、下载链接或可下载地址；不要只回复文件链接；不要使用 Markdown 代码块。",
        "不要追加 JSON、不要输出程序 sidecar；不要生成完整问题正文，问题详情后续由后台从问题清单.txt 严格映射。",
        "",
        "问题清单.txt:",
        issueText
      ].join("\n")
    );
  } else {
    throw new Error(`Unknown stage: ${stage}`);
  }
  await writeText(promptPath, promptText);
  await writeJson(manifestPath, promptManifest(stage, promptText));
  return { promptPath, promptText };
}

async function readIssueListText(paths) {
  const cleaned = path.join(paths.raw, "issue_list_cleaner.issue_list_txt.cleaned.txt");
  if (await fileExists(cleaned)) return fs.readFile(cleaned, "utf8");
  const raw = path.join(paths.raw, "issue_list_cleaner.issue_list_txt.txt");
  if (await fileExists(raw)) return fs.readFile(raw, "utf8");
  throw new Error("Missing issue_list txt output");
}

async function readConclusionText(paths) {
  const cleaned = path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.cleaned.txt");
  if (await fileExists(cleaned)) return fs.readFile(cleaned, "utf8");
  const raw = path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.txt");
  if (await fileExists(raw)) {
    const text = await fs.readFile(raw, "utf8");
    return text.split(/\nconclusion_parameters JSON:\s*\n/)[0].trim() + "\n";
  }
  throw new Error("Missing conclusion_parameters txt output");
}

function extractBalancedJson(text) {
  const value = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(value);
  } catch {
    // Continue to balanced-object extraction.
  }
  try {
    return JSON.parse(mechanicallyRepairJsonText(value));
  } catch {
    // Continue to balanced-object extraction.
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
      if (depth === 0) {
        const candidate = value.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return JSON.parse(mechanicallyRepairJsonText(candidate));
        }
      }
    }
  }
  throw new Error("No balanced JSON object found");
}

function stripAssistantDomUiNoise(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^\d{13,}_[a-f0-9-]+.*(?:\.docx|\.doc|…)$/.test(trimmed)) return false;
      if (/^粘贴的文本(?:\s*\(\d+\))?(?:\(\d+\))?(?:\.txt)?$/.test(trimmed)) return false;
      if (/^文档$/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function escapeJsonControlCharsInStrings(text) {
  const value = String(text || "");
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!inString) {
      if (char === "\"") inString = true;
      output += char;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = false;
      output += char;
      continue;
    }
    if (char === "\n") {
      output += "\\n";
      continue;
    }
    if (char === "\r") {
      output += "\\r";
      continue;
    }
    if (char === "\t") {
      output += "\\t";
      continue;
    }
    if (char.charCodeAt(0) < 0x20) {
      output += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    output += char;
  }
  return output;
}

function mechanicallyRepairJsonText(text) {
  const stripped = stripAssistantDomUiNoise(text);
  const start = stripped.indexOf("{");
  if (start < 0) return stripped;
  const candidate = stripped.slice(start);
  return escapeJsonControlCharsInStrings(candidate);
}

function parseStageObjectWithMechanicalRepair(stage, text) {
  try {
    return { obj: stageObjectFromText(stage, text), text: String(text || ""), repaired: false };
  } catch (firstError) {
    const repairedText = mechanicallyRepairJsonText(text);
    if (repairedText === String(text || "")) throw firstError;
    const obj = stageObjectFromText(stage, repairedText);
    return {
      obj,
      text: repairedText,
      repaired: true,
      repair_reason: firstError.message,
      repair_type: "escape-json-string-control-chars-and-strip-dom-ui-noise"
    };
  }
}

function extractSection(text, marker, nextMarkers = []) {
  const source = String(text || "");
  const match = marker.exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const nextPositions = nextMarkers
    .map((pattern) => {
      const m = pattern.exec(source.slice(start));
      return m ? start + m.index : -1;
    })
    .filter((index) => index >= 0);
  const end = nextPositions.length ? Math.min(...nextPositions) : source.length;
  return source.slice(start, end).trim();
}

function cleanIssueListText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^\d{13,}_[a-f0-9-]+/.test(trimmed)) return false;
      if (/^粘贴的文本(?: \(\d+\))?$/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

function cleanExtractedWebOutputText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^\d{13,}_[a-z0-9-]+(?:\(\d+\))?(?:\.[a-z0-9]+)?\s*…?$/i.test(trimmed)) return false;
      if (/^展开$/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function normalizeStageOutput(paths, stage, rawText) {
  if (!JSON_REQUIRED_STAGES.has(stage)) {
    if (stage === "issue_list_cleaner") {
      const issueText = extractSection(rawText, /(?:^|\n)\s*(?:问题清单\.txt|issue_list_txt|【问题清单】)\s*:?\s*/i) || rawText;
      await writeText(path.join(paths.raw, "issue_list_cleaner.issue_list_txt.txt"), issueText.trim() + "\n");
      await writeText(path.join(paths.raw, "issue_list_cleaner.issue_list_txt.cleaned.txt"), cleanIssueListText(issueText));
      return;
    }
    if (stage === "adjudicator_parameters") {
      const conclusionText = extractSection(rawText, /(?:^|\n)\s*(?:裁决者参数\.txt|结论参数\.txt|裁决报告\.txt|conclusion_parameters_txt|adjudicator_report_txt)\s*:?\s*/i) || rawText;
      await writeText(path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.txt"), rawText.trim() + "\n");
      await writeText(path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.cleaned.txt"), conclusionText.trim() + "\n");
      return;
    }
    return;
  }
  if (AGENT_STAGES.includes(stage)) {
    const jsonText = extractSection(rawText, /(?:^|\n)\s*agent_report\s+JSON\s*:\s*/i);
    if (!jsonText && !/^\s*\{/.test(String(rawText || ""))) throw new Error("agent_report JSON sidecar section not found");
    const obj = jsonText ? extractBalancedJson(jsonText) : extractBalancedJson(rawText);
    validateStageObject(stage, obj);
    await writeJson(path.join(paths.json, stageFileName(stage, "json")), obj);
    return;
  }
  if (stage === "issue_list_cleaner") {
    const issueText = extractSection(rawText, /(?:^|\n)\s*(?:问题清单\.txt|issue_list_txt|【问题清单】)\s*:?\s*/i, [
      /(?:^|\n)\s*issue_list\s+JSON\s*:/i
    ]) || rawText;
    const jsonText = extractSection(rawText, /(?:^|\n)\s*issue_list\s+JSON\s*:\s*/i);
    if (!jsonText) throw new Error("issue_list JSON section not found");
    await writeText(path.join(paths.raw, "issue_list_cleaner.issue_list_txt.txt"), issueText.trim() + "\n");
    await writeText(path.join(paths.raw, "issue_list_cleaner.issue_list_txt.cleaned.txt"), cleanIssueListText(issueText));
    const obj = extractBalancedJson(jsonText);
    validateStageObject(stage, obj);
    await writeJson(path.join(paths.json, "issue_list.json"), obj);
    return;
  }
  if (stage === "adjudicator_parameters") {
    const conclusionText = extractSection(rawText, /(?:^|\n)\s*(?:结论参数\.txt|裁决报告\.txt|conclusion_parameters_txt|adjudicator_report_txt)\s*:?\s*/i, [
      /(?:^|\n)\s*conclusion_parameters\s+JSON\s*:/i
    ]) || rawText.split(/\nconclusion_parameters JSON\s*:\s*\n/i)[0];
    const jsonText = extractSection(rawText, /(?:^|\n)\s*conclusion_parameters\s+JSON\s*:\s*/i);
    if (!jsonText) throw new Error("conclusion_parameters JSON section not found");
    await writeText(path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.txt"), rawText.trim() + "\n");
    await writeText(path.join(paths.raw, "adjudicator_parameters.conclusion_parameters_txt.cleaned.txt"), conclusionText.trim() + "\n");
    const obj = extractBalancedJson(jsonText);
    validateStageObject(stage, obj);
    await writeJson(path.join(paths.json, "conclusion_parameters.json"), obj);
    return;
  }
}

async function validateStageFiles(paths, stage) {
  if (!JSON_REQUIRED_STAGES.has(stage)) {
    const raw = await fs.readFile(rawPathForStage(paths, stage), "utf8").catch(() => "");
    if (!raw.trim()) throw new Error(`${stage} raw TXT output is empty`);
    const staleReason = staleOrWrongOutput(stage, raw);
    if (staleReason) throw new Error(`${stage} raw TXT output invalid: ${staleReason}`);
    if (stage === "issue_list_cleaner") {
      const issueText = await readIssueListText(paths);
      if (!/(清单序号|问题编号|编号)\s*[:：]/.test(issueText)) throw new Error("问题清单.txt 未检测到问题编号标签");
    }
    if (stage === "adjudicator_parameters") {
      const conclusionText = await readConclusionText(paths);
      for (const label of ["综合评分", "风险等级", "摘要", "总体结论", "Top 问题|优先处理问题", "预期发表定位|修后投稿定位"]) {
        if (!new RegExp(label).test(conclusionText)) throw new Error(`裁决者参数.txt 未检测到关键标签：${label}`);
      }
    }
    return true;
  }
  if (AGENT_STAGES.includes(stage)) {
    validateStageObject(stage, await readJson(jsonPathForStage(paths, stage)));
    return true;
  }
  if (stage === "issue_list_cleaner") {
    const issue = await readJson(path.join(paths.json, "issue_list.json"));
    validateStageObject(stage, issue);
    return true;
  }
  if (stage === "adjudicator_parameters") {
    const conclusion = await readJson(path.join(paths.json, "conclusion_parameters.json"));
    validateStageObject(stage, conclusion);
    return true;
  }
  return true;
}

async function launchContext(args = {}) {
  const profileDir = ensureAbsolute(args["profile-dir"] || DEFAULT_PROFILE_DIR);
  if (!fssync.existsSync(CHROME_EXECUTABLE)) {
    throw new Error(`Chrome executable not found: ${CHROME_EXECUTABLE}`);
  }
  await ensureDir(profileDir);
  const chromium = await getChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME_EXECUTABLE,
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--disable-dev-shm-usage"
    ]
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://chatgpt.com" }).catch(() => null);
  return context;
}

async function launchSession(args = {}) {
  if (wantsCdp(args)) {
    const endpoint = cdpEndpoint(args);
    const info = await cdpInfo(endpoint);
    if (!info) {
      throw new Error(`CDP endpoint is not available: ${endpoint}. Run prepare-cdp and keep that Chrome window open.`);
    }
    const chromium = await getChromium();
    const browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error(`No browser context available from CDP endpoint: ${endpoint}`);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://chatgpt.com" }).catch(() => null);
    return {
      mode: "cdp-attach",
      endpoint,
      browser: info.Browser,
      websocket: info.webSocketDebuggerUrl,
      context,
      close: async () => {
        try {
          const result = browser._connection?.close?.();
          if (result && typeof result.then === "function") await result;
        } catch {
          // CDP attach mode should release the runner without closing the user's Chrome window.
        }
      }
    };
  }
  const context = await launchContext(args);
  return {
    mode: "playwright-persistent-context",
    endpoint: null,
    browser: null,
    websocket: null,
    context,
    close: async () => {
      await context.close().catch(() => null);
    }
  };
}

async function getMainPage(context, targetUrl = DEFAULT_TARGET_URL) {
  let page = context.pages().find((item) => item.url().startsWith("https://chatgpt.com"));
  if (!page) page = await context.newPage();
  if (!page.url().startsWith("https://chatgpt.com")) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  }
  return page;
}

async function screenshot(paths, page, name) {
  const filePath = path.join(paths.screenshots, `${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}.${name}.png`);
  await ensureDir(path.dirname(filePath));
  await page.screenshot({ path: filePath, fullPage: false }).catch(() => null);
  return filePath;
}

async function detectIntelligenceLevel(page) {
  return page.evaluate((levels) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth;
    };
    const normalizeLevel = (text) => {
      const compact = String(text || "").replace(/\s+/g, "").trim();
      if (/^Pro$/i.test(compact)) return "专业";
      return levels.find((item) => compact === item || compact.includes(item)) || null;
    };
    const checked = Array.from(document.querySelectorAll("[role='menuitemradio'][aria-checked='true']"))
      .filter(visible)
      .map((element) => {
        const text = String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, "")
          .trim();
        const rect = element.getBoundingClientRect();
        const level = normalizeLevel(text);
        return level ? {
          level,
          text,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || "",
          checked: true,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        } : null;
      })
      .filter(Boolean);
    if (checked.length) return { level: checked[0].level, candidates: checked.slice(0, 8) };
    const controls = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .map((element) => {
        const text = String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, "")
          .trim();
        const rect = element.getBoundingClientRect();
        const level = normalizeLevel(text);
        return level ? {
          level,
          text,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || "",
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        } : null;
      })
      .filter(Boolean);
    controls.sort((a, b) => {
      const exactA = levels.includes(a.text) || /^Pro$/i.test(a.text) ? 1 : 0;
      const exactB = levels.includes(b.text) || /^Pro$/i.test(b.text) ? 1 : 0;
      if (exactA !== exactB) return exactB - exactA;
      return b.y - a.y;
    });
    return { level: controls[0]?.level || null, candidates: controls.slice(0, 8) };
  }, INTELLIGENCE_LEVELS).catch(() => ({ level: null, candidates: [] }));
}

async function pageState(page, targetModel, options = {}) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const hasComposer = await composerLocator(page).count().then((count) => count > 0).catch(() => false);
  const loggedOut = /登录以获取|登录以继续|免费注册|Log in to|Log in or sign up|Sign up to|Sign in to|Log in to ChatGPT|Sign up for ChatGPT/i.test(text)
    || (!hasComposer && /(?:^|\n)\s*(登录|免费注册|Log in|Sign up|Sign in)\s*(?:\n|$)/i.test(text));
  const modelVisible = targetModel ? text.toLowerCase().includes(String(targetModel).toLowerCase().replace(/\s+/g, " ").split(" ")[0]) : true;
  const modelAtCapacity = /Selected model is at capacity|model is at capacity|try a different model|模型.*容量|容量.*模型/i.test(text);
  const expectedIntelligenceLevel = normalizeIntelligenceLevel(options.intelligenceLevel, null);
  const allowedLevels = Array.isArray(options.allowedIntelligenceLevels) && options.allowedIntelligenceLevels.length
    ? options.allowedIntelligenceLevels
    : PRODUCTION_INTELLIGENCE_LEVELS;
  const detected = await detectIntelligenceLevel(page);
  const intelligenceLevelDetected = detected.level;
  const intelligenceLevelVisible = Boolean(intelligenceLevelDetected);
  const intelligenceLevelAllowed = !intelligenceLevelDetected || allowedLevels.includes(intelligenceLevelDetected);
  const intelligenceLevelMatches = !expectedIntelligenceLevel || !intelligenceLevelDetected || intelligenceLevelDetected === expectedIntelligenceLevel;
  return {
    url,
    title,
    hasComposer,
    loggedOut,
    modelVisible,
    modelAtCapacity,
    intelligenceLevelExpected: expectedIntelligenceLevel,
    intelligenceLevelAllowedValues: allowedLevels,
    intelligenceLevelDetected,
    intelligenceLevelVisible,
    intelligenceLevelAllowed,
    intelligenceLevelMatches,
    intelligenceLevelCandidates: detected.candidates,
    bodySample: text.slice(0, 500)
  };
}

function composerLocator(page) {
  return page.locator([
    "#prompt-textarea",
    "[data-testid='composer-input']",
    "[contenteditable='true'][data-placeholder]",
    "div[contenteditable='true']",
    "textarea"
  ].join(", "));
}

async function clickComposer(page) {
  const loc = composerLocator(page);
  const count = await loc.count();
  if (!count) throw new Error("Composer input not found");
  await loc.last().click({ timeout: 15000 });
}

async function composerText(page) {
  const loc = composerLocator(page);
  const count = await loc.count().catch(() => 0);
  if (!count) return "";
  const item = loc.last();
  const value = await item.inputValue({ timeout: 1000 }).catch(async () => (
    item.innerText({ timeout: 1000 }).catch(() => "")
  ));
  return String(value || "").trim();
}

async function clearComposerText(page) {
  const before = await composerText(page);
  if (!before) return { cleared: false, before: "", after: "" };

  await clickComposer(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);

  let after = await composerText(page);
  if (after) {
    await page.evaluate(() => {
      const selectors = [
        "#prompt-textarea",
        "[data-testid='composer-input']",
        "[contenteditable='true'][data-placeholder]",
        "div[contenteditable='true']",
        "textarea"
      ];
      const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const element = candidates.at(-1);
      if (!element) return;
      if ("value" in element) {
        const proto = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor?.set) descriptor.set.call(element, "");
        else element.value = "";
      } else {
        element.textContent = "";
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(300);
    after = await composerText(page);
  }
  return { cleared: true, before: before.slice(0, 500), after: after.slice(0, 500) };
}

async function writeClipboard(page, text) {
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
  }, text);
}

async function readClipboard(page) {
  return page.evaluate(async () => navigator.clipboard.readText());
}

async function pastePrompt(page, promptText) {
  await writeClipboard(page, promptText);
  await clickComposer(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await page.waitForTimeout(Math.min(20000, Math.max(3000, Math.floor(promptText.length / 3000) * 1000)));
  await waitForPromptAttachmentReady(page);
}

async function waitForPromptAttachmentReady(page, timeoutMs = 60000) {
  const started = Date.now();
  let sawPrompt = false;
  while (Date.now() - started < timeoutMs) {
    const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    sawPrompt = sawPrompt || /粘贴的文本|pasted text|SYSTEM PROMPT|USER PROMPT/i.test(body);
    const busy = /上传中|正在上传|Uploading|Processing|正在处理/i.test(body);
    if (sawPrompt && !busy) {
      await page.waitForTimeout(1000);
      return;
    }
    await page.waitForTimeout(1000);
  }
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (!/粘贴的文本|pasted text|SYSTEM PROMPT|USER PROMPT/i.test(body)) {
    throw new Error("Prompt paste could not be confirmed");
  }
}

function shortSubmitInstruction(stage) {
  if (AGENT_STAGES.includes(stage)) {
    return `请以已附上的 Word 文件作为全文主材料，按粘贴文本中的原始提示词执行本阶段审稿；在聊天回复正文中直接输出 agent${AGENT_STAGES.indexOf(stage) + 1}.txt 的完整纯文本内容，不要生成附件/文件/下载链接，不要追加 JSON。`;
  }
  if (stage === "issue_list_cleaner") {
    return "请只基于五个 Agent TXT 执行清洁员任务；在聊天回复正文中直接输出 问题清单.txt 的完整纯文本内容，不要生成附件/文件/下载链接，不要追加 JSON。";
  }
  if (stage === "adjudicator_parameters") {
    return "请以已附上的 Word 文件和问题清单为依据执行裁决者参数阶段；在聊天回复正文中直接输出 裁决者参数.txt 的完整纯文本内容，不要生成附件/文件/下载链接，不要追加 JSON。";
  }
  return "请按已附上的 prompt 执行，在聊天回复正文中直接输出本阶段要求的纯文本，不要生成附件/文件/下载链接。";
}

async function addSubmitInstruction(page, stage) {
  const instruction = shortSubmitInstruction(stage);
  await clickComposer(page);
  const before = await composerText(page);
  if (before.includes(instruction)) return;
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End").catch(() => null);
  await page.keyboard.press("End").catch(() => null);
  await page.keyboard.type(`\n\n${instruction}`, { delay: 0 });
  await page.waitForTimeout(500);
  const after = await composerText(page);
  if (!after.includes(instruction)) {
    throw new Error(`Submit instruction was not written to composer for ${stage}`);
  }
  if (before.length > 500 && after.length < before.length) {
    throw new Error(`Composer text shrank while adding submit instruction for ${stage}`);
  }
  if (/final_report|终稿/i.test(after) && stage !== "final_report_output") {
    throw new Error(`Unexpected stale final-report instruction remained in composer for ${stage}`);
  }
}

async function uploadTextPromptFallback(page, promptPath) {
  await setInputFiles(page, promptPath);
  const fileName = path.basename(promptPath);
  await page.getByText(fileName, { exact: false }).waitFor({ timeout: 30000 });
}

async function setInputFiles(page, filePath) {
  const preferredSelectors = [
    "input#upload-files",
    "input[type='file']:not([accept*='image'])"
  ];
  for (const selector of preferredSelectors) {
    const inputs = page.locator(selector);
    const count = await inputs.count().catch(() => 0);
    if (count) {
      await inputs.first().setInputFiles(filePath);
      return;
    }
  }

  {
    await clickAttachButton(page);
    await page.waitForTimeout(1000);
  }

  for (const selector of preferredSelectors) {
    const inputs = page.locator(selector);
    const count = await inputs.count().catch(() => 0);
    if (count) {
      await inputs.first().setInputFiles(filePath);
      return;
    }
  }
  throw new Error("Generic file input for document upload not found");
}

async function clickAttachButton(page) {
  const selectors = [
    "button[data-testid='composer-plus-btn']",
    "button[aria-label='添加文件等']",
    "button[aria-label*='添加']",
    "button[aria-label*='Attach']",
    "button[aria-label*='上传']",
    "button[aria-label*='file' i]",
    "button:has-text('+')"
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const item = loc.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const box = await item.boundingBox().catch(() => null);
      if (box && (box.x < 250 || box.y < 100)) continue;
      await item.click({ timeout: 8000 });
      return;
    }
  }
  throw new Error("Attach button not found");
}

function manuscriptFileCandidates(metadata, args = {}) {
  return [
    metadata.manuscript?.file_path ? path.basename(metadata.manuscript.file_path) : null,
    args["original-file-name"],
    metadata.manuscript?.original_file_name,
    metadata.manuscript?.file_name
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index);
}

async function confirmAttachedFile(page, candidates, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const matched = candidates.find((name) => body.includes(name));
    if (matched) return matched;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Attached file could not be confirmed by visible file name: ${candidates.join(" | ")}`);
}

async function clickVisibleTextCandidate(page, candidates, timeoutMs = 8000, options = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const name of candidates) {
      const exact = page.getByText(name, { exact: true });
      const exactCount = await exact.count().catch(() => 0);
      for (let index = exactCount - 1; index >= 0; index -= 1) {
        const item = exact.nth(index);
        if (await item.isVisible().catch(() => false)) {
          const box = await item.boundingBox().catch(() => null);
          if (options.mainAreaOnly && box && box.x < 250) continue;
          await item.click({ timeout: 5000 });
          return name;
        }
      }
      const fuzzy = page.getByText(name, { exact: false });
      const fuzzyCount = await fuzzy.count().catch(() => 0);
      for (let index = fuzzyCount - 1; index >= 0; index -= 1) {
        const item = fuzzy.nth(index);
        if (await item.isVisible().catch(() => false)) {
          const box = await item.boundingBox().catch(() => null);
          if (options.mainAreaOnly && box && box.x < 250) continue;
          await item.click({ timeout: 5000 });
          return name;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No visible recent/library file candidate found: ${candidates.join(" | ")}`);
}

async function clickMenuItemByPattern(page, pattern, timeoutMs = 5000, options = {}) {
  const items = page.locator("button, [role='menuitem'], [role='option'], a, div[role='button']");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = await items.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const item = items.nth(index);
      const label = [
        await item.innerText({ timeout: 500 }).catch(() => ""),
        await item.getAttribute("aria-label").catch(() => "")
      ].join(" ");
      if (!pattern.test(label)) continue;
      if (!(await item.isVisible().catch(() => false))) continue;
      const box = await item.boundingBox().catch(() => null);
      if (options.mainAreaOnly && box && box.x < 250) continue;
      await item.click({ timeout: 5000 });
      return label.trim();
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Menu item not found: ${pattern}`);
}

async function selectWordFromRecentOrLibrary(page, candidates) {
  await clickAttachButton(page);
  await page.waitForTimeout(1000);
  try {
    const selected = await clickVisibleTextCandidate(page, candidates, 3000, { mainAreaOnly: true });
    const confirmed = await confirmAttachedFile(page, candidates, 20000);
    return { confirmed: true, file_name: confirmed, selected_name: selected, source: "recent-file-direct" };
  } catch {
    // Continue through named menu routes.
  }
  const routes = [
    { source: "recent-file-picker", pattern: /最近|近期|Recent|Recents/i },
    { source: "library-picker", pattern: /从库中添加|从库中选择|添加.*库|库|Library|Add from library|Add from Library/i }
  ];
  for (const route of routes) {
    try {
      await clickAttachButton(page).catch(() => null);
      await page.waitForTimeout(500);
      await clickMenuItemByPattern(page, route.pattern, 5000, { mainAreaOnly: true });
      await page.waitForTimeout(1200);
      const selected = await clickVisibleTextCandidate(page, candidates, 8000, { mainAreaOnly: true });
      const confirmed = await confirmAttachedFile(page, candidates, 25000);
      return { confirmed: true, file_name: confirmed, selected_name: selected, source: route.source };
    } catch {
      await page.keyboard.press("Escape").catch(() => null);
    }
  }
  throw new Error(`Could not select Word from recent files/library: ${candidates.join(" | ")}`);
}

async function uploadWord(page, manuscriptPath, candidates = [path.basename(manuscriptPath)]) {
  await setInputFiles(page, manuscriptPath);
  const confirmed = await confirmAttachedFile(page, candidates, 60000);
  return { confirmed: true, file_name: confirmed, source: "local-upload" };
}

async function waitForTerminalEnter(message) {
  if (!process.stdin.isTTY) {
    throw new Error("Manual confirmation requires an interactive terminal");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(`${message}\nPress Enter after the file chip is fully uploaded and ready...`);
  } finally {
    rl.close();
  }
}

async function manualWordUpload(page, manuscriptPath, stage, candidates = [path.basename(manuscriptPath)]) {
  const baseName = candidates[0] || path.basename(manuscriptPath);
  console.log(JSON.stringify({
    action: "manual_word_upload_required",
    stage,
    file_path: manuscriptPath,
    preferred_file_names: candidates,
    instruction: "In the visible ChatGPT window, prefer Recent files / Add from library and choose the exact file name. If not available, upload the local Word file. Wait until the file chip is fully attached, then return to this terminal and press Enter."
  }, null, 2));
  await waitForTerminalEnter(`Manual upload required for ${stage}: ${baseName}`);
  try {
    const confirmed = await confirmAttachedFile(page, candidates, 10000);
    return { confirmed: true, file_name: confirmed, source: "manual-upload", confirmed_by: "terminal-enter", visible_name_confirmed: true };
  } catch (error) {
    return {
      confirmed: true,
      file_name: baseName,
      source: "manual-upload",
      confirmed_by: "terminal-enter",
      visible_name_confirmed: false,
      confirmation_note: `Terminal/user confirmation accepted; exact visible file name was not detected: ${error.message}`
    };
  }
}

async function uploadWordWithFallback(page, paths, metadata, args, stage) {
  const candidates = manuscriptFileCandidates(metadata, args);
  const manualRequested = Boolean(args["manual-word-upload"] || (args["manual-first-word-upload"] && stage === AGENT_STAGES[0]));
  const uploadMode = String(args["upload-mode"] || (args["prefer-library"] ? "recent" : "local")).toLowerCase();
  if (manualRequested) {
    const upload = await manualWordUpload(page, metadata.manuscript.file_path, stage, candidates);
    recordConversation(metadata, stage, { upload_confirmation: upload });
    return;
  }

  if (["recent", "library", "prefer-library"].includes(uploadMode)) {
    try {
      const upload = await selectWordFromRecentOrLibrary(page, candidates);
      recordConversation(metadata, stage, { upload_confirmation: upload, upload_mode: uploadMode });
      return;
    } catch (error) {
      recordRetry(metadata, stage, "select-word-from-recent-or-library", error);
    }
  }

  try {
    const upload = await uploadWord(page, metadata.manuscript.file_path, candidates);
    recordConversation(metadata, stage, { upload_confirmation: upload, upload_mode: uploadMode });
  } catch (error) {
    recordRetry(metadata, stage, "upload-word", error);
    await screenshot(paths, page, `${stage}.upload-stalled`);
    if (process.stdin.isTTY) {
      const upload = await manualWordUpload(page, metadata.manuscript.file_path, stage, candidates);
      recordConversation(metadata, stage, { upload_confirmation: upload, upload_fallback: "manual-after-auto-failure" });
      return;
    }
    recordPause(metadata, stage, "upload_state_cannot_be_confirmed", "Word upload could not be confirmed; resume from this stage after manual upload support is available.");
    throw error;
  }
}

async function clickSend(page) {
  const beforeUserCount = await page.locator("[data-message-author-role='user']").count().catch(() => 0);
  const beforeAssistantCount = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
  const beforeUrl = page.url();
  async function currentComposerText() {
    const loc = composerLocator(page);
    const count = await loc.count().catch(() => 0);
    if (!count) return "";
    const item = loc.last();
    const text = await item.innerText({ timeout: 1000 }).catch(async () => item.inputValue({ timeout: 1000 }).catch(() => ""));
    return String(text || "").trim();
  }
  async function submissionStarted(waitMs = 3000) {
    await page.waitForTimeout(waitMs);
    const userCount = await page.locator("[data-message-author-role='user']").count().catch(() => 0);
    const assistantCount = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
    const body = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    const composerText = await currentComposerText();
    const urlChangedToConversation = page.url() !== beforeUrl && /\/c\//.test(page.url());
    const busy = /正在思考|停止回答|Stop generating|Stop responding|停止生成/i.test(body);
    const promptLeftInComposer = composerText.length > 0;
    if (busy || assistantCount > beforeAssistantCount || ((userCount > beforeUserCount || urlChangedToConversation) && !promptLeftInComposer)) {
      return { userCount, assistantCount, url: page.url(), urlChangedToConversation, promptLeftInComposer };
    }
    return null;
  }

  const selectors = [
    "button[data-testid='send-button']",
    "button[aria-label*='发送']",
    "button[aria-label*='Send']"
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    for (let index = count - 1; index >= 0; index -= 1) {
      const item = loc.nth(index);
      const box = await item.boundingBox().catch(() => null);
      if (box && (box.x < 250 || box.y < 100)) continue;
      if (await item.isEnabled().catch(() => false)) {
        await item.click({ timeout: 10000 });
        const clicked = await submissionStarted(3000);
        if (clicked) return { method: "send-button-click", ...clicked };
        for (const waitMs of [3000, 6000, 10000]) {
          await clickComposer(page).catch(() => null);
          await page.keyboard.press("Enter");
          const submitted = await submissionStarted(waitMs);
          if (submitted) return { method: `composer-enter-after-click-${waitMs}`, ...submitted };
        }
        throw new Error("Send click/Enter did not submit the current prompt");
      }
    }
  }
  for (const waitMs of [3000, 6000, 10000]) {
    await clickComposer(page);
    await page.keyboard.press("Enter");
    const submitted = await submissionStarted(waitMs);
    if (submitted) return { method: `composer-enter-${waitMs}`, ...submitted };
  }
  throw new Error("Enter did not submit the current prompt");
}

function looksLikelyCompleteStageOutput(stage, text) {
  const value = String(text || "").trim();
  if (isAssistantPlaceholderText(value)) return false;
  const minChars = minimumTxtOutputChars(stage);
  if (!JSON_REQUIRED_STAGES.has(stage) && value.length < minChars) return false;
  if (!JSON_REQUIRED_STAGES.has(stage)) return true;
  try {
    const obj = stageObjectFromText(stage, value);
    validateStageObject(stage, obj);
    return true;
  } catch {
    if (AGENT_STAGES.includes(stage)) return /agent_report\s+JSON/i.test(value) && /\}\s*$/.test(value);
    if (stage === "issue_list_cleaner") return /issue_list\s+JSON/i.test(value) && /\}\s*$/.test(value);
    if (stage === "adjudicator_parameters") return /conclusion_parameters\s+JSON/i.test(value) && /\}\s*$/.test(value);
    return /\}\s*$/.test(value) && value.includes("{");
  }
}

function minimumTxtOutputChars(stage) {
  if (AGENT_STAGES.includes(stage)) return 1200;
  if (stage === "issue_list_cleaner") return 2000;
  if (stage === "adjudicator_parameters") return 1200;
  return 20;
}

function isAssistantPlaceholderText(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (/^(正在(?:读取文档|整理答案|思考|处理|生成)|Reading document|Thinking|Generating)$/i.test(value)) return true;
  if (/^请稍候|^请等待/.test(value)) return true;
  return false;
}

async function waitForGeneration(page, timeoutMs = 20 * 60 * 1000, baseline = {}, stage = "") {
  const started = Date.now();
  const baselineCount = Number.isFinite(baseline.assistantCount) ? baseline.assistantCount : 0;
  const baselineText = String(baseline.lastAssistantText || "");
  let lastObservedAssistantText = "";
  let stableCycles = 0;
  await page.waitForTimeout(3000);
  while (Date.now() - started < timeoutMs) {
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const stopButtonPresent = await page.locator([
      "[data-testid='stop-button']",
      "button[aria-label*='停止回答']",
      "button[aria-label*='停止生成']",
      "button[aria-label*='Stop generating']",
      "button[aria-label*='Stop responding']"
    ].join(", ")).count().then((count) => count > 0).catch(() => false);
    const stopPresent = stopButtonPresent || /正在思考|停止回答|Stop generating|Stop responding|停止生成/i.test(text);
    const assistantCount = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
    const lastAssistantText = assistantCount > 0
      ? await page.locator("[data-message-author-role='assistant']").last().innerText({ timeout: 5000 }).catch(() => "")
      : "";
    const hasNewAssistant = assistantCount > baselineCount || (assistantCount === baselineCount && baselineText && lastAssistantText !== baselineText);
    if (hasNewAssistant && !stopPresent) {
      if (lastAssistantText.trim().length > 80 && lastAssistantText === lastObservedAssistantText) {
        stableCycles += 1;
      } else {
        stableCycles = 0;
        lastObservedAssistantText = lastAssistantText;
      }
      const likelyComplete = looksLikelyCompleteStageOutput(stage, lastAssistantText);
      if (stableCycles >= 3 && likelyComplete) return;
      if (stableCycles >= 10 && !JSON_REQUIRED_STAGES.has(stage) && likelyComplete) return;
    } else {
      stableCycles = 0;
    }
    await page.waitForTimeout(5000);
  }
  throw new Error("Timed out waiting for generation to finish");
}

async function copyLastAssistant(page) {
  const assistant = page.locator("[data-message-author-role='assistant']").last();
  if (!(await assistant.count().catch(() => 0))) throw new Error("Assistant message not found");
  const scopedCopy = assistant.locator("button[aria-label*='复制'], button[aria-label*='Copy'], button[data-testid*='copy']");
  if (await scopedCopy.count().catch(() => 0)) {
    for (const force of [false, true]) {
      await scopedCopy.last().click({ timeout: 10000, force }).catch(() => null);
      await page.waitForTimeout(1000);
      const text = await readClipboard(page).catch(() => "");
      if (text && text.trim().length > 20) return text;
    }
  }
  const globalCopy = page.locator("button[aria-label*='复制'], button[aria-label*='Copy'], button[data-testid*='copy']");
  if (await globalCopy.count().catch(() => 0)) {
    for (const force of [false, true]) {
      await globalCopy.last().click({ timeout: 10000, force }).catch(() => null);
      await page.waitForTimeout(1000);
      const text = await readClipboard(page).catch(() => "");
      if (text && text.trim().length > 20) return text;
    }
  }
  throw new Error("Copy button did not produce clipboard text");
}

async function tryDownloadLastOutput(page, paths, stage) {
  const buttons = page.locator("button, a");
  const count = await buttons.count().catch(() => 0);
  for (let index = count - 1; index >= Math.max(0, count - 12); index -= 1) {
    const item = buttons.nth(index);
    const label = await item.innerText({ timeout: 1000 }).catch(() => "");
    const aria = await item.getAttribute("aria-label").catch(() => "");
    if (!/下载|Download/i.test(`${label} ${aria}`)) continue;
    const downloadPromise = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
    await item.click({ timeout: 5000 }).catch(() => null);
    const download = await downloadPromise;
    if (!download) continue;
    const suggested = download.suggestedFilename();
    const target = path.join(paths.raw, `${stage}.${suggested || "download.txt"}`);
    await download.saveAs(target);
    return fs.readFile(target, "utf8");
  }
  throw new Error("No downloadable output found");
}

async function readLastAssistantDom(page) {
  const assistant = page.locator("[data-message-author-role='assistant']").last();
  const text = await assistant.innerText({ timeout: 30000 });
  if (!text.trim()) throw new Error("Assistant DOM text empty");
  return text;
}

function staleOrWrongOutput(stage, text) {
  const value = String(text || "").trim();
  const minChars = minimumTxtOutputChars(stage);
  if (value.length < minChars) return `candidate too short for ${stage}: ${value.length} < ${minChars}`;
  if (isAssistantPlaceholderText(value)) return "candidate is assistant placeholder/status text";
  if (/^[\s\S]{0,500}(?:问题清单|裁决参数|agent\d+)\.txt(?:\r?\n|$)/i.test(value) && value.length < 800) {
    return "candidate looks like stale file-name list rather than assistant output";
  }
  if (/下载地址|download link|sandbox:\/mnt\/data|^https?:\/\/\S+\.txt\b/i.test(value)) {
    return "candidate points to a downloaded TXT instead of inline chat output";
  }
  if (/web-review-runner-preflight|APP_ACCESS_CODE|admin[-_ ]?only|SYSTEM PROMPT:\s*\n|USER PROMPT:\s*\n/i.test(value)) {
    return "candidate looks like stale clipboard or prompt text";
  }
  if (!JSON_REQUIRED_STAGES.has(stage)) {
    if (AGENT_STAGES.includes(stage) && !/(P0|P1|P2|P3|问题|审稿|修改|建议|风险|统计|图表|合规|创新|设计)/i.test(value)) {
      return "agent TXT does not contain expected review terms";
    }
    if (stage === "issue_list_cleaner" && !/(问题编号|清单序号|编号|P0|P1|P2|P3)/.test(value)) {
      return "问题清单.txt does not contain expected issue identifiers";
    }
    if (stage === "adjudicator_parameters" && !/(综合评分|风险等级|总体结论|投稿建议|修后投稿定位|预期发表定位)/.test(value)) {
      return "裁决者参数.txt does not contain expected adjudicator labels";
    }
    return "";
  }
  try {
    const obj = stageObjectFromText(stage, value);
    validateStageObject(stage, obj);
    return "";
  } catch (error) {
    return error.message;
  }
}

function compactForMatch(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function significantCandidateFragments(stage, text) {
  const fragments = [];
  try {
    const obj = stageObjectFromText(stage, text);
    if (Array.isArray(obj?.issues) && obj.issues.length) {
      for (const issue of obj.issues.slice(0, 3)) {
        fragments.push(issue.issue, issue.evidence, issue.location, issue.recommendation);
      }
    }
    fragments.push(
      obj?.review_summary,
      obj?.summary,
      obj?.overall_conclusion,
      obj?.overall_score_rationale,
      obj?.submission_recommendation,
      obj?.final_review_text
    );
  } catch {
    // Candidate is validated elsewhere; no extra fragments available here.
  }
  return fragments
    .map((fragment) => compactForMatch(fragment).slice(0, 120))
    .filter((fragment) => fragment.length >= 30);
}

function candidateMatchesAssistantDom(stage, method, text, assistantDom) {
  if (method === "assistant-dom") return true;
  const dom = compactForMatch(assistantDom);
  if (dom.length < 100) return true;
  const candidate = compactForMatch(text);
  if (candidate.length < 100) return true;
  if (dom.includes(candidate.slice(0, 160))) return true;
  for (const fragment of significantCandidateFragments(stage, text)) {
    if (dom.includes(fragment)) return true;
  }
  return false;
}

async function saveOutputCandidate(paths, stage, method, text, accepted, reason = "") {
  const indexPath = path.join(paths.rawCandidates, `${stage}.manifest.json`);
  const manifest = await readJson(indexPath, { stage, candidates: [] });
  const index = manifest.candidates.length + 1;
  const safeMethod = String(method || "candidate").replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-|-$/g, "");
  const filePath = path.join(paths.rawCandidates, `${stage}.${String(index).padStart(2, "0")}.${safeMethod}.txt`);
  await writeText(filePath, String(text || ""));
  const entry = {
    time: nowIso(),
    index,
    method,
    accepted,
    rejection_reason: accepted ? null : reason,
    chars: String(text || "").length,
    sha256: sha256(text || ""),
    path: path.resolve(filePath)
  };
  manifest.candidates.push(entry);
  await writeJson(indexPath, manifest);
  return entry;
}

async function extractOutput(page, paths, stage, metadata) {
  const assistantDom = await readLastAssistantDom(page).catch(() => "");
  const methods = [
    ["copy-button", () => copyLastAssistant(page)],
    ["download-button", () => tryDownloadLastOutput(page, paths, stage)],
    ["assistant-dom", async () => assistantDom || readLastAssistantDom(page)]
  ];
  for (const [method, fn] of methods) {
    try {
      const text = await fn();
      let reason = staleOrWrongOutput(stage, text);
      if (!reason && !candidateMatchesAssistantDom(stage, method, text, assistantDom)) {
        reason = "candidate passes schema but does not match the last assistant DOM";
      }
      const entry = await saveOutputCandidate(paths, stage, method, text, !reason, reason);
      metadata.output_candidates = Array.isArray(metadata.output_candidates) ? metadata.output_candidates : [];
      metadata.output_candidates.push({ stage, ...entry });
      if (reason) {
        recordRetry(metadata, stage, `extract-${method}-candidate-rejected`, reason);
        continue;
      }
      recordConversation(metadata, stage, { extraction: { method, strict_json_valid: JSON_REQUIRED_STAGES.has(stage), candidate_path: entry.path } });
      return text;
    } catch (error) {
      recordRetry(metadata, stage, `extract-${method}`, error);
    }
  }
  throw new Error("All output extraction methods failed");
}

async function newConversation(page, targetUrl = DEFAULT_TARGET_URL) {
  const rootUrl = new URL(targetUrl);
  rootUrl.pathname = "/";
  rootUrl.search = "";
  rootUrl.hash = "";

  await page.goto(rootUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);

  const assistantCountAfterGoto = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
  const stillInConversation = /\/c\//.test(page.url()) || assistantCountAfterGoto > 0;
  if (stillInConversation) {
    const candidates = [
      page.getByRole("link", { name: /新聊天|New chat/i }),
      page.getByRole("button", { name: /新聊天|New chat/i }),
      page.locator("a[aria-label*='新聊天'], button[aria-label*='新聊天'], a[aria-label*='New chat' i], button[aria-label*='New chat' i]"),
      page.locator("a[href='/']")
    ];
    let clicked = false;
    for (const loc of candidates) {
      const count = await loc.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const item = loc.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        await item.click({ timeout: 10000 }).catch(() => null);
        clicked = true;
        await page.waitForTimeout(2000);
        break;
      }
      if (clicked) break;
    }
    if (!clicked) {
      throw new Error("Could not open a new independent ChatGPT conversation");
    }
  }

  await clickComposer(page);
  const assistantCount = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
  if (/\/c\//.test(page.url()) || assistantCount > 0) {
    throw new Error(`New independent conversation could not be confirmed; url=${page.url()}, assistant_messages=${assistantCount}`);
  }
}

async function stageDependencyHash(paths, stage, promptText, metadata) {
  const payload = {
    stage,
    prompt_sha256: sha256(promptText || ""),
    target_model: metadata.target_model || DEFAULT_TARGET_MODEL,
    intelligence_level: metadata.intelligence_level || DEFAULT_INTELLIGENCE_LEVEL
  };
  if (WORD_STAGES.has(stage)) payload.manuscript = await fileFingerprint(metadata.manuscript?.file_path);
  return sha256(JSON.stringify(payload));
}

async function localCleanerDependencyHash(paths) {
  return hashExistingFiles(AGENT_STAGES.map((stage) => jsonPathForStage(paths, stage)));
}

async function stageCanSkip(paths, metadata, stage, dependencySha256, outputPath) {
  const state = await loadStageState(paths);
  const requiredFiles = stageRequiredOutputFiles(paths, stage);
  for (const file of requiredFiles) {
    if (!(await fileExists(file))) return false;
  }
  try {
    await validateStageFiles(paths, stage);
  } catch (error) {
    await invalidateStageArtifacts(paths, metadata, stage, `existing output failed validation: ${error.message}`);
    return false;
  }
  if (state[stage]?.dependency_sha256 === dependencySha256) return true;
  if (!state[stage]?.dependency_sha256) {
    state[stage] = {
      stage,
      status: "adopted_existing",
      dependency_sha256: dependencySha256,
      output_sha256: await hashExistingFiles(requiredFiles),
      updated_at: nowIso()
    };
    await saveStageState(paths, state);
    return true;
  }
  await invalidateStageArtifacts(paths, metadata, stage, "upstream dependency hash changed");
  return false;
}

async function markStageState(paths, stage, dependencySha256, outputPath, patch = {}) {
  const state = await loadStageState(paths);
  state[stage] = {
    stage,
    dependency_sha256: dependencySha256,
    output_sha256: await hashExistingFiles(stageRequiredOutputFiles(paths, stage).filter((file) => fssync.existsSync(file)) || [outputPath]),
    updated_at: nowIso(),
    ...patch
  };
  await saveStageState(paths, state);
}

async function runLocalIssueListCleaner({ paths, metadata }) {
  const stage = "issue_list_cleaner";
  const jsonPath = jsonPathForStage(paths, stage);
  const dependencySha256 = await localCleanerDependencyHash(paths);
  if (await stageCanSkip(paths, metadata, stage, dependencySha256, jsonPath)) {
    recordConversation(metadata, stage, {
      status: "skipped_existing",
      dependency_sha256: dependencySha256,
      json_path: path.resolve(jsonPath),
      extraction: { method: "local-deterministic-projection", strict_json_valid: true }
    });
    return;
  }
  const agentJsons = await readAgentJsons(paths);
  const issueList = buildLocalIssueList(agentJsons);
  const issueText = renderIssueListText(issueList);
  await writeText(path.join(paths.raw, "issue_list_cleaner.issue_list_txt.txt"), issueText);
  await writeText(path.join(paths.raw, "issue_list_cleaner.issue_list_txt.cleaned.txt"), issueText);
  await writeText(rawPathForStage(paths, stage), [
    issueText.trim(),
    "",
    "issue_list JSON:",
    JSON.stringify(issueList, null, 2)
  ].join("\n"));
  await writeJson(jsonPath, issueList);
  await validateIssueListGate(paths);
  recordConversation(metadata, stage, {
    status: "succeeded_local_deterministic_projection",
    dependency_sha256: dependencySha256,
    raw_path: path.resolve(rawPathForStage(paths, stage)),
    json_path: path.resolve(jsonPath),
    extraction: {
      method: "local-deterministic-projection-from-validated-agent-json",
      strict_json_valid: true,
      semantic_change: false
    }
  });
  metadata.local_projections = Array.isArray(metadata.local_projections) ? metadata.local_projections : [];
  metadata.local_projections.push({
    time: nowIso(),
    stage,
    source: "five_validated_agent_json_issues_arrays",
    issue_count: issueList.issue_count,
    severity_counts: issueList.severity_counts,
    dependency_sha256: dependencySha256,
    semantic_change: false
  });
  await markStageState(paths, stage, dependencySha256, jsonPath, { status: "succeeded_local_deterministic_projection" });
}

async function runStage({ page, paths, context, metadata, args, stage }) {
  const rawPath = rawPathForStage(paths, stage);
  const jsonPath = jsonPathForStage(paths, stage);
  const { promptPath, promptText } = await buildStagePrompt(paths, stage, context);
  const dependencySha256 = await stageDependencyHash(paths, stage, promptText, metadata);
  if (await stageCanSkip(paths, metadata, stage, dependencySha256, jsonPath)) {
    recordConversation(metadata, stage, {
      status: "skipped_existing",
      json_path: path.resolve(jsonPath),
      dependency_sha256: dependencySha256
    });
    return;
  }
  metadata.clipboard_hashes.push({ time: nowIso(), stage, prompt_sha256: sha256(promptText), prompt_chars: [...promptText].length });
  await newConversation(page, args["target-url"] || DEFAULT_TARGET_URL);
  const clearedDraft = await clearComposerText(page);
  if (clearedDraft.cleared) {
    recordConversation(metadata, stage, {
      cleared_composer_draft: {
        before_sample: clearedDraft.before,
        after_sample: clearedDraft.after
      }
    });
  }
  await screenshot(paths, page, `${stage}.before`);
  recordConversation(metadata, stage, {
    status: "running",
    conversation_url: page.url(),
    prompt_path: path.resolve(promptPath),
    prompt_sha256: sha256(promptText),
    dependency_sha256: dependencySha256,
    word_attachment_required: WORD_STAGES.has(stage)
  });

  if (WORD_STAGES.has(stage)) {
    await uploadWordWithFallback(page, paths, metadata, args, stage);
  }

  try {
    await pastePrompt(page, promptText);
    await addSubmitInstruction(page, stage);
    recordConversation(metadata, stage, { prompt_delivery: "browser-clipboard-paste-text-attachment" });
  } catch (error) {
    recordRetry(metadata, stage, "paste-prompt", error);
    try {
      await uploadTextPromptFallback(page, promptPath);
      await addSubmitInstruction(page, stage);
      recordConversation(metadata, stage, { prompt_delivery: "prompt-txt-file-upload-fallback" });
    } catch (fallbackError) {
      recordRetry(metadata, stage, "upload-prompt-txt-fallback", fallbackError);
      throw fallbackError;
    }
  }

  const assistantCountBeforeSend = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
  const lastAssistantBeforeSend = assistantCountBeforeSend > 0
    ? await page.locator("[data-message-author-role='assistant']").last().innerText({ timeout: 5000 }).catch(() => "")
    : "";
  const sendConfirmation = await clickSend(page);
  await page.waitForTimeout(3000);
  recordConversation(metadata, stage, { conversation_url: page.url(), send_confirmation: sendConfirmation });
  await waitForGeneration(page, 20 * 60 * 1000, {
    assistantCount: assistantCountBeforeSend,
    lastAssistantText: lastAssistantBeforeSend
  }, stage);
  await screenshot(paths, page, `${stage}.after`);
  const rawText = cleanExtractedWebOutputText(await extractOutput(page, paths, stage, metadata));
  await writeText(rawPath, rawText.trim() + "\n");
  try {
    await normalizeStageOutput(paths, stage, rawText);
    if (stage === "adjudicator_parameters") await validateIssueListGate(paths);
    await validateStageFiles(paths, stage);
    recordConversation(metadata, stage, {
      status: "succeeded",
      raw_path: path.resolve(rawPath),
      json_path: path.resolve(jsonPath),
      conversation_url: page.url(),
      dependency_sha256: dependencySha256
    });
    await markStageState(paths, stage, dependencySha256, jsonPath, { status: "succeeded" });
  } catch (error) {
    recordRetry(metadata, stage, "strict-json-validate", error);
    if (JSON_REQUIRED_STAGES.has(stage)) {
      const repairAssistantCount = await page.locator("[data-message-author-role='assistant']").count().catch(() => 0);
      const repairLastAssistant = repairAssistantCount > 0
        ? await page.locator("[data-message-author-role='assistant']").last().innerText({ timeout: 5000 }).catch(() => "")
        : "";
      await requestSameConversationJsonRepair(page, stage, error);
      await waitForGeneration(page, 20 * 60 * 1000, {
        assistantCount: repairAssistantCount,
        lastAssistantText: repairLastAssistant
      }, stage);
      const repaired = await extractOutput(page, paths, stage, metadata);
      await writeText(rawPath, repaired.trim() + "\n");
      await normalizeStageOutput(paths, stage, repaired);
      if (stage === "adjudicator_parameters") await validateIssueListGate(paths);
      await validateStageFiles(paths, stage);
      recordConversation(metadata, stage, {
        status: "succeeded_after_format_repair",
        format_fix_count: 1,
        raw_path: path.resolve(rawPath),
        json_path: path.resolve(jsonPath),
        conversation_url: page.url(),
        dependency_sha256: dependencySha256
      });
      metadata.format_repairs.push({ stage, count: 1, type: "same_conversation_json_format_repair", semantic_change: false });
      await markStageState(paths, stage, dependencySha256, jsonPath, { status: "succeeded_after_format_repair" });
    } else {
      throw error;
    }
  }
}

async function requestSameConversationJsonRepair(page, stage, error) {
  const repairPrompt = (() => {
    if (AGENT_STAGES.includes(stage)) {
      return [
        "请只做格式修复，不要重新审稿、不要新增/删除/合并问题、不要改变任何问题正文。",
        `当前本地解析错误：${error.message}`,
        "请重新输出上一条回复：先保留固定 TXT 正文，然后在末尾追加 agent_report JSON: 段落。",
        "agent_report JSON 必须是严格 JSON 对象，包含 schema_version、stage、issues、positive_findings、review_summary；禁止 Markdown 代码块。"
      ].join("\n");
    }
    if (stage === "issue_list_cleaner") {
      return [
        "请只做格式修复，不要重新审稿、不要新增/删除/合并问题、不要改变问题清单正文。",
        `当前本地解析错误：${error.message}`,
        "请重新输出上一条回复：先输出问题清单.txt 正文，然后在末尾追加 issue_list JSON: sidecar。",
        "issue_list JSON 必须是严格 JSON 对象并包含 issues 数组；禁止 Markdown 代码块。"
      ].join("\n");
    }
    if (stage === "adjudicator_parameters") {
      return [
        "请只做格式修复，不要重新裁决、不要改变评分、优先问题或结论参数。",
        `当前本地解析错误：${error.message}`,
        "请重新输出上一条回复：先输出结论参数.txt 或裁决报告.txt 正文，然后在末尾追加 conclusion_parameters JSON: sidecar。",
        "conclusion_parameters JSON 必须是严格 JSON 对象并包含 overall_score 和六维 dimension_scores；禁止 Markdown 代码块。"
      ].join("\n");
    }
    return [
      "请只修复上一条回复的 JSON 格式，不要重新审稿、不要新增/删除/合并问题、不要改变评分或问题正文。",
      `当前本地 JSON 解析错误：${error.message}`,
      "请返回严格 JSON，禁止 Markdown 代码块，禁止 JSON 之外文字。"
    ].join("\n");
  })();
  await pastePrompt(page, repairPrompt).catch(async () => {
    await clickComposer(page);
    await page.keyboard.type(repairPrompt, { delay: 0 });
  });
  await clickSend(page);
}

async function prepareLogin(args) {
  const context = await launchContext(args);
  const page = await getMainPage(context, args["target-url"] || DEFAULT_TARGET_URL);
  console.log("Dedicated Chrome profile is open.");
  console.log(`Profile: ${ensureAbsolute(args["profile-dir"] || DEFAULT_PROFILE_DIR)}`);
  console.log("Log in to ChatGPT, select GPT-5.5, set 智能水平 to 高级/超高/专业, then leave this process running or press Ctrl+C when done.");
  console.log("If human verification cannot be completed here, stop this command and run prepare-login-manual.");
  console.log(`Current URL: ${page.url()}`);
  await new Promise((resolve) => {
    process.on("SIGINT", resolve);
    process.stdin.resume();
  });
  await context.close();
}

async function prepareLoginManual(args) {
  const profileDir = ensureAbsolute(args["profile-dir"] || DEFAULT_PROFILE_DIR);
  const targetUrl = args["target-url"] || DEFAULT_TARGET_URL;
  if (!fssync.existsSync(CHROME_EXECUTABLE)) {
    throw new Error(`Chrome executable not found: ${CHROME_EXECUTABLE}`);
  }
  await ensureDir(profileDir);
  const child = spawn(
    CHROME_EXECUTABLE,
    [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      targetUrl
    ],
    {
      detached: true,
      stdio: "ignore"
    }
  );
  child.unref();
  console.log("Manual Chrome login window opened without Playwright control.");
  console.log(`Profile: ${profileDir}`);
  console.log("Use that window to log in, pass human verification, select GPT-5.5, and set 智能水平 to 高级/超高/专业.");
  console.log("After it works normally, close that Chrome window, then run preflight.");
}

async function prepareCdp(args) {
  const profileDir = ensureAbsolute(args["profile-dir"] || DEFAULT_PROFILE_DIR);
  const targetUrl = args["target-url"] || DEFAULT_TARGET_URL;
  const endpoint = cdpEndpoint(args);
  const port = new URL(endpoint).port || "9222";
  if (!fssync.existsSync(CHROME_EXECUTABLE)) {
    throw new Error(`Chrome executable not found: ${CHROME_EXECUTABLE}`);
  }
  await ensureDir(profileDir);
  const existingInfo = await cdpInfo(endpoint);
  if (existingInfo) {
    console.log(JSON.stringify({
      ok: true,
      already_running: true,
      cdp_endpoint: endpoint,
      browser: existingInfo.Browser,
      websocket: existingInfo.webSocketDebuggerUrl,
      profile_dir: profileDir,
      next: `npm run web-review:browser -- doctor --cdp --target-model "${args["target-model"] || DEFAULT_TARGET_MODEL}" --intelligence-level "${requestedIntelligenceLevel(args)}"`
    }, null, 2));
    return;
  }
  if (await profileAppearsOpen(profileDir)) {
    throw new Error(`Dedicated profile is already open without CDP. Close that Chrome window first, then run prepare-cdp: ${profileDir}`);
  }
  const child = spawn(
    CHROME_EXECUTABLE,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      targetUrl
    ],
    {
      detached: true,
      stdio: "ignore"
    }
  );
  child.unref();
  const info = await waitForCdp(endpoint, 20000);
  console.log(JSON.stringify({
    ok: Boolean(info),
    cdp_endpoint: endpoint,
    browser: info?.Browser || null,
    websocket: info?.webSocketDebuggerUrl || null,
    profile_dir: profileDir,
    chrome_pid: child.pid,
    next: info
      ? `Log in/select GPT-5.5 and 智能水平 ${requestedIntelligenceLevel(args)} in the opened window, keep it open, then run: npm run web-review:browser -- doctor --cdp --target-model "${args["target-model"] || DEFAULT_TARGET_MODEL}" --intelligence-level "${requestedIntelligenceLevel(args)}"`
      : "Chrome was launched, but the CDP endpoint was not reachable yet. Check the window, then rerun prepare-cdp."
  }, null, 2));
  if (!info) process.exitCode = 2;
}

async function migrateLegacyProfile(args) {
  const sourceProfile = LEGACY_PROFILE_DIR;
  const targetProfile = ensureAbsolute(args["profile-dir"] || DEFAULT_PROFILE_DIR);
  if (sourceProfile === targetProfile) {
    console.log(JSON.stringify({ ok: true, migrated: false, reason: "legacy path equals current path", profile_dir: targetProfile }, null, 2));
    return;
  }
  if (!(await fileExists(sourceProfile))) {
    throw new Error(`Legacy profile not found: ${sourceProfile}`);
  }
  if (await profileAppearsOpen(sourceProfile)) {
    throw new Error(`Legacy profile appears to be open. Close the manual Chrome window first: ${sourceProfile}`);
  }
  if (await profileAppearsOpen(targetProfile)) {
    throw new Error(`Target profile appears to be open. Close the runner Chrome window first: ${targetProfile}`);
  }
  if (await fileExists(targetProfile)) {
    throw new Error(`Target profile already exists; refusing to overwrite: ${targetProfile}`);
  }
  await ensureDir(path.dirname(targetProfile));
  await fs.cp(sourceProfile, targetProfile, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return !base.startsWith("Singleton") && base !== "DevToolsActivePort";
    }
  });
  console.log(JSON.stringify({
    ok: true,
    migrated: true,
    source_profile: sourceProfile,
    target_profile: targetProfile
  }, null, 2));
}

async function clickIntelligenceSelector(page) {
  const openMenu = page.locator("[data-testid='composer-intelligence-picker-content'], [role='menu']").filter({ hasText: /智能水平/ }).last();
  if (await openMenu.count().catch(() => 0)) {
    if (await openMenu.isVisible().catch(() => false)) return null;
  }
  const detected = await detectIntelligenceLevel(page);
  for (const candidate of detected.candidates || []) {
    const loc = page.locator("button,[role='button']").filter({ hasText: candidate.level }).last();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ timeout: 10000 }).catch(() => null);
      await page.waitForTimeout(1000);
      return candidate;
    }
  }
  const fallback = page.locator("button,[role='button']").filter({ hasText: /^(极速|均衡|高级|超高|专业|Pro)$/ }).last();
  if (await fallback.count().catch(() => 0)) {
    await fallback.click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    return null;
  }
  throw new Error("Could not find ChatGPT intelligence-level selector button");
}

async function chooseIntelligenceLevel(page, level) {
  const desired = normalizeIntelligenceLevel(level, null);
  if (!desired || !PRODUCTION_INTELLIGENCE_LEVELS.includes(desired)) {
    throw new Error(`Unsupported production intelligence level: ${level}. Use 高级, 超高, or 专业.`);
  }
  const before = await detectIntelligenceLevel(page);
  if (before.level === desired) return { changed: false, before: before.level, after: before.level };
  await clickIntelligenceSelector(page);
  const optionLocators = [
    page.getByRole("menuitemradio", { name: new RegExp(`^${desired}$`) }),
    page.getByRole("menuitem", { name: new RegExp(`^${desired}$`) }),
    page.getByRole("option", { name: new RegExp(`^${desired}$`) }),
    page.getByText(desired, { exact: true })
  ];
  let clicked = false;
  for (const loc of optionLocators) {
    const count = await loc.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const item = loc.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.click({ timeout: 10000 }).catch(() => null);
      clicked = true;
      break;
    }
    if (clicked) break;
  }
  if (!clicked) throw new Error(`Could not find intelligence-level menu option: ${desired}`);
  await page.waitForTimeout(1500);
  const after = await detectIntelligenceLevel(page);
  if (after.level !== desired) {
    throw new Error(`Intelligence level selection did not take effect; detected ${after.level || "unknown"}, expected ${desired}`);
  }
  return { changed: true, before: before.level, after: after.level };
}

async function selectIntelligence(args) {
  const selectArgs = { ...args, cdp: args.cdp ?? true };
  const level = requestedIntelligenceLevel(selectArgs);
  const session = await launchSession(selectArgs);
  try {
    const page = await getMainPage(session.context, selectArgs["target-url"] || DEFAULT_TARGET_URL);
    let beforeState = await pageState(page, selectArgs["target-model"] || DEFAULT_TARGET_MODEL, {
      intelligenceLevel: level,
      allowedIntelligenceLevels: [level]
    });
    if (beforeState.loggedOut || !beforeState.hasComposer) {
      throw new Error("ChatGPT page is not logged in or composer is unavailable.");
    }
    if (!beforeState.intelligenceLevelVisible) {
      await page.goto(selectArgs["target-url"] || DEFAULT_TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
      beforeState = await pageState(page, selectArgs["target-model"] || DEFAULT_TARGET_MODEL, {
        intelligenceLevel: level,
        allowedIntelligenceLevels: [level]
      });
      if (beforeState.loggedOut || !beforeState.hasComposer) {
        throw new Error("ChatGPT home page is not logged in or composer is unavailable after reopening a new chat.");
      }
    }
    const selection = await chooseIntelligenceLevel(page, level);
    const afterState = await pageState(page, selectArgs["target-model"] || DEFAULT_TARGET_MODEL, {
      intelligenceLevel: level,
      allowedIntelligenceLevels: [level]
    });
    const ok = afterState.intelligenceLevelDetected === level;
    console.log(JSON.stringify({
      ok,
      command: "select-intelligence",
      target_url: selectArgs["target-url"] || DEFAULT_TARGET_URL,
      target_model: selectArgs["target-model"] || DEFAULT_TARGET_MODEL,
      intelligence_level: level,
      browser_connection_mode: session.mode,
      before: {
        intelligence_level_detected: beforeState.intelligenceLevelDetected,
        url: beforeState.url,
        title: beforeState.title
      },
      selection,
      after: {
        intelligence_level_detected: afterState.intelligenceLevelDetected,
        intelligence_level_ok: afterState.intelligenceLevelAllowed,
        url: afterState.url,
        title: afterState.title
      }
    }, null, 2));
    if (!ok) process.exitCode = 2;
  } finally {
    await session.close().catch(() => null);
  }
}

async function preflight(args) {
  const session = await launchSession(args);
  const page = await getMainPage(session.context, args["target-url"] || DEFAULT_TARGET_URL);
  const requestedLevel = requestedIntelligenceLevel(args);
  const allowedLevels = allowedIntelligenceLevels(args);
  const state = await pageState(page, args["target-model"] || DEFAULT_TARGET_MODEL, {
    intelligenceLevel: requestedLevel,
    allowedIntelligenceLevels: allowedLevels
  });
  const results = {
    time: nowIso(),
    profile_dir: ensureAbsolute(args["profile-dir"] || DEFAULT_PROFILE_DIR),
    target_url: args["target-url"] || DEFAULT_TARGET_URL,
    target_model: args["target-model"] || DEFAULT_TARGET_MODEL,
    intelligence_level: requestedLevel,
    allowed_intelligence_levels: allowedLevels,
    chrome_executable: CHROME_EXECUTABLE,
    browser_connection_mode: session.mode,
    cdp_endpoint: session.endpoint,
    cdp_browser: session.browser,
    cdp_websocket: session.websocket,
    checks: {
      chrome_exists: fssync.existsSync(CHROME_EXECUTABLE),
      logged_in: !state.loggedOut && state.hasComposer,
      composer_found: state.hasComposer,
      model_available: !state.modelAtCapacity,
      model_text_visible: state.modelVisible,
      intelligence_level_ok: state.intelligenceLevelAllowed,
      intelligence_level_visible: state.intelligenceLevelVisible,
      clipboard_write: false,
      clipboard_read: false,
      download_dir_writable: false
    },
    state
  };
  try {
    await writeClipboard(page, "web-review-runner-preflight");
    results.checks.clipboard_write = true;
    results.checks.clipboard_read = (await readClipboard(page)) === "web-review-runner-preflight";
  } catch (error) {
    results.clipboard_error = error.message;
  }
  try {
    const tmp = path.join(ROOT, "storage", "web-review-runs", ".preflight-write-test");
    await ensureDir(path.dirname(tmp));
    await fs.writeFile(tmp, "ok");
    await fs.rm(tmp, { force: true });
    results.checks.download_dir_writable = true;
  } catch (error) {
    results.download_dir_error = error.message;
  }
  if (args["live-smoke"]) {
    try {
      await newConversation(page, args["target-url"] || DEFAULT_TARGET_URL);
      const smokePrompt = 'Return exactly this strict JSON and nothing else: {"ok":true,"stage":"preflight"}';
      await pastePrompt(page, smokePrompt);
      await clickSend(page);
      await waitForGeneration(page, 180000);
      const smokeScratch = {
        raw: path.join(ROOT, "storage", "web-review-runs"),
        rawCandidates: path.join(ROOT, "storage", "web-review-runs", ".preflight-candidates"),
        screenshots: path.join(ROOT, "storage", "web-review-runs")
      };
      await ensureDir(smokeScratch.rawCandidates);
      const smokeRaw = await extractOutput(page, smokeScratch, "preflight", {
        retries: [],
        conversations: []
      });
      const smokeJson = extractBalancedJson(smokeRaw);
      results.checks.live_smoke_json = smokeJson?.ok === true && smokeJson?.stage === "preflight";
    } catch (error) {
      results.checks.live_smoke_json = false;
      results.live_smoke_error = error.message;
    }
  }
  const blockingChecks = ["chrome_exists", "logged_in", "composer_found", "model_available", "intelligence_level_ok", "clipboard_write", "clipboard_read", "download_dir_writable"];
  results.blocking_failures = blockingChecks.filter((key) => !results.checks[key]);
  results.warnings = [];
  if (!results.checks.model_text_visible) {
    results.warnings.push("Target model text was not visible in page body; if you selected it manually, this is non-blocking.");
  }
  if (!results.checks.intelligence_level_visible) {
    results.warnings.push("Intelligence level was not detected in page controls; select 高级/超高/专业 manually if this is a production run.");
  } else if (!results.checks.intelligence_level_ok) {
    results.warnings.push(`Detected intelligence level ${state.intelligenceLevelDetected}; expected ${allowedLevels.join(" / ")}.`);
  }
  results.ok = results.blocking_failures.length === 0;
  console.log(JSON.stringify(results, null, 2));
  await session.close();
  if (!results.ok) process.exitCode = 2;
}

async function doctor(args) {
  const doctorArgs = { ...args, cdp: args.cdp ?? true };
  const endpoint = cdpEndpoint(doctorArgs);
  const profileDir = ensureAbsolute(doctorArgs["profile-dir"] || DEFAULT_PROFILE_DIR);
  const cdp = await cdpInfo(endpoint);
  const requestedLevel = requestedIntelligenceLevel(doctorArgs);
  const allowedLevels = allowedIntelligenceLevels(doctorArgs);
  const results = {
    time: nowIso(),
    ok: false,
    command: "doctor",
    profile_dir: profileDir,
    profile_appears_open: await profileAppearsOpen(profileDir),
    target_url: doctorArgs["target-url"] || DEFAULT_TARGET_URL,
    target_model: doctorArgs["target-model"] || DEFAULT_TARGET_MODEL,
    intelligence_level: requestedLevel,
    allowed_intelligence_levels: allowedLevels,
    chrome_executable: CHROME_EXECUTABLE,
    cdp_endpoint: endpoint,
    checks: {
      chrome_exists: fssync.existsSync(CHROME_EXECUTABLE),
      cdp_reachable: Boolean(cdp),
      logged_in: false,
      composer_found: false,
      model_available: false,
      intelligence_level_ok: false,
      intelligence_level_visible: false,
      clipboard_write: false,
      clipboard_read: false,
      download_dir_writable: false
    },
    blocking_failures: [],
    warnings: []
  };
  if (!cdp) {
    results.blocking_failures.push("cdp_reachable");
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = 2;
    return;
  }
  const session = await launchSession(doctorArgs);
  try {
    const page = await getMainPage(session.context, doctorArgs["target-url"] || DEFAULT_TARGET_URL);
    const state = await pageState(page, doctorArgs["target-model"] || DEFAULT_TARGET_MODEL, {
      intelligenceLevel: requestedLevel,
      allowedIntelligenceLevels: allowedLevels
    });
    results.browser_connection_mode = session.mode;
    results.cdp_browser = session.browser;
    results.cdp_websocket = session.websocket;
    results.state = state;
    results.checks.logged_in = !state.loggedOut && state.hasComposer;
    results.checks.composer_found = state.hasComposer;
    results.checks.model_available = !state.modelAtCapacity;
    results.checks.model_text_visible = state.modelVisible;
    results.checks.intelligence_level_ok = state.intelligenceLevelAllowed;
    results.checks.intelligence_level_visible = state.intelligenceLevelVisible;
    try {
      await writeClipboard(page, "web-review-runner-doctor");
      results.checks.clipboard_write = true;
      results.checks.clipboard_read = (await readClipboard(page)) === "web-review-runner-doctor";
    } catch (error) {
      results.clipboard_error = error.message;
    }
    try {
      const tmp = path.join(ROOT, "storage", "web-review-runs", ".doctor-write-test");
      await ensureDir(path.dirname(tmp));
      await fs.writeFile(tmp, "ok");
      await fs.rm(tmp, { force: true });
      results.checks.download_dir_writable = true;
    } catch (error) {
      results.download_dir_error = error.message;
    }
    const blockingChecks = ["chrome_exists", "cdp_reachable", "logged_in", "composer_found", "model_available", "intelligence_level_ok", "clipboard_write", "clipboard_read", "download_dir_writable"];
    results.blocking_failures = blockingChecks.filter((key) => !results.checks[key]);
    if (!results.checks.model_text_visible) {
      results.warnings.push("Target model text was not visible in page body; if you selected it manually, this is non-blocking.");
    }
    if (!results.checks.intelligence_level_visible) {
      results.warnings.push("Intelligence level was not detected in page controls; select 高级/超高/专业 manually if this is a production run.");
    } else if (!results.checks.intelligence_level_ok) {
      results.warnings.push(`Detected intelligence level ${state.intelligenceLevelDetected}; expected ${allowedLevels.join(" / ")}.`);
    }
    results.ok = results.blocking_failures.length === 0;
    console.log(JSON.stringify(results, null, 2));
    if (!results.ok) process.exitCode = 2;
  } finally {
    await session.close().catch(() => null);
  }
}

function normalizeRunArgs(args) {
  const next = { ...args };
  if (!next["allow-persistent"]) next.cdp = next.cdp ?? true;
  if (!next["upload-mode"]) next["upload-mode"] = next["prefer-library"] ? "recent" : "local";
  if (!next.cleaner) next.cleaner = "web";
  return next;
}

async function runOrResume(args, resume = false) {
  args = normalizeRunArgs(args);
  const runDir = ensureAbsolute(args["run-dir"] || (resume ? requireArg(args, "run-dir") : defaultRunDir(args.manuscript)));
  const paths = runPaths(runDir);
  await initRunDirs(paths);
  const contextJson = resume ? await readJson(paths.context) : await buildContext(paths, args);
  if (!contextJson) throw new Error(`Missing context.json in ${runDir}`);
  const manuscriptPath = ensureAbsolute(args.manuscript || contextJson.manuscript?.path || contextJson.artifactManifest?.file_path || "");
  const originalFileName = String(
    args["original-file-name"] ||
    contextJson.manuscript?.originalFilename ||
    path.basename(manuscriptPath || "")
  ).trim();
  const metadata = await loadMetadata(paths, {
    targetModel: args["target-model"] || DEFAULT_TARGET_MODEL,
    intelligenceLevel: requestedIntelligenceLevel(args),
    allowedIntelligenceLevels: allowedIntelligenceLevels(args),
    targetUrl: args["target-url"] || DEFAULT_TARGET_URL,
    profileDir: args["profile-dir"] || DEFAULT_PROFILE_DIR,
    manuscript: {
      file_path: manuscriptPath,
      original_file_name: originalFileName
    },
    prompts: args.prompts || contextJson.sourcePromptSnapshot || null
  });
  if (!metadata.manuscript?.file_path) {
    metadata.manuscript = {
      file_path: manuscriptPath || ensureAbsolute(requireArg(args, "manuscript")),
      original_file_name: originalFileName
    };
  }
  metadata.runner = "web-browser";
  metadata.runner_engine = "playwright-cdp-dedicated-chrome";
  metadata.target_model = args["target-model"] || metadata.target_model || DEFAULT_TARGET_MODEL;
  metadata.intelligence_level = requestedIntelligenceLevel(args, metadata);
  metadata.allowed_intelligence_levels = allowedIntelligenceLevels(args);
  metadata.target_url = args["target-url"] || metadata.target_url || DEFAULT_TARGET_URL;
  metadata.profile_dir = ensureAbsolute(args["profile-dir"] || metadata.profile_dir || DEFAULT_PROFILE_DIR);
  if (args["original-file-name"]) metadata.manuscript.original_file_name = String(args["original-file-name"]).trim();
  metadata.notes = metadata.notes || [];
  await saveMetadata(paths, metadata);
  const fromStage = args["from-stage"];
  const startIndex = fromStage ? STAGE_ORDER.indexOf(fromStage) : 0;
  if (fromStage && startIndex < 0) throw new Error(`Unknown --from-stage: ${fromStage}`);
  const stages = STAGE_ORDER.slice(Math.max(0, startIndex));
  const cleanerMode = String(args.cleaner || "web").toLowerCase();
  let session = null;
  let page = null;
  async function ensureWebPage() {
    if (page) return page;
    session = await launchSession(args);
    page = await getMainPage(session.context, args["target-url"] || DEFAULT_TARGET_URL);
    metadata.browser_connection_mode = session.mode;
    metadata.cdp_endpoint = session.endpoint;
    metadata.cdp_browser = session.browser;
    metadata.cdp_websocket = session.websocket;
    const state = await pageState(page, args["target-model"] || metadata.target_model || DEFAULT_TARGET_MODEL, {
      intelligenceLevel: metadata.intelligence_level,
      allowedIntelligenceLevels: metadata.allowed_intelligence_levels || PRODUCTION_INTELLIGENCE_LEVELS
    });
    metadata.run_start_state = metadata.run_start_state || state;
    if (state.loggedOut || !state.hasComposer) {
      throw new Error("ChatGPT page is not logged in or composer is unavailable. Run prepare-cdp, log in/select model, keep the window open, then resume with --cdp.");
    }
    if (state.modelAtCapacity) {
      throw new Error("Selected model is at capacity. Wait for the target model to recover or explicitly approve a different model before resuming.");
    }
    if (!state.intelligenceLevelAllowed) {
      throw new Error(`Detected ChatGPT intelligence level ${state.intelligenceLevelDetected || "unknown"}; expected ${state.intelligenceLevelAllowedValues.join(" / ")}. Run select-intelligence or change the page manually before resuming.`);
    }
    if (!state.modelVisible) {
      metadata.notes.push("Target model text was not visible at run start; proceeding assumes the user manually selected the requested model.");
    }
    if (!state.intelligenceLevelVisible) {
      metadata.notes.push("Intelligence level was not visible at run start; proceeding assumes the user manually selected 高级/超高/专业.");
    }
    return page;
  }
  try {
    metadata.cleaner_mode = cleanerMode;
    metadata.upload_mode = args["upload-mode"] || "local";
    for (const stage of stages) {
      if (stage === "issue_list_cleaner" && cleanerMode !== "web") {
        await runLocalIssueListCleaner({ paths, metadata });
      } else {
        if (stage === "adjudicator_parameters") await validateIssueListGate(paths);
        await runStage({ page: await ensureWebPage(), paths, context: contextJson, metadata, args, stage });
      }
      await saveMetadata(paths, metadata);
    }
    metadata.completed_at = nowIso();
    await saveMetadata(paths, metadata);
    await buildPackage(paths, contextJson, metadata);
    console.log(`Run complete: ${path.join(paths.outputs, "web_review_package.txt")}`);
  } catch (error) {
    recordPause(metadata, "runner", "automation_failed", error.message);
    await saveMetadata(paths, metadata);
    console.error(`Automation paused: ${error.message}`);
    console.error(`Run directory: ${runDir}`);
    console.error("After resolving the page state, resume with:");
    console.error(`  npm run web-review:browser -- resume --run-dir "${runDir}"`);
    process.exitCode = 2;
  } finally {
    await session?.close?.().catch(() => null);
  }
}

async function buildPackage(paths, contextJson = null, metadata = null) {
  const context = contextJson || await readJson(paths.context);
  if (!context) throw new Error("Missing context.json");
  const currentMetadata = metadata || await loadMetadata(paths, {});
  await validateIssueListGate(paths);
  await validateStageFiles(paths, "adjudicator_parameters");
  const agentReports = {};
  for (const key of AGENT_STAGES) {
    const rawPath = path.join(paths.raw, stageFileName(key, "raw.txt"));
    if (!(await fileExists(rawPath))) throw new Error(`Missing raw agent output: ${rawPath}`);
    agentReports[key] = (await fs.readFile(rawPath, "utf8")).trim();
  }
  const issueListText = (await readIssueListText(paths)).trim();
  const conclusionText = (await readConclusionText(paths)).trim();
  const finalMetadata = {
    ...currentMetadata,
    runner: currentMetadata.runner || "web-browser",
    runner_engine: currentMetadata.runner_engine || "playwright-cdp-dedicated-chrome",
    workflow_version: "v4-txt-source-only",
    completed_at: currentMetadata.completed_at || nowIso(),
    stage_state_path: path.resolve(paths.state)
  };
  const sections = [
    ["runner_metadata JSON:", JSON.stringify(finalMetadata, null, 2)],
    ["artifact_manifest JSON:", JSON.stringify(context.artifactManifest || context.artifact_manifest || {}, null, 2)],
    ["agent1.txt:", agentReports.topic_innovation_rationale || ""],
    ["agent2.txt:", agentReports.statistical_details || ""],
    ["agent3.txt:", agentReports.fulltext_consistency_numerical_audit || ""],
    ["agent4.txt:", agentReports.figure_table_quality || ""],
    ["agent5.txt:", agentReports.misc_compliance_expression || ""],
    ["问题清单.txt:", issueListText],
    ["裁决者参数.txt:", conclusionText]
  ];
  const output = sections.map(([label, body]) => `${label}\n${body}`).join("\n\n");
  await writeJson(paths.metadata, finalMetadata);
  await writeText(path.join(paths.outputs, "web_review_package.txt"), output);
  await writeJson(path.join(paths.outputs, "web_review_package.metadata.json"), {
    created_at: nowIso(),
    package_chars: output.length,
    package_sha256: sha256(output),
    sections: sections.map(([label]) => label.replace(/:$/, "")),
    output_path: path.resolve(path.join(paths.outputs, "web_review_package.txt"))
  });
  return output;
}

async function packageOnly(args) {
  const runDir = ensureAbsolute(requireArg(args, "run-dir"));
  const paths = runPaths(runDir);
  const output = await buildPackage(paths);
  console.log(JSON.stringify({
    ok: true,
    output_path: path.resolve(path.join(paths.outputs, "web_review_package.txt")),
    chars: output.length,
    sha256: sha256(output)
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help) {
    console.log(usage());
    return;
  }
  if (command === "prepare-login") return prepareLogin(args);
  if (command === "prepare-login-manual") return prepareLoginManual(args);
  if (command === "prepare-cdp") return prepareCdp(args);
  if (command === "migrate-legacy-profile") return migrateLegacyProfile(args);
  if (command === "select-intelligence") return selectIntelligence(args);
  if (command === "preflight") return preflight(args);
  if (command === "doctor") return doctor(args);
  if (command === "run") return runOrResume(args, false);
  if (command === "resume") return runOrResume(args, true);
  if (command === "package") return packageOnly(args);
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main()
  .then(() => {
    setImmediate(() => process.exit(process.exitCode || 0));
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    setImmediate(() => process.exit(1));
  });
