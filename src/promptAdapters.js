import crypto from "node:crypto";

export const PROMPT_ADAPTER_VERSION = "runtime-adapter.v10.20260614-v3-txt-sidecar-six-score";

const REVIEW_STAGES = [
  { key: "topic_innovation_rationale", title: "Agent 1 选题创新及合理性", prefix: "A1", dimension: "选题创新及合理性" },
  { key: "statistical_details", title: "Agent 2 统计学细节", prefix: "A2", dimension: "统计学细节" },
  { key: "fulltext_consistency_numerical_audit", title: "Agent 3 全文一致性与数值审计结果", prefix: "A3", dimension: "全文一致性与数值审计" },
  { key: "figure_table_quality", title: "Agent 4 图表质量与呈现完整性", prefix: "A4", dimension: "图表质量与呈现完整性" },
  { key: "misc_compliance_expression", title: "Agent 5 杂项与投稿安全表达", prefix: "A5", dimension: "杂项、合规与表达" }
];

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function stageInfo(stageKey) {
  return REVIEW_STAGES.find((stage) => stage.key === stageKey);
}

function sharedEvidenceRules() {
  return `【通用证据与边界规则】
1. 只能基于本次输入材料判断，包括任务信息、客户信息、artifact_manifest、可审阅图片清单、文稿全文，以及当前调用点明确提供的上游结果。不得编造文稿中不存在的信息。
2. 每条问题必须有可复核依据，优先引用可搜索原文短句、章节小节、图表编号、表题、图注、变量名、数字、声明区字段或 artifact_manifest 线索。
3. P0/P1 不得因不确定而遗漏；证据不足但风险较高时保留并标注“需人工复核”。P3 严格少列。
4. 坚持最小修稿原则，优先给出低成本处理动作：补充关键说明、统一数字、补充图表/图注/表题、弱化结论、限定外推、补充伦理/注册/数据声明、删除高风险表达。
5. 本阶段必须严守职责边界；不得主动扩展到其他 Agent、清洁员或裁决者参数职责。`;
}

function agentAdapter(info) {
  return `【程序适配层：${info.title} 输出契约】
本段只规定程序可解析输出和最低质量线，不改变前文自然语言提示词的审稿方向。若前文要求固定 TXT、不得输出 JSON、不得输出表格，以固定 TXT 正文为主体；但为了后台稳定解析，必须在 TXT 正文之后额外附加一段 sidecar：agent_report JSON。不要把 JSON 混入 TXT 正文。

${sharedEvidenceRules()}

必须输出两个连续段落，禁止 Markdown 代码块：

${info.prefix}_审稿结果.txt:
按前文自然语言提示词要求输出固定 TXT 正文。每条正式问题应保留编号、问题标题、风险等级、依据/精准定位、问题及投稿风险、低成本处理方向。若前文要求只输出 P0/P1/P2，则 TXT 正文按前文执行。

agent_report JSON:
{
  "schema_version": "v3.agent_report.v1",
  "stage": "${info.key}",
  "issues": [],
  "positive_findings": [],
  "review_summary": "本阶段简要结论"
}

issues 数组中每个问题对象必须包含：
- "severity": "P0|P1|P2|P3"
- "category": "${info.key}"
- "issue": "${info.prefix}-01｜具体问题短标题"
- "evidence": "可搜索原文片段 + 审稿质疑逻辑 + 投稿风险"
- "location": "章节/图表/表格/原句/变量/数字等精确定位线索"
- "recommendation": "可执行低成本修订路径"
- "issue_narrative": "自然语言完整审稿正文"
- "confidence": 0.8

可选增强字段：risk_analysis、submission_risk、evidence_quotes、revision_path。若输出这些字段，必须与 issue_narrative 一致。

agent_report JSON 是后台 sidecar，不是客户正文，不违背前文“TXT 主体、不使用表格”的要求。它必须忠实映射 TXT 中的问题，不得新增 TXT 中没有的问题，不得删减 P0/P1/P2 问题。

issue_narrative 必须按以下中文结构组织：问题编号、问题短标题、风险等级、依据、问题及投稿风险、低成本处理方向。P0/P1 目标 250-600 中文字符，必须解释为什么编辑或外审会质疑、影响哪类投稿判断、最低成本怎么处理；P2 目标 150-350 中文字符；P3 只列确有价值的问题。

evidence 不得只写一句概括。必须尽量包含能在文稿中搜索到的原文短句、图表/表格编号、变量名、数字或图注片段。recommendation 不得写“建议完善/优化/补充”这类空泛句，必须说明补充到哪个章节、统一哪些数字、如何降调结论、是否补表/补图/补敏感性说明。

若本阶段未发现值得列出的问题，TXT 正文写明本 Agent 在本职能范围内未发现值得列出的具体问题，并在 agent_report JSON 中返回：
{ "schema_version": "v3.agent_report.v1", "stage": "${info.key}", "issues": [], "positive_findings": [], "review_summary": "本 Agent 在本职能范围内未发现值得列出的具体问题。" }`;
}

function cleanerAdapter() {
  return `【程序适配层：清洁员输出契约】
清洁员只读取 5 个 Agent 的报告，负责汇总、去重、清洗、编号、归类和客户可读化；不得读取原始 Word、文稿全文或任何原文档派生材料；不得重新审稿，不得新增 5 个 Agent 均未提出的问题，不得删除高风险问题。

若前文自然语言提示词要求“纯文本、不使用 JSON”，该要求只约束客户/人工可读的“问题清单.txt”正文。为了让后台稳定生成 Word/PDF，你仍必须在“问题清单.txt”之后额外附加一段 sidecar：issue_list JSON。不要把 JSON 混入问题清单正文。

必须输出两个连续段落，禁止 Markdown 代码块：

问题清单.txt:
一份可直接给人工阅读的问题清单。每条问题至少包含：问题编号、级别、归属维度、问题标题、精确定位、为什么是问题、投稿风险、低成本处理建议、来源 Agent。语言可以自然，但必须保留 Agent 原始审稿意见的信息密度。

issue_list JSON:
{
  "schema_version": "v3.issue_list.v1",
  "issue_count": 0,
  "severity_counts": { "P0": 0, "P1": 0, "P2": 0, "P3": 0, "total": 0 },
  "issue_distribution": {},
  "issues": []
}

issues 每条必须包含：
{
  "id": "IL-001",
  "severity": "P0|P1|P2|P3",
  "category": "topic_innovation_rationale|statistical_details|fulltext_consistency_numerical_audit|figure_table_quality|misc_compliance_expression|cross_agent",
  "primary_dimension": "选题创新及合理性|统计学细节|全文一致性与数值审计|图表质量与呈现完整性|杂项、合规与表达",
  "issue": "具体问题标题",
  "location": "可搜索原文片段/章节/图表/表格/变量/数字",
  "explanation": "为什么是问题",
  "submission_risk": "投稿风险",
  "recommendation": "低成本处理建议",
  "source_agents": ["topic_innovation_rationale"],
  "source_issue_ids": ["A1-01"],
  "issue_narrative": "继承或整合后的完整自然语言审稿正文",
  "confidence": 0.8
}`;
}

function adjudicatorParametersAdapter() {
  return `【程序适配层：裁决者参数输出契约】
裁决者参数 Agent 只读取 Word 文稿和清洁员生成的问题清单，输出评分、优先级、投稿判断和 PDF/Word 页面级文本参数；不得输出长篇问题正文，不得删改问题清单，不得重新生成完整问题池。issue_list JSON 只作为问题 ID、级别、维度和后台解析锚点，不能替代“问题清单.txt”的长文本判断。

若前文自然语言提示词要求输出“裁决报告.txt”，系统统一将其归一保存为“结论参数.txt”；两者是同一类裁决参数文本。V3 当前采用六维评分：选题价值、研究设计、统计分析、数据可信、图表呈现、写作表达。若前文出现“五维评分/五维诊断”，以本段六维为准。

P3 不参与综合评分、六维评分和 Top 10/优先问题排序；但 P3 仍应保留在上游“问题清单.txt / issue_list JSON”中，供最终完整问题清单和投稿前杂项检查使用。不要因为 P3 不参与评分而要求清洁员删除 P3。

必须输出两个连续段落，禁止 Markdown 代码块：

结论参数.txt:
面向人工阅读的参数摘要，包含综合评分、六维评分、风险等级、修订工作量、投稿建议、优先处理问题 ID、主要短板、主要优势、摘要、总体结论和页面级报告导语。不要展开每条问题正文。

conclusion_parameters JSON:
{
  "schema_version": "v3.conclusion_parameters.v1",
  "summary": "200字以内摘要",
  "overall_conclusion": "客户可读总体预审结论",
  "overall_score": 0,
  "overall_score_label": "暂不建议投稿|大修后可投稿|勉强达到可投稿水平|投稿准备较成熟",
  "overall_score_rationale": "客户可读评分理由，不写机械扣分公式",
  "dimension_scores": [
    { "key": "topic_value", "title": "选题价值", "score": 0, "rationale": "一句话理由" },
    { "key": "study_design", "title": "研究设计", "score": 0, "rationale": "一句话理由" },
    { "key": "statistical_analysis", "title": "统计分析", "score": 0, "rationale": "一句话理由" },
    { "key": "data_credibility", "title": "数据可信", "score": 0, "rationale": "一句话理由" },
    { "key": "figure_presentation", "title": "图表呈现", "score": 0, "rationale": "一句话理由" },
    { "key": "writing_expression", "title": "写作表达", "score": 0, "rationale": "一句话理由" }
  ],
  "submission_recommendation": "",
  "risk_level": "低风险|中等风险|中高风险|高风险|极高风险",
  "revision_workload": "小修|中修|大修",
  "priority_issue_ids": [],
  "manuscript_strengths": [],
  "major_weaknesses": [],
  "dimension_diagnosis": {},
  "pre_submission_checklist": [],
  "pdf_text_set": {
    "cover_subtitle": "封面副标题",
    "overview_lead": "一页式总览导语",
    "score_interpretation": "评分解读，不写扣分公式",
    "strengths_intro": "优势导语",
    "weaknesses_intro": "短板导语",
    "priority_issues_intro": "优先问题页导语",
    "full_issue_list_intro": "完整问题清单页导语",
    "checklist_intro": "检查清单导语",
    "closing_note": "报告收束语"
  },
  "artifact_completion_summary": {
    "overview": "投稿材料规范摘要",
    "key_risks": [],
    "recommended_actions": []
  }
}

评分是模型模糊评分，不写扣分公式。存在 P0 时综合评分原则上低于 60；大修稿通常低于 70；70 分以上表示勉强达到可投稿准备水平。priority_issue_ids 必须引用 issue_list JSON 中的 id。

summary、overall_conclusion、pdf_text_set、pre_submission_checklist 和 artifact_completion_summary 将直接进入客户版 Word/PDF。语言必须自然、客户友好，不得出现 source_runs、runner_metadata、artifact_manifest、prompt、token、latency、JSON key 裸露、模型过程或内部调试词。artifact_completion_summary 应聚焦 Title page、Declarations、伦理/知情同意、References、STROBE checklist、补充材料、图表编号闭合、投稿系统材料等客户需要补齐的事项；若问题清单中没有相关 P0-P2 问题，可简要说明未锁定重点风险，不要编造。`;
}

function finalReportAdapter() {
  return `【程序适配层：终稿报告输出契约】
终稿 Agent 严格只读取“问题清单.txt”和“结论参数.txt”，生成后端可渲染为客户版 Word/PDF 的报告内容 JSON。你不直接读取论文全文、artifact_manifest、issue_list JSON 或 conclusion_parameters JSON；不重新审稿，不删减问题，不合并问题，不改变评分。完整问题正文由后端根据 issue_list JSON 物化，你只负责客户版页面文本和报告组织。

必须返回严格 JSON，禁止 Markdown 代码块，禁止 JSON 之外文字。8 个基础字段必须存在：
{
  "summary": "200字以内摘要",
  "overall_conclusion": "总体预审结论",
  "must_fix": [],
  "suggested_fix": [],
  "text_and_figure_comments": [],
  "compliance_risk": [],
  "pre_submission_checklist": [],
  "final_review_text": "完整报告正文",
  "report_content": {
    "source": "v3_issue_list_cleaner",
    "submission_recommendation": "",
    "risk_level": "",
    "revision_workload": "",
    "severity_counts": { "P0": 0, "P1": 0, "P2": 0, "P3": 0, "total": 0 },
    "issue_distribution": {},
    "dimension_diagnosis": {},
    "manuscript_strengths": [],
    "major_weaknesses": [],
    "score_summary": {
      "overall_score": 0,
      "overall_score_label": "",
      "overall_score_rationale": "",
      "dimension_scores": []
    },
    "priority_issue_ids": [],
    "priority_actions": [],
    "final_issue_list": [],
    "pdf_text_set": {
      "cover_subtitle": "面向临床 SCI 投稿前的结构化质控、风险定位与修改优先级建议",
      "overview_lead": "一页式总览导语",
      "score_interpretation": "评分解读，不写扣分公式",
      "strengths_intro": "稿件优势导语",
      "weaknesses_intro": "主要短板导语",
      "priority_issues_intro": "优先处理问题页导语",
      "full_issue_list_intro": "完整问题清单页导语",
      "checklist_intro": "投稿前检查清单导语",
      "closing_note": "报告收束语"
    },
    "artifact_completion_summary": { "overview": "", "key_risks": [], "recommended_actions": [] }
  }
}

report_content.score_summary 必须忠实继承“结论参数.txt”中的综合评分和维度评分；不得自行调分。priority_actions 只能根据“结论参数.txt”中的优先问题 ID 和“问题清单.txt”的对应问题生成客户友好摘要；不得改变优先级。final_issue_list 如无法从 TXT 稳定完整复写，可以返回空数组或简要占位，后端会用 issue_list JSON 物化完整问题池，不得编造或压缩问题。

report_content.artifact_completion_summary 在 V3 中用于“投稿材料规范摘要”，不是流程状态总结。它必须聚焦 Title page、Declarations、伦理/知情同意、References、STROBE checklist、补充材料、图表编号闭合、投稿系统材料等客户需要补齐的事项；不得写“已整理报告内容”“保留综合评分”“不重新审稿”“后端渲染”等流程性话术。若问题清单中没有相关问题，可简要写“未锁定单独的投稿材料规范问题”，不要编造。

pdf_text_set 是 PDF/Word 的页面级文本集，只写客户可读导语、总览、评分解读、优势短板说明、优先问题说明、检查清单说明和收束语；不要在其中展开内部流程。客户字段不得出现 source_runs、runner_metadata、artifact_manifest、prompt、token、latency、JSON key 裸露、模型过程或内部调试词。`;
}

export function getPromptAdapter(stageKey) {
  const info = stageInfo(stageKey);
  if (info) return agentAdapter(info);
  if (stageKey === "issue_list_cleaner") return cleanerAdapter();
  if (stageKey === "adjudicator_parameters") return adjudicatorParametersAdapter();
  if (stageKey === "final_report_output") return finalReportAdapter();
  return "";
}

export function buildEffectivePrompt(stageKey, rawPrompt) {
  const adapter = getPromptAdapter(stageKey).trim();
  const raw = String(rawPrompt || "").trim();
  if (!adapter) return raw;
  return [
    raw,
    `【系统运行时适配层 ${PROMPT_ADAPTER_VERSION}】`,
    adapter
  ].filter(Boolean).join("\n\n");
}

export function getPromptAdapterMetadata(stageKey) {
  const content = getPromptAdapter(stageKey).trim();
  return {
    version: PROMPT_ADAPTER_VERSION,
    contentHash: sha256(content),
    contentLength: content.length
  };
}
