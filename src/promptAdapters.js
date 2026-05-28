import crypto from "node:crypto";

export const PROMPT_ADAPTER_VERSION = "runtime-adapter.v7.20260527-compact-adjudication";

const REVIEW_STAGES = [
  { key: "selection_innovation", title: "选题创新预审", prefix: "A1", dimension: "选题创新性" },
  { key: "clinical_methods", title: "临床方法预审", prefix: "A2", dimension: "研究设计与临床逻辑" },
  { key: "statistical_results", title: "统计结果预审", prefix: "A3", dimension: "统计分析与证据支撑" },
  { key: "numerical_audit", title: "数值审计预审", prefix: "A4", dimension: "数据一致性" },
  { key: "figure_table_visual_audit", title: "图表与视觉材料审计", prefix: "A5", dimension: "图表质量与呈现完整性" },
  { key: "submission_safety_expression", title: "投稿安全与表达预审", prefix: "A6", dimension: "投稿合规与成稿完整性" }
];

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
  return `【程序适配层：裁决者裁定紧凑输出契约】
本段只规定程序可解析外壳，不改变前文自然语言提示词要求的终审裁决逻辑和审稿强度。裁决者不是第 7 个审稿 Agent，不新增六 Agent 均未提出的独立问题；只对六 Agent 合并问题清单进行复核、去重、合并、升级/降级、排除和优先级排序。裁决者只运行一次。

重要：裁决者只输出“紧凑裁定 JSON”，不要输出客户报告正文，不要输出 report_text、report_sections、Markdown 或 JSON 之外文字。完整问题正文由后端从六 Agent 合并问题清单中物化生成；你只需要说明每个候选问题被保留、合并或排除，以及最终问题池的 ID、级别、维度和必要改写。

顶层结构：
{
  "adjudication_summary": "200字以内裁决摘要",
  "overall_judgment": {
    "submission_recommendation": "暂不建议投稿，需先处理阻断级问题|暂不建议直接投稿，完成关键修订后可进入投稿阶段|基本具备投稿基础，建议先完成定向优化|整体较成熟，可进入投稿准备阶段",
    "risk_level": "低风险|中等风险|中高风险|高风险|极高风险",
    "revision_workload": "小修|中修|大修",
    "revision_workload_reason": "一句话说明"
  },
  "final_issue_decisions": [],
  "priority_issue_ids": [],
  "source_issue_coverage": [],
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

final_issue_decisions 是最终问题池的紧凑决策表。每条记录必须包含：
{
  "id": "JR-001",
  "action": "keep|merge|upgrade|downgrade",
  "severity": "P0|P1|P2|P3",
  "category": "selection_innovation|clinical_methods|statistical_results|numerical_audit|figure_table_visual_audit|submission_safety_expression|cross_agent",
  "primary_dimension": "选题创新性|研究设计与临床逻辑|统计分析与证据支撑|数据一致性|图表质量与呈现完整性|投稿合规与成稿完整性",
  "issue": "最终问题短标题；可轻微改写，不得改变含义",
  "source_issue_ids": ["selection_innovation:A1-M01"],
  "reason": "为什么保留、合并、升级或降级",
  "severity_before": "P1",
  "severity_after": "P1"
}

不要在 final_issue_decisions 中复写长篇 issue_narrative、完整问题说明或完整修改建议；这些内容由后端从 source_issue_ids 指向的 Agent 合并问题中继承。只有当标题、级别、维度或建议需要轻微改写时，才填写 issue、severity、category、primary_dimension、recommendation_override、location_override。

source_issue_coverage 是强制覆盖表，必须逐条覆盖输入的 6 个 Agent 合并问题清单中的每一个问题。每条覆盖记录必须包含：
{
  "source_stage": "selection_innovation|clinical_methods|statistical_results|numerical_audit|figure_table_visual_audit|submission_safety_expression",
  "source_issue_id": "原合并问题编号，例如 A2-M01；若无编号，使用原问题标题前 30 字",
  "source_issue_title": "原合并问题标题",
  "source_severity": "P0|P1|P2|P3",
  "action": "kept_as|merged_into|excluded",
  "target_issue_id": "若 kept_as 或 merged_into，填写 final_issue_list 中对应 id；若 excluded，留空",
  "reason": "保留、合并或排除的裁决理由"
}

不得无记录丢弃任何来源问题。只有“同一定位、同一投稿风险、同一低成本修改动作”的重复问题才允许 merged_into；同一根因但定位、风险或修改动作不同的问题必须保留为独立客户可执行问题。P0/P1 若 excluded，reason 必须说明原文复核后证据不足、与其他问题完全重复且已完整覆盖、或原风险等级不成立；不得只写“重复/不重要/已合并”。如果最终问题数低于输入中的参考基线或上一版裁决结果，必须在 source_issue_coverage 与 adjudication_decisions 中逐条说明所有减少项的去向。

候选项基线保真阈值：当 6 个 Agent 合并问题清单的候选项总数不少于 10 项时，final_issue_decisions 原则上不得低于候选项总数的 65%。例如 36 项候选至少应保留 24 项；26 项属于可接受的轻度压缩，16/17 项属于疑似过度压缩。若当前输出低于 65%，不要只补充解释，而应优先恢复被过度合并的问题、拆回不同定位/不同风险/不同修改动作的子问题，或逐项重裁后再输出。

priority_issue_ids 必须是 final_issue_decisions 中 id 的 5-10 条优先子集。severity_counts 与 issue_distribution 必须以 final_issue_decisions 为口径。P0/P1 被排除时，excluded_issues.exclusion_reason 必须写清楚原文复核理由。裁决者不得输出最终数值评分；评分由终稿输出阶段完成。`;
}

function finalAdapter() {
  return `【程序适配层：终稿输出报告层 JSON 契约】
本段只规定程序可解析外壳和客户版屏蔽规则，不改变前文自然语言提示词要求的客户版报告母稿风格、章节逻辑、语言强度和信息密度。终稿输出不是重新审稿；若输入有 adjudicator_review JSON，必须以裁决者结果为唯一事实来源。若暂未提供裁决者结果，只能基于六 Agent 合并清单做最小必要报告化表达，不得新增六 Agent 均未提出的独立问题。

重要：终稿输出只负责报告层判断、客户版摘要、模型模糊评分和优先问题 ID 排序，不需要重复输出完整问题正文。完整 report_content.final_issue_list 和 final_review_text 将由后端根据裁决者问题池物化生成。必须只返回严格 JSON，禁止 Markdown，禁止 JSON 之外文字。

final_review_text 可以输出报告总览正文，但不得写“具体见 report_content.priority_actions”“完整问题清单见 final_issue_list”“优先问题见结构化字段”等引用式句子。若你不确定完整问题正文如何展开，可将 final_review_text 写成总体判断和修订路径；后端会自动补全优先问题和完整问题清单。

如果输入提供 adjudicator_review.final_issue_list 或 final_issue_decisions，则 report_content.priority_issue_ids 必须引用这些最终问题 id；不得在终稿阶段二次合并、删减、拆分、重排或降低严重程度。终稿不得输出少于裁决者的问题池；如只输出 priority_issue_ids，后端会自动补全完整问题池。

8 个基础字段必须存在：
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
      "overall_score_10": 0,
      "overall_score_text": "X.X / 10",
      "overall_score_label": "暂不建议投稿|大修后可投稿|勉强达到可投稿水平|投稿准备较成熟",
      "overall_score_rationale": "客户可读综合评分理由，不写机械扣分规则",
      "dimension_scores": [
        { "key": "selection_innovation", "title": "选题创新性", "score": 0, "score_10": 0, "score_text": "X.X / 10", "rationale": "一句话评分理由" },
        { "key": "clinical_methods", "title": "研究设计与临床逻辑", "score": 0, "score_10": 0, "score_text": "X.X / 10", "rationale": "一句话评分理由" },
        { "key": "statistical_results", "title": "统计分析与证据支撑", "score": 0, "score_10": 0, "score_text": "X.X / 10", "rationale": "一句话评分理由" },
        { "key": "numerical_audit", "title": "数据一致性", "score": 0, "score_10": 0, "score_text": "X.X / 10", "rationale": "一句话评分理由" },
        { "key": "figure_table_visual_audit", "title": "图表质量与呈现完整性", "score": 0, "score_10": 0, "score_text": "X.X / 10", "rationale": "一句话评分理由" },
        { "key": "submission_safety_expression", "title": "投稿合规与成稿完整性", "score": 0, "score_10": 0, "score_text": "X.X / 10", "rationale": "一句话评分理由" }
      ]
    },
    "priority_issue_ids": [],
    "priority_actions": [],
    "final_issue_list": [],
    "report_sections": {},
    "artifact_completion_summary": { "overview": "", "key_risks": [], "recommended_actions": [] }
  }
}

客户版屏蔽规则：summary、overall_conclusion、must_fix、suggested_fix、text_and_figure_comments、compliance_risk、pre_submission_checklist、final_review_text、report_content 中不得出现扣分公式、评分规则、双跑一致性、重合度、run_1/run_2、source_runs、source_issue_ids、Python、artifact_manifest、图片 ID、extracted_path、prompt、token、latency、模型过程等内部调试信息。真实风险必须转成客户可理解表述。

评分映射规则：若裁决者输入给出 X.X / 10 的总体评分或六维评分，必须忠实继承其 10 分制含义，并在 score_summary 中同时输出：
1. overall_score_10 / dimension_scores[].score_10：原始 10 分制数字。
2. overall_score_text / dimension_scores[].score_text：原始 X.X / 10 文本。
3. overall_score / dimension_scores[].score：供程序绘图使用的百分制整数，等于 10 分制数字乘以 10 后四舍五入。
如果上游已经给出百分制，可直接继承百分制，但不得改变裁决者的实质评分判断。overall_score_rationale 和 dimension_scores[].rationale 必须是客户可读综合判断，不写机械扣分公式，也不写“按 P0/P1/P2/P3 扣多少分”。

priority_issue_ids 输出 5-10 条优先处理问题 id；若最终问题不足 5 条则按实际数量。priority_actions 可只输出简短客户提示或留空；final_issue_list 可留空或只输出 id 引用，后端将从裁决者问题池补全完整问题正文。若你输出 priority_actions 或 final_issue_list，不得包含 source_runs、source_issue_ids、runner_metadata、artifact_manifest、report_text 等内部来源字段。

【终稿全链路保真要求】
1. 终稿输出不是二次裁决器，不得减少裁决者最终问题池。
2. 客户友好不等于压缩，不得将总体结论改写为“影响可信度”“建议完善”“需进一步说明”等泛泛表达。
3. 优先问题只能通过 priority_issue_ids 排序；完整问题正文由后端继承 Agent 原始长意见。`;
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
