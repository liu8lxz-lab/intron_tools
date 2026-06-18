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

## 后台常驻运行

本机长期使用时，建议安装为 macOS 用户级 `launchd` 服务。服务会开机自启，并在 Node 进程异常退出后自动拉起。

```bash
npm run service:install
```

常用命令：

```bash
npm run service:status
npm run service:logs
npm run service:uninstall
```

常驻服务默认使用后台-only 模式：

- 本机后台：http://localhost:3000/admin.html
- 局域网后台：http://本机局域网IP:3000/admin.html

日志文件位于 `storage/logs/intron-tools.out.log` 和 `storage/logs/intron-tools.err.log`。

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
- 当前 V4 主流程为：上传后先运行 Python 文件状态检测；随后网页端执行 5 个审稿 Agent 单跑并分别保存 `agent1.txt` 至 `agent5.txt`；清洁员 Agent 只基于 5 个 Agent TXT 生成 `问题清单.txt`；裁决者参数 Agent 读取原 Word 和 `问题清单.txt` 生成 `裁决者参数.txt`；后端严格根据这两份最终 TXT 映射 Word/PDF 报告。
- 当前已支持 V4 人工代跑模式：后台可直接上传 Word 文稿并生成可复制给 Codex 的人工代跑指令；`skills/sci-pre-review-runner` 内置 V4 skill 源文件与上下文构建脚本。最终粘贴 `agent1.txt` 至 `agent5.txt`、`问题清单.txt`、`裁决者参数.txt` 后，可在后台生成 Word/PDF 报告。旧版 V2/V3 JSON 整包和旧版分阶段粘贴接口仍保留兼容。
- 当前也支持网页端 5.5 thinking 半自动代跑：后台会生成 `web-review-runner` 指令，Codex Browser 在用户已登录并确认上传的网页端模型中运行同一套 V4 TXT-only 流程，最终仍粘贴完整整包回后台生成报告。
- 后台提示词页面只保存你维护的自然语言提示词原文；V4 网页端代跑不再追加 JSON schema 或运行时适配层。阶段输出 TXT 会保留各环节原始文本，便于排查每个 Agent 的真实意见质量。
- 后台同一时间只允许一个 API 配置生效。
- API Key 由后端使用本机 `.data/master.key` 进行 AES-256-GCM 加密保存。
- API 配置支持可选“代理地址”，用于后端访问模型接口。常见本机代理填写 `http://127.0.0.1:7890` 这类 HTTP 代理地址；当前不支持 `socks5://`。
- API 配置支持 token 限制参数名选择。OpenAI `gpt-5*` / `o*` 模型在“自动”模式下会使用 `max_completion_tokens`，其他兼容接口默认使用 `max_tokens`。
- API 配置支持 temperature 参数发送策略。OpenAI `gpt-5*` / `o*` 模型在“自动”模式下不发送 `temperature`，避免新模型只接受默认值时报错。
- API 配置支持 `reasoning_effort`。GPT-5.5 可选 `none` / `low` / `medium` / `high` / `xhigh`，默认使用 `high`。
- GPT-5.5 的 `max_completion_tokens` 会同时消耗隐藏 reasoning tokens；如果模型返回空可见输出，系统会将任务标记失败并提示提高“最大输出 tokens”。`high` 建议至少 16000，`xhigh` 建议 32000 或更高。
- 如果后台 API 配置未填写最大输出 tokens，系统会按调用点使用高强度默认值：5 个审稿 Agent 为 16000，清洁员为 20000，裁决者参数为 24000。管理员显式填写后以配置值为准。
- 后台默认维护 7 个 V4 调用点：5 个审稿 Agent、1 个清洁员 Agent、1 个裁决者参数 Agent。旧版全局系统提示词、通用一致性比较器、旧六 Agent、裁决者裁定和终稿输出提示词仍保留历史兼容，但不会出现在新任务默认调用链中。
- 5 个 Agent 阶段按固定提示词串行单跑，不共享 conversation/thread，也不会互相传递输出；清洁员不读取原文档，只清洗前 5 个 Agent 的输出；裁决者参数 Agent 才读取原 Word/全文材料和问题清单，负责评分、风险、优先级、摘要、总体结论和报告页面参数。
- 每个任务开始时会锁定一份 `prompt_snapshot`。V4 网页端代跑优先使用后台已发布提示词原文，避免长程序契约挤占网页端模型思考上下文；管理员后续修改提示词只影响新任务，重试任务会重新锁定最新提示词。
