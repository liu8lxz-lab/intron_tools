#!/usr/bin/env node
import fs from "node:fs/promises";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
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

function stripJsonFence(text) {
  let value = String(text || "").trim();
  const fenceMatch = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) value = fenceMatch[1].trim();
  return value;
}

const DIMENSIONS = [
  { key: "selection_innovation", title: "选题创新性" },
  { key: "clinical_methods", title: "研究设计与临床逻辑" },
  { key: "statistical_results", title: "统计分析与证据支撑" },
  { key: "numerical_audit", title: "数据一致性" },
  { key: "figure_table_visual_audit", title: "图表质量与呈现完整性" },
  { key: "submission_safety_expression", title: "投稿合规与成稿完整性" }
];

function readScore(value, options = {}) {
  const text = String(value ?? "").trim();
  const tenPointMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*10\b/i);
  if (tenPointMatch) return Math.round(Number(tenPointMatch[1]) * 10);
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(options.scale10 ? number * 10 : number);
}

function isValidPercentScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function validateScoreSummary(value) {
  const reportContent = value.report_content;
  if (!reportContent || typeof reportContent !== "object" || Array.isArray(reportContent)) {
    throw new Error("Missing field: report_content");
  }
  const scoreSummary = reportContent.score_summary;
  if (!scoreSummary || typeof scoreSummary !== "object" || Array.isArray(scoreSummary)) {
    throw new Error("Missing field: report_content.score_summary");
  }

  const scoreText = JSON.stringify(scoreSummary);
  const placeholderPatterns = [
    /未.{0,8}稳定提供/,
    /未在输入材料中.{0,12}提供/,
    /输入材料未.{0,12}提供/,
    /仅能依据问题分布判断/,
    /无法评分/,
    /不能评分/,
    /not\s+provided/i,
    /not\s+available/i,
    /\bN\/A\b/i
  ];
  if (placeholderPatterns.some((pattern) => pattern.test(scoreText))) {
    throw new Error("report_content.score_summary contains placeholder scoring text");
  }

  const overallScore = readScore(scoreSummary.overall_score ?? scoreSummary.overallScore)
    ?? readScore(scoreSummary.overall_score_10 ?? scoreSummary.overallScore10 ?? scoreSummary.overall_score_text, { scale10: true });
  if (!isValidPercentScore(overallScore)) {
    throw new Error("report_content.score_summary.overall_score must be a valid 0-100 integer or equivalent 10-point score");
  }

  const rawDimensions = Array.isArray(scoreSummary.dimension_scores)
    ? scoreSummary.dimension_scores
    : Array.isArray(scoreSummary.dimensionScores)
      ? scoreSummary.dimensionScores
      : [];
  const dimensionScores = DIMENSIONS.map((dimension) => {
    const found = rawDimensions.find((item) => {
      if (!item || typeof item !== "object") return false;
      return item.key === dimension.key || item.stage === dimension.key || item.title === dimension.title || item.dimension === dimension.title;
    });
    const score = readScore(found?.score ?? found?.value)
      ?? readScore(found?.score_10 ?? found?.score10 ?? found?.score_text ?? found?.scoreText, { scale10: true });
    return { ...dimension, score };
  });
  const missing = dimensionScores.filter((item) => !isValidPercentScore(item.score));
  if (missing.length) {
    throw new Error(`report_content.score_summary.dimension_scores missing valid scores: ${missing.map((item) => item.title).join(", ")}`);
  }

  const allScores = [overallScore, ...dimensionScores.map((item) => item.score)];
  if (allScores.every((score) => score === 0)) {
    throw new Error("report_content.score_summary is all zero, likely an unrepaired schema placeholder");
  }
}

const args = parseArgs(process.argv.slice(2));
const inputPath = requireString(args.input, "--input");
const raw = await fs.readFile(inputPath, "utf8");
const value = JSON.parse(stripJsonFence(raw));

if (!value || typeof value !== "object" || Array.isArray(value)) {
  throw new Error("final_adjudication JSON top level must be an object");
}

const requiredKeys = [
  "summary",
  "overall_conclusion",
  "must_fix",
  "suggested_fix",
  "text_and_figure_comments",
  "compliance_risk",
  "pre_submission_checklist",
  "final_review_text"
];
const arrayKeys = [
  "must_fix",
  "suggested_fix",
  "text_and_figure_comments",
  "compliance_risk",
  "pre_submission_checklist"
];

for (const key of requiredKeys) {
  if (!(key in value)) throw new Error(`Missing field: ${key}`);
}
for (const key of arrayKeys) {
  if (!Array.isArray(value[key])) throw new Error(`Field must be an array: ${key}`);
}

const summaryLength = Array.from(String(value.summary || "")).length;
if (summaryLength > 200) {
  throw new Error(`summary must be <= 200 Chinese characters, got ${summaryLength}`);
}

validateScoreSummary(value);

console.log("final_adjudication JSON is valid");
