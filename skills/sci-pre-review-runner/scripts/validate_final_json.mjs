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

console.log("final_adjudication JSON is valid");
