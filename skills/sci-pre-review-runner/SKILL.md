---
name: sci-pre-review-runner
description: Run the intron_tools V4 clinical SCI manuscript pre-submission review workflow. Use when Codex is given a Word manuscript and customer information and must produce backend-pasteable V4 TXT-only manual-run outputs for five Agents, the cleaner, and the adjudicator.
---

# SCI Pre-Review Runner

Use this skill to replace the model-calling part of the local pre-submission QC app when the user provides a Word manuscript and customer information.

The app remains responsible for parsing, task management, DOCX/PDF rendering, and downloads. The runner should produce one complete V4 TXT-only package for the admin manual-run workbench.

## Workflow

1. Collect:
   - Word manuscript path (`.doc` or `.docx`).
   - Customer information.
   - Prompt snapshot path if the app provides one.

2. Build the review context:

```bash
node /Users/a682/.codex/skills/sci-pre-review-runner/scripts/build_review_context.mjs \
  --manuscript "/absolute/path/to/manuscript.docx" \
  --customer-info "客户信息文本" \
  --project-root "/Users/a682/Documents/New project 2" \
  --prompts "/absolute/path/to/task_prompt_snapshot.json"
```

3. Run the five review Agents once each:
   - `topic_innovation_rationale`
   - `statistical_details`
   - `fulltext_consistency_numerical_audit`
   - `figure_table_quality`
   - `misc_compliance_expression`

   Each Agent uses the original Word manuscript and its published prompt. Save exact TXT outputs as `agent1.txt` through `agent5.txt`. Do not double-run Agents, do not run a consistency comparator, and do not request JSON sidecars.

4. Image handling:
   - Before Agent 3 and Agent 4, inspect reviewable images listed in the generated context when image paths are available.
   - Only judge figure-internal details when the actual figure body is reviewable.
   - If image extraction or viewing is limited, state the limitation in the TXT output.

5. Run the cleaner:
   - Input only the five Agent TXT files.
   - Do not provide original Word, parsed manuscript text, artifact manifest, or image checklist.
   - Save exact output as `问题清单.txt`.
   - The cleaner must not re-review the manuscript or invent issues absent from the five Agent reports.

6. Run the adjudicator:
   - Input original Word + `问题清单.txt`.
   - Save exact output as `裁决者参数.txt`.
   - The adjudicator only outputs parameters: summary, overall conclusion, score, six dimension scores, risk level, revision workload, submission recommendation, priority issue IDs, publication positioning, and checklist.
   - It must not rewrite long issue bodies or compress the issue list.

7. Stop after `裁决者参数.txt`. V4 has no final-report Agent.

## Output Package

Return a backend-pasteable V4 package in this exact shape:

```text
runner_metadata JSON:
{
  "runner": "codex-skill",
  "target_model": "manual",
  "workflow_version": "v4-txt-source-only",
  "notes": []
}

artifact_manifest JSON:
{
  "...": "optional Python artifact detection result"
}

agent1.txt:
<Agent 1 full TXT>

agent2.txt:
<Agent 2 full TXT>

agent3.txt:
<Agent 3 full TXT>

agent4.txt:
<Agent 4 full TXT>

agent5.txt:
<Agent 5 full TXT>

问题清单.txt:
<Cleaner full TXT>

裁决者参数.txt:
<Adjudicator full TXT>
```

## Required TXT Content

`问题清单.txt` should contain each issue's:

- 问题编号
- 问题名称
- P 分级
- 归属模块
- 精确定位
- 介绍/问题描述
- 投稿风险
- 处理建议

`裁决者参数.txt` should contain:

- 完整英文题目 and 完整中文题目 when available
- 风险度评估 / 风险等级
- 200字摘要
- 优先处理问题 ID
- 修改方向 / 投稿建议
- 总体评分
- 六维评分 and short rationale
- 总体判断
- 重点风险
- 建议处理动作
- 预期SCI发表 / 修后投稿定位
- 投稿前检查清单（仅当裁决者提示词或网页输出自然包含时；若缺失，后台报告不显示该章节）

If critical fields are missing, the backend should reject import rather than inventing content. The pre-submission checklist is optional unless the active adjudicator prompt explicitly requires it.
