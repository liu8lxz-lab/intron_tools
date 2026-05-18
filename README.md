# 投稿前预审质控系统

临床 SCI 稿件投稿前预审质控 Web 系统。包含用户端上传任务、管理后台配置 API 与提示词、任务管理、阶段输出下载、DOCX 报告生成。

## 运行

```bash
npm install
npm run dev
```

默认地址：

- 用户端：http://localhost:3000/
- 管理后台：http://localhost:3000/admin.html

默认管理员：

- 用户名：`admin`
- 密码：`Admin@123`

## 局域网后台模式

同事只需要使用管理后台时，可以启用后台-only 模式。该模式只开放 `/admin.html` 和 `/api/v1/admin/*`，不会开放用户端上传页和普通用户 API。

```bash
HOST=0.0.0.0 \
APP_EXPOSURE=admin-only \
ALLOWED_HOSTS=localhost,127.0.0.1,192.168.x.x,intron-tools.local \
npm run dev
```

使用步骤：

- 将 `192.168.x.x` 替换为运行本服务这台电脑的局域网 IP。
- 固定域名通过内网 DNS 或同事电脑 hosts 指向该局域网 IP，例如 `intron-tools.local 192.168.x.x`。
- 同事访问 `http://192.168.x.x:3000/admin.html` 或 `http://intron-tools.local:3000/admin.html`。
- IP 和固定域名属于不同 Host，浏览器登录 Cookie 不共享；换地址访问时需要重新登录。
- 如果 macOS 防火墙拦截，需要允许 Node 或当前端口的局域网传入连接。
- 不设置 `APP_EXPOSURE=admin-only` 时仍为完整本机开发模式，用户端和后台都会开放。

## 说明

- V1 仅支持单个 `.doc` / `.docx` 文件上传，前端明确提示暂不支持 PDF。
- `.docx` 使用 `mammoth` 解析正文；`.doc` 当前保留上传校验入口，但无法解析时会把任务标记失败并返回错误原因，建议转换为 `.docx`。
- 未配置并启用 API 时，网页系统可以正常启动和登录后台；系统没有内置默认模型，实际自动审稿模型来自后台当前生效 API 配置中的“模型名”字段。
- 当前已升级到 V2.1 审稿流程：上传后先运行 Python 文件状态检测，统计图片、表格、drawing、chart、caption 和潜在图像质量风险；随后执行 6 个 Agent 双跑、Agent 内一致性比较和合并问题清单，终稿输出阶段读取 6 份合并清单生成报告 JSON。
- 当前已支持 V2.1 人工代跑模式：后台可直接上传 Word 文稿并生成可复制给 Codex 的人工代跑指令；`skills/sci-pre-review-runner` 内置 V2.1 skill 源文件与上下文构建脚本。输出 `artifact_manifest`、`agent_runs`、`agent_consistency_reports`、`agent_merged_issue_lists`、`adjudicator_review JSON`（裁决者裁定）和 `final_adjudication JSON`（终稿输出）后，可在后台一次性粘贴整包并生成 Word/PDF 报告。旧版整包和旧版分阶段粘贴接口仍保留兼容。
- 后台同一时间只允许一个 API 配置生效。
- API Key 由后端使用本机 `.data/master.key` 进行 AES-256-GCM 加密保存。
- API 配置支持可选“代理地址”，用于后端访问模型接口。常见本机代理填写 `http://127.0.0.1:7890` 这类 HTTP 代理地址；当前不支持 `socks5://`。
- API 配置支持 token 限制参数名选择。OpenAI `gpt-5*` / `o*` 模型在“自动”模式下会使用 `max_completion_tokens`，其他兼容接口默认使用 `max_tokens`。
- API 配置支持 temperature 参数发送策略。OpenAI `gpt-5*` / `o*` 模型在“自动”模式下不发送 `temperature`，避免新模型只接受默认值时报错。
- API 配置支持 `reasoning_effort`。GPT-5.5 可选 `none` / `low` / `medium` / `high` / `xhigh`，默认使用 `high`。
- GPT-5.5 的 `max_completion_tokens` 会同时消耗隐藏 reasoning tokens；如果模型返回空可见输出，系统会将任务标记失败并提示提高“最大输出 tokens”。`high` 建议至少 16000，`xhigh` 建议 32000 或更高。
- 提示词包含 1 个全局系统提示词、6 个独立 Agent 阶段提示词、1 个通用一致性比较器提示词、1 个裁决者裁定提示词和 1 个终稿输出提示词。全局系统提示词不会形成额外模型调用，而是与每个阶段提示词合并为该次调用的 system prompt。人工代跑已按“裁决者裁定 → 终稿输出”拆分；现有自动报告仍由 `final_adjudication` 作为终稿输出入口生成。
- 6 个 Agent 阶段按固定提示词串行执行，每个 Agent 独立运行两次，不共享 conversation/thread，也不会互相传递输出；同一 Agent 双跑结束后调用通用一致性比较器生成重合度、差异项和合并问题清单；终稿输出阶段才接收 6 份合并问题清单和一致性摘要。
- 每个任务开始时会锁定一份 `prompt_snapshot`，包含全局提示词、6 个 Agent 提示词、通用一致性比较器提示词、裁决者裁定提示词和终稿输出提示词的版本、内容与 hash；同一任务的自动审稿、人工代跑材料、终稿输出和阶段输出导出都使用该快照。管理员后续修改提示词只影响新任务；重试任务会重新锁定最新提示词。
