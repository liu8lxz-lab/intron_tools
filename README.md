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

## 说明

- V1 仅支持单个 `.doc` / `.docx` 文件上传，前端明确提示暂不支持 PDF。
- `.docx` 使用 `mammoth` 解析正文；`.doc` 当前保留上传校验入口，但无法解析时会把任务标记失败并返回错误原因，建议转换为 `.docx`。
- 未配置并启用 API 时，网页系统可以正常启动和登录后台；系统没有内置默认模型，实际自动审稿模型来自后台当前生效 API 配置中的“模型名”字段。
- 当前已支持人工代跑模式：后台可直接上传 Word 文稿并生成可复制给 Codex 的人工代跑指令；`sci-pre-review-runner` 输出五阶段结果和终审 JSON 后，可在后台一次性粘贴整包并生成 Word 报告。旧版分阶段粘贴接口仍保留兼容。
- 后台同一时间只允许一个 API 配置生效。
- API Key 由后端使用本机 `.data/master.key` 进行 AES-256-GCM 加密保存。
- API 配置支持可选“代理地址”，用于后端访问模型接口。常见本机代理填写 `http://127.0.0.1:7890` 这类 HTTP 代理地址；当前不支持 `socks5://`。
- API 配置支持 token 限制参数名选择。OpenAI `gpt-5*` / `o*` 模型在“自动”模式下会使用 `max_completion_tokens`，其他兼容接口默认使用 `max_tokens`。
- API 配置支持 temperature 参数发送策略。OpenAI `gpt-5*` / `o*` 模型在“自动”模式下不发送 `temperature`，避免新模型只接受默认值时报错。
- API 配置支持 `reasoning_effort`。GPT-5.5 可选 `none` / `low` / `medium` / `high` / `xhigh`，默认使用 `high`。
- GPT-5.5 的 `max_completion_tokens` 会同时消耗隐藏 reasoning tokens；如果模型返回空可见输出，系统会将任务标记失败并提示提高“最大输出 tokens”。`high` 建议至少 16000，`xhigh` 建议 32000 或更高。
- 提示词包含 1 个全局系统提示词、5 个独立预审阶段提示词、1 个终审提示词。全局系统提示词不会形成额外模型调用，而是与每个阶段提示词合并为该次调用的 system prompt。
- 5 个预审阶段按固定提示词串行执行，但不会共享 conversation/thread，也不会互相传递输出；终审阶段才接收 5 组输出。
