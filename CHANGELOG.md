# 更新日志

## v5.0 - 2026-06-18

### 版本定位

v5.0 将系统正式固化为“网页端 V4 TXT-only 预审流程 + 后端严格映射报告”的版本。核心目标是减少长程序契约对网页端模型思考质量的干扰，取消 JSON sidecar 和终稿 Agent，确保最终 PDF/Word 只来自两份最终中间文档：`问题清单.txt` 与 `裁决者参数.txt`。

### V4 TXT-only 网页端预审流程

- 新任务默认采用 5 个 Agent 单跑，不再执行双跑、通用一致性比较器、裁决者长报告和终稿 Agent。
- 5 个 Agent 各自独立网页对话运行：上传原 Word + 对应后台已发布原始提示词，输出保存为 `agent1.txt` 至 `agent5.txt`。
- 清洁员 Agent 单独新对话，只读取 5 个 Agent TXT，不读取原 Word，不接收全文材料，输出 `问题清单.txt`。
- 裁决者参数 Agent 单独新对话，读取原 Word + `问题清单.txt`，输出 `裁决者参数.txt`。
- 后台导入整包只要求：
  - `agent1.txt` 至 `agent5.txt`
  - `问题清单.txt`
  - `裁决者参数.txt`
- `runner_metadata JSON` 与 `artifact_manifest JSON` 仅作为可选调试信息保留，不作为 PDF 生成来源。

### 后端严格映射报告

- 新增 V4 TXT-only 导入解析器，识别 `agent1.txt:` 至 `agent5.txt:`、`问题清单.txt:`、`裁决者参数.txt:`。
- PDF/Word 只从 `问题清单.txt` 和 `裁决者参数.txt` 提取内容；不再依赖 `finalJson`、`report_content`、`pdf_text_set`、`issue_list JSON` 或 `conclusion_parameters JSON`。
- 缺少关键字段时直接拒绝生成报告，并返回缺失字段说明，避免后台自动补写或自由发挥。
- 问题详情只来自 `问题清单.txt`：问题编号、问题名称、介绍/描述、精确定位、投稿风险、处理建议、P 分级和归属模块。
- 评分、摘要、总体判断、风险等级、优先处理、修改方向、修后投稿定位、预期 SCI 发表和投稿前检查清单只来自 `裁决者参数.txt`。
- 优先问题只由裁决者给出编号，后台按编号回到问题清单抓取详情，避免裁决者或模板二次改写问题正文。

### 网页自动化与 Skills

- `web-review-runner` 已同步为 V4 TXT-only 半自动网页流程。
- `sci-pre-review-runner` 已同步为 V4 TXT-only 人工代跑流程。
- 网页 runner 默认发送后台已发布提示词原文，不追加运行时适配层、JSON schema、全文解析 JSON 或图片序列 JSON。
- 网页 runner 默认不再要求 `agent_report JSON`、`issue_list JSON` 或 `conclusion_parameters JSON`。
- 清洁员阶段明确不上传原 Word；裁决者阶段才重新上传原 Word 与问题清单。
- 输出包模板、用户手册、README 和后台人工代跑文案均更新为 V4 TXT-only 格式。

### PDF 与前端

- 客户版 PDF 改为以 `问题清单.txt + 裁决者参数.txt` 为唯一内容来源。
- PDF 继续保留当前蓝白专业报告风格，但去除由程序生成的兜底句和中间调试字段。
- 后台页面和用户端页面完成一轮视觉优化，界面更偏内部质控工具风格。
- 后台人工代跑区域更新为 V4 输出包导入说明。

### 常驻运行

- 新增 macOS 用户级 `launchd` 常驻服务脚本：
  - `npm run service:install`
  - `npm run service:status`
  - `npm run service:logs`
  - `npm run service:uninstall`
- 常驻服务默认使用后台-only 模式，监听 `0.0.0.0:3000`，支持本机和局域网后台访问。
- 已验证进程异常退出后可由 `launchd` 自动拉起。

### 兼容与排除

- 旧 V2/V3 JSON 整包解析仍保留兼容，但新任务默认不再使用。
- 本版本不提交 `.data/`、`storage/`、Word 原稿、PDF 样例、日志、浏览器配置、网页账号信息或 API Key。

### 验证

- `npm run check`
- `node --check public/admin.js`
- `node --check public/app.js`
- `node --check scripts/web_review_browser_runner.mjs`
- `node --check skills/sci-pre-review-runner/scripts/build_review_context.mjs`
- 已验证常驻后台 `http://localhost:3000/admin.html` 返回 200。

## v4.0 - 2026-06-10

### 版本定位

v4.0 是一次主流程级改版。系统从 V2/V3.0 前期的“6 Agent 双跑 + 一致性比较器 + 裁决者终审”切换为新的 V3/V4 主链路：`5 个单跑审稿 Agent -> 清洁员 Agent -> 裁决者参数 Agent -> 后端 Word/PDF 渲染`。本版本的重点是降低链路复杂度、取消终稿 Agent 二次压缩、把问题正文从清洁员问题池中稳定物化，并支持网页端 5.5 thinking 半自动代跑。

### 审稿流程

- 移除新任务中的全局系统提示词、通用一致性比较器和每个 Agent 双跑机制。
- 新增并启用 5 个单跑审稿 Agent：
  - Agent 1：选题创新及合理性。
  - Agent 2：统计学细节。
  - Agent 3：全文一致性与数值审计结果。
  - Agent 4：图表质量与呈现完整性。
  - Agent 5：杂项、合规与表达。
- 新增清洁员 Agent：只读取 5 个 Agent 输出，不读取原始 Word 或文稿全文，负责生成 `问题清单.txt` 和后台解析用 `issue_list JSON`。
- 新增裁决者参数 Agent：读取 Word/文稿材料与 `问题清单.txt`，只输出评分、风险等级、修订工作量、投稿建议、优先问题 ID、摘要、总体结论、页面导语和六维诊断等 `结论参数.txt` / `conclusion_parameters JSON`。
- 取消新流程中的终稿 Agent：自然语言客户化前置到 5 个 Agent、清洁员和裁决者参数环节。
- 后端从 `issue_list JSON + conclusion_parameters JSON` 直接物化 Word/PDF，避免终稿模型把完整问题清单压缩成摘要。

### 提示词与适配层

- 后台提示词页只维护 V4 当前流程的自然语言提示词原文：5 个审稿 Agent、清洁员、裁决者参数。
- V1/V2 历史提示词继续保留在数据库中，但默认不在新流程提示词维护页展示。
- 程序运行时自动追加局部适配层，不覆盖后台已发布的自然语言提示词原文。
- 适配层版本升级为 `runtime-adapter.v8.20260608-v3-single-run`。
- 清洁员适配层明确：自然语言提示词中的“纯文本、不使用 JSON”只约束 `问题清单.txt` 正文；后台仍需要附加 `issue_list JSON` sidecar。
- 裁决者参数适配层统一六维评分口径，兼容提示词中出现的 `裁决报告.txt` 命名，并归一保存为 `结论参数.txt`。
- 裁决者参数适配层新增 `summary`、`overall_conclusion`、`pdf_text_set` 和 `artifact_completion_summary`，用于 PDF/Word 的封面、总览、评分解读、优势短板、优先问题、完整问题清单、投稿材料规范摘要和检查清单导语。

### Word 与 PDF 报告

- PDF 评分与雷达图采用六维：选题价值、研究设计、统计分析、数据可信、图表呈现、写作表达。
- 综合评分和六维评分改为读取裁决者参数 Agent 的模型模糊评分，后端不再做机械扣分。
- 完整问题正文优先从清洁员生成的 `issue_list JSON` 物化，确保每条问题保留标题、定位、为什么是问题、投稿风险和低成本处理建议。
- PDF 客户版继续隐藏 runner、prompt、source、artifact、token、latency、图片提取路径等内部调试字段。
- PDF 页面文本支持从 `conclusion_parameters JSON.pdf_text_set` 读取，便于后续持续优化报告风格，而不影响问题池数据口径。
- Word/PDF 保持由后端模板生成，新流程不再运行终稿 Agent。

### 人工代跑与后台导入

- 人工代跑整包格式升级为 V4/V3 package：
  - `runner_metadata JSON`
  - `artifact_manifest JSON`
  - `agent_reports`
  - `issue_list_txt`
  - `issue_list JSON`
  - `conclusion_parameters_txt`
  - `conclusion_parameters JSON`
- 后台导入器继续兼容旧版整包，但新任务默认使用 V4 package。
- 阶段调试输出按新链路分层：5 Agent 原始报告、清洁员问题清单、裁决者参数、报告物化摘要。
- 后台任务管理支持历史任务删除，仅允许删除 `succeeded`、`failed`、`cancelled` 状态任务，并清理项目 `storage/` 下的关联上传文件、解析文本、报告、prompt snapshot 和检测产物。

### 网页自动化代跑

- 新增网页端半自动代跑 runner：`npm run web-review:browser`。
- 新增 `playwright-core` 依赖，用于控制专用浏览器会话。
- 网页自动化流程升级为 V4/V3 单跑链路：5 Agent 单跑、清洁员、裁决者参数；不再执行双跑、一致性比较器和终稿 Agent。
- 新增专用 Chrome/CDP 模式：
  - `prepare-cdp`：打开独立 Chrome 配置目录并暴露本地 CDP 端点。
  - `preflight --cdp`：检查登录状态、模型可用性、输入框、剪贴板、下载目录和可选 live smoke。
  - `run --cdp`：执行完整网页端代跑。
  - `resume --run-dir ... --cdp`：从中断阶段继续。
  - `package --run-dir ...`：从本地 raw/json 输出重新组装后台可粘贴整包。
  - `migrate-legacy-profile`：修复旧版 `%20` 路径配置目录。
- 网页 runner 使用独立浏览器配置目录 `storage/browser-profiles/chatgpt-web-runner`，不依赖用户日常 Chrome 标签页或 Codex Chrome 扩展。
- 首次发送或上传医学文稿前需要任务级确认，确认后同一任务、同一文件、同一目标模型可连续执行，不再每阶段重复确认。
- 前 5 个审稿 Agent 可上传原 Word；清洁员不上传 Word，不接收原文稿；裁决者参数 Agent 读取原 Word/文稿材料与 `问题清单.txt`。
- 支持优先从网页端 recent/library 文件选择器匹配原始文件名，失败后再走本地上传或人工上传 fallback。
- 长提示词通过剪贴板粘贴，网页端可作为 pasted-text 附件处理；输出优先使用网页复制按钮提取，必要时回退到下载按钮或页面 DOM。
- 每个阶段使用独立对话，避免上下文污染。
- 支持同一对话内 JSON 格式修复，不要求模型重新审稿。
- `runner_metadata` 记录对话 URL、附件来源、格式修复次数、暂停事件、重试记录、剪贴板哈希和最终 package 路径，便于复盘网页端执行质量。

### Skill 同步

- `sci-pre-review-runner` 已同步为 V4/V3 单跑人工代跑流程。
- `web-review-runner` 已同步为网页端 5.5 thinking 半自动代跑流程。
- `skills/sci-pre-review-runner/references/prompts.json` 导出当前有效提示词快照，包含原文 hash、适配层版本和最终有效 hash。
- 本地安装目录下的 `sci-pre-review-runner` 与 `web-review-runner` 已按项目版本同步。

### 稳定性与维护

- 修复开发服务在当前环境中启动后可能立即退出、导致后台无法访问的问题：服务启动后保留 HTTP server 引用，并增加 listen error 日志。
- 保留旧任务和旧报告下载兼容，不强制迁移历史任务数据。
- 项目内不写入 API Key、网页账号信息、医学稿件内容或浏览器登录凭据到更新日志。

### 验证

- 已通过 Node 语法检查：
  - `npm run check`
  - `node --check public/admin.js`
  - `node --check public/app.js`
  - `node --check skills/sci-pre-review-runner/scripts/build_review_context.mjs`
  - `node --check skills/sci-pre-review-runner/scripts/export_prompts_from_project.mjs`
- 已验证 V4 上下文组装边界：
  - 清洁员只接收任务基础信息和 5 Agent 报告。
  - 裁决者参数接收文稿材料、`问题清单.txt` 和 `issue_list JSON` 锚点。
  - 终稿只接收 `问题清单.txt` 与 `结论参数.txt`。
