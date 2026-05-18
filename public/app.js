const statusMap = {
  queued: "排队中",
  parsing: "解析材料中",
  stage1_running: "GPT 预审组审稿中",
  stage2_running: "终稿输出生成中",
  manual_stage_pending: "待人工预审输出",
  manual_final_pending: "待人工终稿输出",
  docx_generating: "生成质控报告中",
  succeeded: "预审完成",
  failed: "预审失败",
  cancelled: "任务已取消"
};

const statusOrder = [
  "queued",
  "parsing",
  "stage1_running",
  "stage2_running",
  "docx_generating",
  "succeeded"
];

const manualStatusOrder = [
  "queued",
  "parsing",
  "manual_stage_pending",
  "manual_final_pending",
  "docx_generating",
  "succeeded"
];

const form = document.querySelector("#taskForm");
const submitButton = document.querySelector("#submitButton");
const formMessage = document.querySelector("#formMessage");
const taskCaption = document.querySelector("#taskCaption");
const emptyState = document.querySelector("#emptyState");
const taskState = document.querySelector("#taskState");
const statusTitle = document.querySelector("#statusTitle");
const statusMeta = document.querySelector("#statusMeta");
const statusPill = document.querySelector("#statusPill");
const timeline = document.querySelector("#timeline");
const summaryBox = document.querySelector("#summaryBox");
const downloadLink = document.querySelector("#downloadLink");
const pdfDownloadLink = document.querySelector("#pdfDownloadLink");

let pollTimer = null;
let currentTaskId = localStorage.getItem("lastReviewTaskId") || "";

function setMessage(text, type = "") {
  formMessage.textContent = text;
  formMessage.className = `message ${type}`.trim();
}

function renderTimeline(status) {
  const order = status.startsWith("manual_") ? manualStatusOrder : statusOrder;
  const currentIndex = order.indexOf(status);
  timeline.innerHTML = "";
  for (const item of order) {
    const index = order.indexOf(item);
    const row = document.createElement("div");
    row.className = "step";
    if (index < currentIndex || status === "succeeded") row.classList.add("done");
    if (index === currentIndex) row.classList.add("active");
    row.innerHTML = `<span class="dot"></span><span>${statusMap[item]}</span>`;
    timeline.appendChild(row);
  }
}

function renderTask(task) {
  emptyState.classList.add("hidden");
  taskState.classList.remove("hidden");
  taskCaption.textContent = `${task.originalFilename || "文稿"} · ${task.id}`;
  statusTitle.textContent = task.statusText || statusMap[task.status] || task.status;
  statusMeta.textContent = `更新时间：${task.updatedAt || ""}`;
  statusPill.textContent = task.statusText || statusMap[task.status] || task.status;
  statusPill.className = `pill ${task.status}`;
  summaryBox.textContent = task.summary || (task.error ? `错误原因：${task.error}` : "预审完成后显示。");
  renderTimeline(task.status);

  if (task.reportAvailable) {
    downloadLink.href = `/api/v1/review-tasks/${task.id}/report`;
    downloadLink.classList.remove("hidden");
  } else {
    downloadLink.classList.add("hidden");
  }

  if (task.pdfReportAvailable) {
    pdfDownloadLink.href = `/api/v1/review-tasks/${task.id}/report.pdf`;
    pdfDownloadLink.classList.remove("hidden");
  } else {
    pdfDownloadLink.classList.add("hidden");
  }
}

async function fetchTask(taskId) {
  const response = await fetch(`/api/v1/review-tasks/${taskId}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "获取任务失败");
  renderTask(data);
  if (["succeeded", "failed", "cancelled"].includes(data.status)) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(taskId) {
  clearInterval(pollTimer);
  fetchTask(taskId).catch((error) => setMessage(error.message, "error"));
  pollTimer = setInterval(() => {
    fetchTask(taskId).catch((error) => setMessage(error.message, "error"));
  }, 3000);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("");
  const file = document.querySelector("#fileInput").files[0];
  if (!file) {
    setMessage("请选择 Word 文稿。", "error");
    return;
  }
  if (!/\.(doc|docx)$/i.test(file.name)) {
    setMessage("当前仅支持 doc / docx，暂不支持 PDF。", "error");
    return;
  }

  const formData = new FormData(form);
  submitButton.disabled = true;
  submitButton.textContent = "提交中";
  try {
    const response = await fetch("/api/v1/review-tasks", {
      method: "POST",
      body: formData
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "提交失败");
    currentTaskId = data.id;
    localStorage.setItem("lastReviewTaskId", currentTaskId);
    setMessage("任务已提交。", "ok");
    renderTask(data);
    startPolling(currentTaskId);
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "提交预审任务";
  }
});

if (currentTaskId) {
  startPolling(currentTaskId);
}
