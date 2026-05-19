---
name: sci-pre-review-runner
description: Run the V2.1 clinical SCI manuscript pre-submission review workflow from the intron_tools project. Use when Codex is given a Word manuscript (.doc or .docx) and customer information and must produce backend-pasteable manual-run outputs for Python artifact detection, six double-run Agents, consistency comparison, merged issue lists, adjudicator_review JSON, and final_adjudication JSON final-output package.
---

# SCI Pre-Review Runner

## Overview

Use this skill to replace the model-calling part of the local pre-submission QC app when the user provides a Word manuscript and customer information. Produce one complete V2.1 output package that can be pasted into the admin manual-run workbench.

This skill does not call the web app API, does not read API configs, and does not generate DOCX/PDF reports. The app remains responsible for report generation after the V2.1 package is pasted back into the admin UI.

## Workflow

1. Collect:
   - Manuscript path (`.doc` or `.docx` only).
   - Customer information text: institution, department, research area, target journal, article type, special concerns, and similar context.
2. Run `scripts/build_review_context.mjs` to parse the Word file, run Python artifact detection, extract image occurrences from `.docx` files, and build the V2.1 review prompts:
   ```bash
   node /Users/a682/.codex/skills/sci-pre-review-runner/scripts/build_review_context.mjs \
     --manuscript "/absolute/path/to/manuscript.docx" \
     --customer-info "客户信息文本" \
     --project-root "/Users/a682/Documents/New project 2" \
     --prompts "/absolute/path/to/task_prompt_snapshot.json"
   ```
   The `--prompts` argument is optional for ad hoc runs, but required when the admin system provides a task-level prompt snapshot path.
   By default, `.docx` image occurrences are extracted into `storage/extracted-images/manual-<task_id>/img_00x.<ext>` under the project root. Use `--image-extract-dir "/absolute/path"` only when a specific extraction directory is required.
3. Execute the six Agents in the exact stage-key order from the generated context:
   - `selection_innovation`
   - `clinical_methods`
   - `statistical_results`
   - `numerical_audit`
   - `figure_table_visual_audit`
   - `submission_safety_expression`
   For `selection_innovation`, first run targeted web searches for recent directly relevant evidence: guidelines, consensus statements, systematic reviews, meta-analyses, real-world studies, and same-topic clinical cohort studies from the past 3-5 years. Use search results only to support concrete Agent 1 issues, compress the finding into that issue's `evidence` field, and do not write a standalone literature review. If search is unavailable or inconclusive, do not claim the topic is outdated, saturated, or guideline-inconsistent; state that the manuscript does not provide enough recent evidence.
   For `statistical_results`, web search is optional and should be limited to method/reporting standards when the manuscript itself cannot resolve a diagnostic-performance, prediction-model, cutoff, or statistical-reporting question. Do not write a standalone methods review.
   Before running `numerical_audit` and `figure_table_visual_audit`, inspect every reviewable `image_sequence[].extracted_path` listed in the generated context with the available image-viewing capability. Cite stable image IDs in evidence, for example `img_001 / inferred_label: Figure 1 / label_confidence: high`.
   For `numerical_audit`, only judge figure-internal numbers when you actually read the figure image or readable figure text. If only `artifact_manifest`, figure references, or legends are available, report the audit limitation and do not claim figure-internal numbers are consistent.
   For `figure_table_visual_audit`, explicitly record whether each relevant Figure image body was actually reviewable. If an extracted image cannot be opened, is a non-reviewable format, or is only indirectly represented by caption/reference text, mark the observation as `review_status: not_reviewable` in the evidence wording and do not judge clarity, resolution, font, color, layout, AI-image traces, axes, or other image-body quality.
   For `submission_safety_expression`, web search is optional and limited to authorization/registration/copyright/reference-authenticity/target-journal format checks. Use findings only as issue evidence; do not write a standalone background or policy review.
4. For each Agent, perform two independent runs:
   - Use the same Agent system prompt, user prompt, manuscript material, customer information, and `artifact_manifest`.
   - Do not reference the first run while producing the second run.
   - Do not pass one Agent's output into another Agent.
   - Each run should return the Agent JSON requested by its prompt, especially the `issues` array.
   - Each issue should include `issue_narrative`: a complete natural-language review paragraph with issue number/title, severity, evidence, submission risk, and low-cost revision path. P0/P1 narratives should be detailed enough to resemble a human reviewer comment rather than a short label.
5. For each Agent, compare the two runs:
   - Use the `consistency_comparator` prompt from the generated context.
   - Report overall issue overlap and P0/P1 overlap.
   - Keep every P0/P1 issue found by either run unless there is a clear evidence-based reason to exclude it, and mark uncertain items as needing human review.
   - Merge duplicate or near-duplicate issues into that Agent's final issue list.
6. Execute adjudicator review only after all six merged Agent issue lists are complete:
   - Use the `adjudicator_review` system prompt.
   - Include the manuscript material, `artifact_manifest`, six consistency reports, and six merged issue lists.
   - Run it once only; do not double-run it and do not pass it through the consistency comparator.
   - Return strict JSON only, without Markdown fences or extra prose.
7. Execute final output only after `adjudicator_review JSON` is complete:
   - Use the `final_adjudication` system prompt. Its business meaning is now "终稿输出".
   - Use `adjudicator_review JSON` as the primary source for the final report fields.
   - Include the manuscript material, `artifact_manifest`, six consistency reports, and six merged issue lists.
   - Produce customer-facing report content: priority 5-10 issues, precise searchable locations, strengths, weaknesses, final issue list, and no internal double-run, comparator, prompt, token, or extraction-process wording in customer fields.
   - Produce `report_content.score_summary` with model-generated fuzzy scoring: `overall_score`, `overall_score_label`, `overall_score_rationale`, and six `dimension_scores`. Do not use a fixed backend deduction formula in the customer-facing rationale.
   - Return strict JSON only, without Markdown fences or extra prose.
8. Validate the final JSON with:
   ```bash
   node /Users/a682/.codex/skills/sci-pre-review-runner/scripts/validate_final_json.mjs --input "/path/to/final.json"
   ```

## Output Format

Return a backend-pasteable V2.1 package in this exact order:

```text
artifact_manifest JSON:
{
  "...": "Python 文件状态检测结果",
  "image_sequence": [
    {
      "image_id": "img_001",
      "extracted_path": "/absolute/path/to/img_001.png",
      "inferred_label": "Figure 1",
      "label_confidence": "high",
      "review_status": "pending_manual_review"
    }
  ]
}

agent_runs:
{
  "selection_innovation": {
    "run_1": { "issues": [] },
    "run_2": { "issues": [] }
  },
  "clinical_methods": {
    "run_1": { "issues": [] },
    "run_2": { "issues": [] }
  },
  "statistical_results": {
    "run_1": { "issues": [] },
    "run_2": { "issues": [] }
  },
  "numerical_audit": {
    "run_1": { "issues": [] },
    "run_2": { "issues": [] }
  },
  "figure_table_visual_audit": {
    "run_1": { "issues": [] },
    "run_2": { "issues": [] }
  },
  "submission_safety_expression": {
    "run_1": { "issues": [] },
    "run_2": { "issues": [] }
  }
}

agent_consistency_reports:
{
  "selection_innovation": {
    "run1IssueCount": 0,
    "run2IssueCount": 0,
    "mergedIssueCount": 0,
    "overlapIssueCount": 0,
    "overallOverlapRate": 0.0,
    "run1P0P1Count": 0,
    "run2P0P1Count": 0,
    "mergedP0P1Count": 0,
    "overlapP0P1Count": 0,
    "p0p1OverlapRate": 0.0,
    "onlyInRun1": [],
    "onlyInRun2": [],
    "overlapIssues": [],
    "severityChanged": [],
    "notes": "No standalone stability rating; rates use 0-1 decimals."
  }
}

agent_merged_issue_lists:
{
  "selection_innovation": [
    {
      "severity": "P1",
      "category": "selection_innovation",
      "issue": "A1-M01｜问题短标题",
      "evidence": "证据",
      "location": "位置",
      "recommendation": "建议",
      "issue_narrative": "问题编号、短标题、风险等级、依据、问题及投稿风险、低成本处理方向组成的完整审稿正文",
      "risk_analysis": "可选：风险机制说明",
      "evidence_quotes": ["可选：原文片段"],
      "revision_path": ["可选：修订步骤"],
      "confidence": 0.8,
      "source_runs": ["run_1", "run_2"],
      "source_issue_ids": ["run_1:A1-01", "run_2:A1-03"]
    }
  ]
}

adjudicator_review JSON:
{
  "adjudication_summary": "...",
  "overall_judgment": {},
  "priority_actions": [],
  "final_issue_list": [],
  "adjudication_decisions": [],
  "excluded_issues": [],
  "severity_counts": { "P0": 0, "P1": 0, "P2": 0, "P3": 0, "total": 0 },
  "issue_distribution": {},
  "consistency_metrics": {},
  "artifact_quality_summary": {},
  "manuscript_strengths": [],
  "major_weaknesses": [],
  "dimension_diagnosis": {}
}

final_adjudication JSON:
{
  "summary": "...",
  "overall_conclusion": "...",
  "must_fix": [],
  "suggested_fix": [],
  "text_and_figure_comments": [],
  "compliance_risk": [],
  "pre_submission_checklist": [],
  "final_review_text": "...",
  "report_content": {
    "score_summary": {
      "overall_score": 0,
      "overall_score_label": "暂不建议投稿|大修后可投稿|勉强达到可投稿水平|投稿准备较成熟",
      "overall_score_rationale": "客户可读的综合评分理由，不写机械扣分规则",
      "dimension_scores": [
        { "key": "selection_innovation", "title": "选题创新性", "score": 0, "rationale": "一句话评分理由" },
        { "key": "clinical_methods", "title": "研究设计与临床逻辑", "score": 0, "rationale": "一句话评分理由" },
        { "key": "statistical_results", "title": "统计分析与证据支撑", "score": 0, "rationale": "一句话评分理由" },
        { "key": "numerical_audit", "title": "数据一致性", "score": 0, "rationale": "一句话评分理由" },
        { "key": "figure_table_visual_audit", "title": "图表质量与呈现完整性", "score": 0, "rationale": "一句话评分理由" },
        { "key": "submission_safety_expression", "title": "投稿合规与成稿完整性", "score": 0, "rationale": "一句话评分理由" }
      ]
    }
  }
}
```

The `summary` field must be no longer than 200 Chinese characters. Array fields must be JSON arrays. Array items may be strings or objects.
The optional `report_content` object should carry adjudicator-derived structured data for PDF/report visualization where available. When `adjudicator_review JSON` or a complete issue pool is available, it must include the model-generated `score_summary`; the app reads these scores directly for Word/PDF and does not compute customer-facing scores by mechanical deduction.

For debugging quality, do not omit `issue_narrative` from Agent, comparator, or adjudicator issue objects. The admin stage-output TXT uses this field first, then falls back to `evidence` / `recommendation`.

## Prompt Snapshot

Load `references/prompts.json` only when prompt details are needed. It contains the current effective prompt snapshot from the app database and no API keys, uploaded files, tasks, reports, or encrypted configuration. The `content` field is the backend prompt text plus the runtime adapter layer; `rawContentHash`, `adapterVersion`, and `effectiveContentHash` are included for debugging.

When the app's backend prompts change, refresh the snapshot:

```bash
node /Users/a682/.codex/skills/sci-pre-review-runner/scripts/export_prompts_from_project.mjs \
  --project-root "/Users/a682/Documents/New project 2"
```

The refresh script requires exactly one published version for all ten prompt points:
`global_system`, six V2.1 review Agents, `consistency_comparator`, `adjudicator_review`, and `final_adjudication` (终稿输出).
