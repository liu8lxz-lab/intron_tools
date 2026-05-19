const loginView = document.querySelector("#loginView");
const adminView = document.querySelector("#adminView");
const logoutButton = document.querySelector("#logoutButton");
const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");

const apiForm = document.querySelector("#apiForm");
const apiMessage = document.querySelector("#apiMessage");
const apiTable = document.querySelector("#apiTable");
const apiResetButton = document.querySelector("#apiResetButton");

const promptStage = document.querySelector("#promptStage");
const promptContent = document.querySelector("#promptContent");
const promptVersions = document.querySelector("#promptVersions");
const promptMessage = document.querySelector("#promptMessage");

const manualCreateForm = document.querySelector("#manualCreateForm");
const manualCreateSubmit = document.querySelector("#manualCreateSubmit");
const taskTable = document.querySelector("#taskTable");
const taskMessage = document.querySelector("#taskMessage");
const manualPanel = document.querySelector("#manualPanel");
const manualTaskMeta = document.querySelector("#manualTaskMeta");
const manualSkillInstruction = document.querySelector("#manualSkillInstruction");
const copyManualSkillInstruction = document.querySelector("#copyManualSkillInstruction");
const manualReportDownload = document.querySelector("#manualReportDownload");
const manualPdfReportDownload = document.querySelector("#manualPdfReportDownload");
const manualSkillOutput = document.querySelector("#manualSkillOutput");
const manualModel = document.querySelector("#manualModel");

const reviewStages = [
  { key: "selection_innovation", title: "选题创新预审" },
  { key: "clinical_methods", title: "临床方法预审" },
  { key: "statistical_results", title: "统计结果预审" },
  { key: "numerical_audit", title: "数值审计预审" },
  { key: "figure_table_visual_audit", title: "图表与视觉材料审计" },
  { key: "submission_safety_expression", title: "投稿安全与表达预审" }
];

let activeManualTaskId = "";

let prompts = [];
let promptVersionCache = [];

const statusClass = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "failed",
  manual_stage_pending: "manual_stage_pending",
  manual_final_pending: "manual_final_pending"
};

function setMessage(node, text, type = "") {
  node.textContent = text;
  node.className = `message ${type}`.trim();
}

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    ...options,
    headers
  });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(data?.error || data || "请求失败");
  }
  return data;
}

function showAdmin() {
  loginView.classList.add("hidden");
  adminView.classList.remove("hidden");
  logoutButton.classList.remove("hidden");
}

function showLogin() {
  loginView.classList.remove("hidden");
  adminView.classList.add("hidden");
  logoutButton.classList.add("hidden");
}

async function checkSession() {
  try {
    await apiFetch("/api/v1/admin/me");
    showAdmin();
    await Promise.all([loadConfigs(), loadPrompts(), loadTasks()]);
  } catch {
    showLogin();
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(loginMessage, "");
  const formData = new FormData(loginForm);
  try {
    await apiFetch("/api/v1/admin/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData.entries()))
    });
    showAdmin();
    await Promise.all([loadConfigs(), loadPrompts(), loadTasks()]);
  } catch (error) {
    setMessage(loginMessage, error.message, "error");
  }
});

logoutButton.addEventListener("click", async () => {
  await apiFetch("/api/v1/admin/logout", { method: "POST" }).catch(() => null);
  showLogin();
});

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((item) => item.classList.add("hidden"));
    button.classList.add("active");
    document.querySelector(`#tab-${button.dataset.tab}`).classList.remove("hidden");
  });
});

function resetApiForm() {
  document.querySelector("#apiConfigId").value = "";
  document.querySelector("#apiName").value = "";
  document.querySelector("#apiBaseUrl").value = "";
  document.querySelector("#apiProxyUrl").value = "";
  document.querySelector("#apiKey").value = "";
  document.querySelector("#apiModel").value = "";
  document.querySelector("#apiTimeout").value = "120000";
  document.querySelector("#apiTemperature").value = "0.2";
  document.querySelector("#apiTemperatureParam").value = "auto";
  document.querySelector("#apiReasoningEffort").value = "high";
  document.querySelector("#apiMaxTokens").value = "";
  document.querySelector("#apiMaxTokensParam").value = "auto";
  document.querySelector("#apiEnabled").value = "false";
  setMessage(apiMessage, "");
}

function renderManualPanel(task) {
  activeManualTaskId = task.id;
  manualPanel.classList.remove("hidden");
  const parsedMeta = task.parsedCharCount ? ` · 已解析 ${task.parsedCharCount} 字符` : "";
  manualTaskMeta.textContent = `${task.originalFilename || ""} · ${task.id} · ${task.statusText || task.status}${parsedMeta}`;
  manualSkillInstruction.value = task.manualSkillInstruction || "";
  manualReportDownload.href = `/api/v1/admin/review-tasks/${task.id}/report`;
  manualReportDownload.classList.toggle("hidden", !task.reportAvailable);
  manualPdfReportDownload.href = `/api/v1/admin/review-tasks/${task.id}/report.pdf`;
  manualPdfReportDownload.classList.toggle("hidden", !task.pdfReportAvailable);
  manualSkillOutput.value = buildSkillPackageText(task);
  manualPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildSkillPackageText(task) {
  const stageOutputs = task.stageOutputs || [];
  const finalOutput = task.finalOutput?.output || "";
  if (!stageOutputs.length && !finalOutput) return "";

  const stageText = reviewStages
    .map((stage) => {
      const output = stageOutputs.find((item) => item.stage === stage.key)?.output || "";
      return `${stage.key}:\n${output}`;
    })
    .join("\n\n");

  return `${stageText}\n\nfinal_adjudication JSON:\n${finalOutput}`.trim();
}

async function openManualPanel(taskId) {
  try {
    let task = await apiFetch(`/api/v1/admin/review-tasks/${taskId}`);
    if (!task.manualMode && ["failed", "cancelled"].includes(task.status)) {
      task = await apiFetch(`/api/v1/admin/review-tasks/${taskId}/manual/start`, { method: "POST" });
    }
    renderManualPanel(task);
    setMessage(taskMessage, "已打开人工代跑工作台。", "ok");
    await loadTasks();
  } catch (error) {
    setMessage(taskMessage, error.message, "error");
  }
}

apiResetButton.addEventListener("click", resetApiForm);

async function loadConfigs() {
  const configs = await apiFetch("/api/v1/admin/api-configs");
  apiTable.innerHTML = configs
    .map((config) => {
      return `
        <tr>
          <td>${escapeHtml(config.name)}</td>
          <td>${escapeHtml(config.baseUrl)}</td>
          <td>${escapeHtml(config.proxyUrl || "未使用")}</td>
          <td>${escapeHtml(config.model)}</td>
          <td>${escapeHtml(config.apiKeyMasked || "")}</td>
          <td>timeout ${config.timeout}<br />temperature ${config.temperature}<br />temperature 参数 ${escapeHtml(config.temperatureParam || "auto")}<br />reasoning ${escapeHtml(config.reasoningEffort || "high")}<br />tokens ${config.maxTokens || "阶段默认"}<br />token 参数 ${escapeHtml(config.maxTokensParam || "auto")}</td>
          <td><span class="pill ${config.enabled ? "succeeded" : ""}">${config.enabled ? "生效" : "未生效"}</span></td>
          <td>
            <div class="actions">
              <button class="secondary compact" data-edit="${config.id}" type="button">编辑</button>
              <button class="compact" data-enable="${config.id}" type="button">启用</button>
              <button class="warning compact" data-test="${config.id}" type="button">测试</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  apiTable.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const config = configs.find((item) => item.id === button.dataset.edit);
      document.querySelector("#apiConfigId").value = config.id;
      document.querySelector("#apiName").value = config.name;
      document.querySelector("#apiBaseUrl").value = config.baseUrl;
      document.querySelector("#apiProxyUrl").value = config.proxyUrl || "";
      document.querySelector("#apiKey").value = "";
      document.querySelector("#apiModel").value = config.model;
      document.querySelector("#apiTimeout").value = config.timeout;
      document.querySelector("#apiTemperature").value = config.temperature;
      document.querySelector("#apiTemperatureParam").value = config.temperatureParam || "auto";
      document.querySelector("#apiReasoningEffort").value = config.reasoningEffort || "high";
      document.querySelector("#apiMaxTokens").value = config.maxTokens || "";
      document.querySelector("#apiMaxTokensParam").value = config.maxTokensParam || "auto";
      document.querySelector("#apiEnabled").value = String(config.enabled);
      setMessage(apiMessage, "已载入配置。编辑时 API Key 留空表示不修改。");
    });
  });

  apiTable.querySelectorAll("[data-enable]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await apiFetch(`/api/v1/admin/api-configs/${button.dataset.enable}/enable`, { method: "POST" });
        setMessage(apiMessage, "已切换生效配置。", "ok");
        await loadConfigs();
      } catch (error) {
        setMessage(apiMessage, error.message, "error");
      }
    });
  });

  apiTable.querySelectorAll("[data-test]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        setMessage(apiMessage, "正在测试连接...");
        const result = await apiFetch(`/api/v1/admin/api-configs/${button.dataset.test}/test`, { method: "POST" });
        setMessage(apiMessage, `连接测试成功，耗时 ${result.latencyMs}ms，返回：${result.output}`, "ok");
      } catch (error) {
        setMessage(apiMessage, error.message, "error");
      }
    });
  });
}

apiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(apiMessage, "");
  const id = document.querySelector("#apiConfigId").value;
  const payload = {
    name: document.querySelector("#apiName").value.trim(),
    baseUrl: document.querySelector("#apiBaseUrl").value.trim(),
    proxyUrl: document.querySelector("#apiProxyUrl").value.trim(),
    apiKey: document.querySelector("#apiKey").value,
    model: document.querySelector("#apiModel").value.trim(),
    timeout: Number(document.querySelector("#apiTimeout").value),
    temperature: Number(document.querySelector("#apiTemperature").value),
    temperatureParam: document.querySelector("#apiTemperatureParam").value,
    reasoningEffort: document.querySelector("#apiReasoningEffort").value,
    maxTokens: document.querySelector("#apiMaxTokens").value ? Number(document.querySelector("#apiMaxTokens").value) : 0,
    maxTokensParam: document.querySelector("#apiMaxTokensParam").value,
    enabled: document.querySelector("#apiEnabled").value === "true"
  };

  if (!id && !payload.apiKey) {
    setMessage(apiMessage, "新建配置必须填写 API Key。", "error");
    return;
  }

  try {
    await apiFetch(id ? `/api/v1/admin/api-configs/${id}` : "/api/v1/admin/api-configs", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    setMessage(apiMessage, "配置已保存。", "ok");
    resetApiForm();
    await loadConfigs();
  } catch (error) {
    setMessage(apiMessage, error.message, "error");
  }
});

async function loadPrompts() {
  prompts = await apiFetch("/api/v1/admin/prompts");
  promptStage.innerHTML = prompts
    .map((item) => `<option value="${item.stage}">${escapeHtml(item.title)} (${item.stage})</option>`)
    .join("");
  if (prompts[0]) {
    promptStage.value = prompts[0].stage;
    await loadPromptVersions();
  }
}

async function loadPromptVersions() {
  const stage = promptStage.value;
  promptVersionCache = await apiFetch(`/api/v1/admin/prompts/${stage}`);
  const current = promptVersionCache.find((item) => item.status === "published") || promptVersionCache[0];
  promptContent.value = current?.content || "";
  promptVersions.innerHTML = promptVersionCache
    .map((item) => {
      return `
        <tr>
          <td>v${item.version}</td>
          <td><span class="pill ${item.status === "published" ? "succeeded" : ""}">${statusLabel(item.status)}</span></td>
          <td>${escapeHtml(item.publishedAt || item.createdAt || "")}</td>
          <td>
            <div class="actions">
              <button class="secondary compact" data-load-prompt="${item.id}" type="button">查看</button>
              <button class="compact" data-publish-prompt="${item.id}" type="button">发布</button>
              <button class="warning compact" data-rollback-prompt="${item.id}" type="button">回滚</button>
              ${item.status === "published" ? "" : `<button class="danger compact" data-delete-prompt="${item.id}" type="button">删除</button>`}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  promptVersions.querySelectorAll("[data-load-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = promptVersionCache.find((version) => version.id === button.dataset.loadPrompt);
      promptContent.value = item?.content || "";
      setMessage(promptMessage, `已载入 v${item.version}。`);
    });
  });

  promptVersions.querySelectorAll("[data-publish-prompt]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await apiFetch(`/api/v1/admin/prompts/${promptStage.value}/${button.dataset.publishPrompt}/publish`, { method: "POST" });
        setMessage(promptMessage, "已发布版本。", "ok");
        await loadPromptVersions();
      } catch (error) {
        setMessage(promptMessage, error.message, "error");
      }
    });
  });

  promptVersions.querySelectorAll("[data-rollback-prompt]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await apiFetch(`/api/v1/admin/prompts/${promptStage.value}/${button.dataset.rollbackPrompt}/rollback`, { method: "POST" });
        setMessage(promptMessage, "已回滚并发布为新版本。", "ok");
        await loadPromptVersions();
      } catch (error) {
        setMessage(promptMessage, error.message, "error");
      }
    });
  });

  promptVersions.querySelectorAll("[data-delete-prompt]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = promptVersionCache.find((version) => version.id === button.dataset.deletePrompt);
      const confirmed = window.confirm(`确认删除 v${item?.version || ""}？此操作不会影响当前已发布版本。`);
      if (!confirmed) return;
      try {
        await apiFetch(`/api/v1/admin/prompts/${promptStage.value}/${button.dataset.deletePrompt}`, { method: "DELETE" });
        setMessage(promptMessage, "版本已删除。", "ok");
        await loadPromptVersions();
      } catch (error) {
        setMessage(promptMessage, error.message, "error");
      }
    });
  });
}

promptStage.addEventListener("change", loadPromptVersions);
document.querySelector("#refreshPromptsButton").addEventListener("click", loadPrompts);
document.querySelector("#submitPromptButton").addEventListener("click", async () => {
  try {
    const content = promptContent.value.trim();
    if (!content) throw new Error("提示词内容不能为空");
    const draft = await apiFetch(`/api/v1/admin/prompts/${promptStage.value}/drafts`, {
      method: "POST",
      body: JSON.stringify({ content })
    });
    setMessage(promptMessage, "草稿已创建。", "ok");
    await loadPromptVersions();
    promptContent.value = draft.content || content;
  } catch (error) {
    setMessage(promptMessage, error.message, "error");
  }
});

manualCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(taskMessage, "");

  const file = document.querySelector("#manualCreateFile").files[0];
  if (!file) {
    setMessage(taskMessage, "请选择 Word 文稿。", "error");
    return;
  }
  if (!/\.(doc|docx)$/i.test(file.name)) {
    setMessage(taskMessage, "当前仅支持 doc / docx，暂不支持 PDF。", "error");
    return;
  }

  manualCreateSubmit.disabled = true;
  manualCreateSubmit.textContent = "创建中";
  try {
    const task = await apiFetch("/api/v1/admin/manual-review-tasks", {
      method: "POST",
      body: new FormData(manualCreateForm)
    });
    manualCreateForm.reset();
    renderManualPanel(task);
    setMessage(taskMessage, "人工代跑任务已创建，已生成可复制的人工代跑指令。", "ok");
    await loadTasks();
  } catch (error) {
    setMessage(taskMessage, error.message, "error");
  } finally {
    manualCreateSubmit.disabled = false;
    manualCreateSubmit.textContent = "创建人工代跑任务";
  }
});

async function loadTasks() {
  const tasks = await apiFetch("/api/v1/admin/review-tasks");
  taskTable.innerHTML = tasks
    .map((task) => {
      const summary = task.error || task.summary || task.manualReason || "";
      return `
        <tr>
          <td><code>${task.id}</code></td>
          <td>${escapeHtml(task.originalFilename || "")}</td>
          <td><span class="pill ${statusClass[task.status] || ""}">${escapeHtml(task.statusText || task.status)}</span></td>
          <td>${escapeHtml(summary).slice(0, 160)}</td>
          <td>创建：${escapeHtml(task.createdAt || "")}<br />更新：${escapeHtml(task.updatedAt || "")}</td>
          <td>
            <div class="actions">
              <a href="/api/v1/admin/review-tasks/${task.id}/stage-outputs/download"><button class="secondary compact" type="button">阶段输出</button></a>
              ${task.reportAvailable ? `<a href="/api/v1/admin/review-tasks/${task.id}/report"><button class="secondary compact" type="button">Word</button></a>` : ""}
              ${task.pdfReportAvailable ? `<a href="/api/v1/admin/review-tasks/${task.id}/report.pdf"><button class="secondary compact" type="button">PDF</button></a>` : ""}
              <button class="secondary compact" data-manual-task="${task.id}" type="button">人工代跑</button>
              <button class="compact" data-retry-task="${task.id}" type="button">重试</button>
              <button class="danger compact" data-cancel-task="${task.id}" type="button">取消</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  taskTable.querySelectorAll("[data-manual-task]").forEach((button) => {
    button.addEventListener("click", () => openManualPanel(button.dataset.manualTask));
  });

  taskTable.querySelectorAll("[data-retry-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await apiFetch(`/api/v1/admin/review-tasks/${button.dataset.retryTask}/retry`, { method: "POST" });
        setMessage(taskMessage, "已触发重试。", "ok");
        await loadTasks();
      } catch (error) {
        setMessage(taskMessage, error.message, "error");
      }
    });
  });

  taskTable.querySelectorAll("[data-cancel-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await apiFetch(`/api/v1/admin/review-tasks/${button.dataset.cancelTask}/cancel`, { method: "POST" });
        setMessage(taskMessage, "已取消任务。", "ok");
        await loadTasks();
      } catch (error) {
        setMessage(taskMessage, error.message, "error");
      }
    });
  });
}

document.querySelector("#refreshTasksButton").addEventListener("click", loadTasks);
document.querySelector("#closeManualPanel").addEventListener("click", () => manualPanel.classList.add("hidden"));

copyManualSkillInstruction.addEventListener("click", async () => {
  const text = manualSkillInstruction.value.trim();
  if (!text) {
    setMessage(taskMessage, "当前任务没有可复制的人工代跑指令。", "error");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      manualSkillInstruction.focus();
      manualSkillInstruction.select();
      document.execCommand("copy");
    }
    setMessage(taskMessage, "人工代跑指令已复制。", "ok");
  } catch {
    manualSkillInstruction.focus();
    manualSkillInstruction.select();
    setMessage(taskMessage, "浏览器限制了自动复制，请手动复制文本框内容。", "error");
  }
});

document.querySelector("#saveManualSkillOutput").addEventListener("click", async () => {
  if (!activeManualTaskId) return;
  const packageText = manualSkillOutput.value.trim();
  if (!packageText) {
    setMessage(taskMessage, "请粘贴 skills 完整输出。", "error");
    return;
  }
  try {
    const task = await apiFetch(`/api/v1/admin/review-tasks/${activeManualTaskId}/manual-skill-output`, {
      method: "POST",
      body: JSON.stringify({ model: manualModel.value.trim(), packageText })
    });
    renderManualPanel(task);
    setMessage(taskMessage, "skills 输出已导入，Word 报告已生成。", "ok");
    await loadTasks();
  } catch (error) {
    setMessage(taskMessage, error.message, "error");
  }
});

function statusLabel(status) {
  return {
    published: "当前版本",
    draft: "草稿",
    archived: "历史版本"
  }[status] || status;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

checkSession();
