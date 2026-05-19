import crypto from "node:crypto";

export const PROMPT_ADAPTER_VERSION = "runtime-adapter.v1.20260519";

const REVIEW_STAGES = [
  { key: "selection_innovation", title: "选题创新预审", prefix: "A1", dimension: "选题创新性" },
  { key: "clinical_methods", title: "临床方法预审", prefix: "A2", dimension: "研究设计与临床逻辑" },
  { key: "statistical_results", title: "统计结果预审", prefix: "A3", dimension: "统计分析与证据支撑" },
  { key: "numerical_audit", title: "数值审计预审", prefix: "A4", dimension: "数据一致性" },
  { key: "figure_table_visual_audit", title: "图表与视觉材料审计", prefix: "A5", dimension: "图表质量与呈现完整性" },
  { key: "submission_safety_expression", title: "投稿安全与表达预审", prefix: "A6", dimension: "投稿合规与成稿完整性" }
];

const DIMENSION_SCHEMA = `[
  { "key": "selection_innovation", "title": "选题创新性", "score": 0, "rationale": "一句话评分理由" },
  { "key": "clinical_methods", "title": "研究设计与临床逻辑", "score": 0, "rationale": "一句话评分理由" },
  { "key": "statistical_results", "title": "统计分析与证据支撑", "score": 0, "rationale": "一句话评分理由" },
  { "key": "numerical_audit", "title": "数据一致性", "score": 0, "rationale": "一句话评分理由" },
  { "key": "figure_table_visual_audit", "title": "图表质量与呈现完整性", "score": 0, "rationale": "一句话评分理由" },
  { "key": "submission_safety_expression", "title": "投稿合规与成稿完整性", "score": 0, "rationale": "一句话评分理由" }
]`;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function stageInfo(stageKey) {
  return REVIEW_STAGES.find((stage) => stage.key === stageKey);
}

function globalAdapter() {
  return `【程序适配层：全局底座】
本段由系统在运行时追加，用于保护后台解析和报告生成链路；它不替代你在后台维护的自然语言提示词。若自然语言提示词与本段在输出字段、JSON 结构或禁止事项上冲突，以本段为准；医学判断、审稿深度和具体问题识别仍优先遵守自然语言提示词。

1. 必须只基于本次输入材料判断，包括任务信息、客户信息、artifact_manifest、图片审阅清单、文稿全文，以及当前调用点明确提供的阶段结果。不得编造文稿不存在的信息。
2. 所有问题必须有可复核依据，优先引用可搜索原文短句、章节小节、图表编号、表题、图注、变量名、数字、声明区字段或 artifact_manifest 线索。
3. P0/P1 不得因不确定而遗漏；证据不足但风险较高时保留并标注“需人工复核”。低价值 P3 严格少列。
4. 坚持最小修稿原则，优先给出低成本处理动作：补充 Methods 关键细节、统一数字、补充图表/图注/表题、弱化结论、限定外推、补充伦理/注册/数据声明、删除高风险表达。
5. 每个 Agent 必须严守本阶段职责边界；比较器只比较两轮输出；裁决者只裁定六 Agent 已提出的问题；终稿输出只做客户版组织和表达。`;
}

function agentAdapter(info) {
  return `【程序适配层：${info.title} 输出契约】
本段只规定程序可解析输出和最低质量线，不改变前文自然语言提示词的审稿方向。必须返回严格 JSON，禁止 Markdown 代码块，禁止 JSON 之外文字。

输出顶层结构：
{
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

可选增强字段：risk_analysis、evidence_quotes、revision_path。若输出这些字段，必须与 issue_narrative 一致。

issue_narrative 必须按以下中文结构组织：问题编号、问题短标题、风险等级、依据、问题及投稿风险、低成本处理方向。P0/P1 目标 250-600 中文字符，必须解释为什么编辑或外审会质疑、影响哪类投稿判断、最低成本怎么处理；P2 目标 150-350 中文字符；P3 只列确有价值的问题。

evidence 不得只写一句概括。必须尽量包含能在文稿中搜索到的原文短句、图表/表格编号、变量名、数字或图注片段。recommendation 不得写“建议完善/优化/补充”这类空泛句，必须说明补充到哪个章节、统一哪些数字、如何降调结论、是否补表/补图/补敏感性说明。

若本阶段未发现值得列出的问题，返回：
{ "issues": [], "positive_findings": [], "review_summary": "本 Agent 在本职能范围内未发现值得列出的具体问题。" }`;
}

function comparatorAdapter() {
  return `【程序适配层：一致性比较器输出契约】
本段只规定程序可解析输出。你只比较同一 Agent 的 run_1 与 run_2，不重新审稿，不新增两轮均未提出的问题。单轮出现且证据明确的 P0/P1 必须保留。

必须返回严格 JSON，顶层只能包含：
{
  "consistency": {
    "run1IssueCount": 0,
    "run2IssueCount": 0,
    "mergedIssueCount": 0,
    "overlapIssueCount": 0,
    "overallOverlapRate": 0,
    "run1P0P1Count": 0,
    "run2P0P1Count": 0,
    "mergedP0P1Count": 0,
    "overlapP0P1Count": 0,
    "p0p1OverlapRate": 0,
    "onlyInRun1": [],
    "onlyInRun2": [],
    "overlapIssues": [],
    "severityChanged": [],
    "notes": ""
  },
  "mergedIssues": []
}

重合度使用 0-1 小数；分母为 0 时写 1，并在 notes 说明无可比较问题。mergedIssues 每条必须保留 severity、category、issue、evidence、location、recommendation、confidence、source_runs，可保留 source_issue_ids。

若 run_1 或 run_2 中有 issue_narrative、risk_analysis、evidence_quotes、revision_path，mergedIssues 必须保留或重写这些字段，不得压缩成一句话。合并版 issue 使用 M 编号，例如 A2-M01｜具体问题短标题。`;
}

function adjudicatorAdapter() {
  return `【程序适配层：裁决者裁定输出契约】
本段只规定程序可解析输出。裁决者不是第 7 个审稿 Agent，不新增六 Agent 均未提出的独立问题；只对六 Agent 合并问题清单进行复核、去重、合并、升级/降级、排除和优先级排序。裁决者只运行一次。

必须返回严格 JSON，禁止 Markdown，禁止 JSON 之外文字。顶层结构：
{
  "adjudication_summary": "200字以内裁决摘要",
  "overall_judgment": {
    "submission_recommendation": "暂不建议投稿，需先处理阻断级问题|暂不建议直接投稿，完成关键修订后可进入投稿阶段|基本具备投稿基础，建议先完成定向优化|整体较成熟，可进入投稿准备阶段",
    "risk_level": "低风险|中等风险|中高风险|高风险|极高风险",
    "revision_workload": "小修|中修|大修",
    "revision_workload_reason": "一句话说明"
  },
  "priority_actions": [],
  "final_issue_list": [],
  "adjudication_decisions": [],
  "excluded_issues": [],
  "severity_counts": { "P0": 0, "P1": 0, "P2": 0, "P3": 0, "total": 0 },
  "issue_distribution": {},
  "consistency_metrics": { "overall_notes": "", "agent_metrics": [], "low_consistency_risks": [] },
  "artifact_quality_summary": { "image_count": 0, "table_count": 0, "caption_count": 0, "image_extraction_status": "", "quality_flags": [], "review_limitation": "" },
  "manuscript_strengths": [],
  "major_weaknesses": [],
  "dimension_diagnosis": {}
}

final_issue_list 和 priority_actions 的问题对象字段：
id、severity、category、primary_dimension、issue、location、explanation、recommendation、confidence、source_agents、source_issue_ids、source_runs、adjudication_action。location 必须包含章节/图表/表格 + 可搜索原文短句、图注片段、变量名或数字；不得只写 Methods、Results、Figure 1、Table 2。

priority_actions 必须是 final_issue_list 的子集或等价引用。severity_counts 与 issue_distribution 必须以 final_issue_list 为口径。P0/P1 被排除时，excluded_issues.exclusion_reason 必须写清楚原文复核理由。若上游有 issue_narrative、risk_analysis、evidence_quotes、revision_path，裁定时必须读取并尽量保留到成立的问题中。不得输出最终数值评分。`;
}

function finalAdapter() {
  return `【程序适配层：终稿输出 JSON 契约】
本段只规定程序可解析输出和客户版屏蔽规则。终稿输出不是重新审稿；若输入有 adjudicator_review JSON，必须以裁决者结果为唯一事实来源。若暂未提供裁决者结果，只能基于六 Agent 合并清单做最小必要报告化表达，不得新增六 Agent 均未提出的独立问题。

必须只返回严格 JSON，禁止 Markdown，禁止 JSON 之外文字。8 个基础字段必须存在：
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
    "source": "adjudicator_review|agent_merged_issue_lists",
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
      "overall_score_label": "暂不建议投稿|大修后可投稿|勉强达到可投稿水平|投稿准备较成熟",
      "overall_score_rationale": "客户可读综合评分理由，不写机械扣分规则",
      "dimension_scores": ${DIMENSION_SCHEMA}
    },
    "priority_actions": [],
    "final_issue_list": [],
    "artifact_completion_summary": { "overview": "", "key_risks": [], "recommended_actions": [] }
  }
}

客户版屏蔽规则：summary、overall_conclusion、must_fix、suggested_fix、text_and_figure_comments、compliance_risk、pre_submission_checklist、final_review_text、report_content 中不得出现扣分公式、评分规则、双跑一致性、重合度、run_1/run_2、source_runs、source_issue_ids、Python、artifact_manifest、图片 ID、extracted_path、prompt、token、latency、模型过程等内部调试信息。真实风险必须转成客户可理解表述。

模型模糊评分规则：overall_score 和 dimension_scores[].score 为 0-100 整数，由你基于最终问题池、六维表现、P0/P1 严重度、可修复性和成稿完整度综合判断，不按固定扣分公式机械计算。存在 P0 时综合评分和相关维度原则上低于 60；大修稿通常低于 70；70 分以上表示整体勉强达到可投稿准备水平；80 分以上表示投稿准备较成熟，通常不应存在 P0 且 P1 数量较少。报告中不得写“按 P0/P1/P2/P3 扣多少分”。

priority_actions 输出 5-10 条优先处理问题；若最终问题不足 5 条则按实际数量。每条必须包含 severity、primary_dimension、issue、location、explanation、recommendation。final_issue_list 是最终完整问题池，每条必须包含 severity、category、primary_dimension、issue、location、explanation、recommendation、confidence，不得包含内部来源字段。location 必须能定位到可搜索原句、图表编号、表格编号、图注片段、变量名或数字；不得只写粗略章节。`;
}

export function getPromptAdapter(stageKey) {
  const info = stageInfo(stageKey);
  if (info) return agentAdapter(info);
  if (stageKey === "global_system") return globalAdapter();
  if (stageKey === "consistency_comparator") return comparatorAdapter();
  if (stageKey === "adjudicator_review") return adjudicatorAdapter();
  if (stageKey === "final_adjudication") return finalAdapter();
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
