---
name: web-review-runner
description: Semi-automate the intron_tools V4 clinical SCI pre-review workflow through the logged-in ChatGPT web UI, using GPT-5.5 with production 智能水平 set to 高级, 超高, or 专业. Runs five independent Agent TXT outputs, a web cleaner 问题清单.txt, and a web adjudicator 裁决者参数.txt, then produces a backend-pasteable V4 TXT-only package.
---

# Web Review Runner

Use this skill when the user wants to run the manuscript pre-review through the ChatGPT web UI instead of the local API or Codex model.

The local app still creates the manual task and generates DOCX/PDF after the final V4 package is pasted back. This skill does not log in, solve CAPTCHA, store credentials, call the local API model config, or generate reports directly.

## Safety Gate

Before the first upload or first send of manuscript content, obtain one task-level approval naming the destination web page/model and the exact Word file path. After that approval, continue the same task without repeated confirmation unless the destination, model, or manuscript path changes.

Pause for login/CAPTCHA/account/payment prompts, ambiguous upload/send state, wrong file/model, unrecoverable truncation, or browser/system permission prompts.

## Workflow

1. Build the local context package:

```bash
node /Users/a682/.codex/skills/sci-pre-review-runner/scripts/build_review_context.mjs \
  --manuscript "/path/to/manuscript.docx" \
  --customer-info "客户信息" \
  --project-root "/Users/a682/Documents/New project 2" \
  --prompts "/path/to/prompt-snapshot.json" \
  --format json
```

2. Use the dedicated Playwright/CDP runner:

```bash
npm run web-review:browser -- prepare-cdp --profile-dir storage/browser-profiles/chatgpt-web-runner-cdp
npm run web-review:browser -- select-intelligence --cdp --intelligence-level "高级"
npm run web-review:browser -- doctor --cdp --target-model "GPT-5.5" --intelligence-level "高级"
npm run web-review:browser -- run \
  --manuscript "/path/to/manuscript.docx" \
  --customer-info "客户信息" \
  --prompts "/path/to/prompt-snapshot.json" \
  --original-file-name "original_manuscript.docx" \
  --target-model "GPT-5.5" \
  --intelligence-level "高级" \
  --cdp \
  --upload-mode local
```

3. Run five independent Agent conversations:

- Upload the original Word file.
- Paste the raw published Agent prompt, stripped of runtime adapters.
- Save the exact response as `agent1.txt` through `agent5.txt`.
- Do not request or repair JSON sidecars.
- Do not double-run an Agent or run a consistency comparator.

4. Run the cleaner in a new conversation:

- Do not upload the Word manuscript.
- Provide only the five Agent TXT outputs.
- Save the exact response as `问题清单.txt`.
- The cleaner must not re-review the manuscript or invent new issues.

5. Run the adjudicator in a new conversation:

- Upload the original Word file.
- Provide `问题清单.txt`.
- Save the exact response as `裁决者参数.txt`.
- Do not request JSON sidecars.
- The adjudicator outputs only parameters: summary, overall conclusion, score, six dimension scores, risk level, revision workload, submission recommendation, priority issue IDs, publication positioning, and checklist.

6. Stop after `裁决者参数.txt`. There is no final-report Agent in V4.

## Backend Package

Return one backend-pasteable V4 package:

```text
runner_metadata JSON:
{ "runner": "web-browser", "workflow_version": "v4-txt-source-only" }

artifact_manifest JSON:
{ "...": "optional Python artifact detection result" }

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

## Quality Rules

- PDF/Word generation must rely only on `问题清单.txt` and `裁决者参数.txt`.
- Missing critical fields should fail import instead of being silently filled.
- `问题清单.txt` should contain each issue's ID, title, severity, module, precise location, why it is a problem, submission risk, and low-cost recommendation.
- `裁决者参数.txt` should contain overall score, six dimension scores, risk level, summary, overall conclusion, priority issue IDs, and publication positioning. A pre-submission checklist is optional unless the active adjudicator prompt explicitly requires it; if absent, the backend report should omit that section.
