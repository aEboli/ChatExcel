import { AgentRunner } from "./agent-runner.js";
import { summarizeToolOutput } from "./activity-summary.js";
import { executeExcelTool, toToolErrorResult } from "./excel-executor.js";
import { HistoryState } from "./history-state.js";
import {
  AttachmentError,
  formatAttachmentSize,
  MAX_ATTACHMENTS,
  prepareImageFile,
} from "./image-attachments.js";

const previewMode = new URLSearchParams(globalThis.location.search).get("preview") === "1";

const elements = {
  statusDot: document.querySelector("#status-dot"),
  workbookStatus: document.querySelector("#workbook-status"),
  workbookLabel: document.querySelector("#workbook-label"),
  settingsButton: document.querySelector("#settings-button"),
  activity: document.querySelector("#activity"),
  activityToggle: document.querySelector("#activity-toggle"),
  activityList: document.querySelector("#activity-list"),
  activityEmpty: document.querySelector("#activity-empty"),
  activityCount: document.querySelector("#activity-count"),
  historyBanner: document.querySelector("#history-banner"),
  historyLabel: document.querySelector("#history-label"),
  historyLatestButton: document.querySelector("#history-latest-button"),
  conversation: document.querySelector("#conversation"),
  approval: document.querySelector("#approval"),
  approvalTitle: document.querySelector("#approval-title"),
  approvalTarget: document.querySelector("#approval-target"),
  approvalArguments: document.querySelector("#approval-arguments"),
  approveButton: document.querySelector("#approve-button"),
  denyButton: document.querySelector("#deny-button"),
  attachmentError: document.querySelector("#attachment-error"),
  attachmentList: document.querySelector("#attachment-list"),
  promptInput: document.querySelector("#prompt-input"),
  modelButton: document.querySelector("#model-button"),
  modelLabel: document.querySelector("#model-label"),
  modelMenu: document.querySelector("#model-menu"),
  effortButton: document.querySelector("#effort-button"),
  effortLabel: document.querySelector("#effort-label"),
  effortMenu: document.querySelector("#effort-menu"),
  contextButton: document.querySelector("#context-button"),
  contextLabel: document.querySelector("#context-label"),
  imageInput: document.querySelector("#image-input"),
  imageButton: document.querySelector("#image-button"),
  easterFooter: document.querySelector("#easter-footer"),
  easterTrigger: document.querySelector("#easter-trigger"),
  modeButton: document.querySelector("#mode-button"),
  modeIcon: document.querySelector("#mode-icon"),
  modeLabel: document.querySelector("#mode-label"),
  modeMenu: document.querySelector("#mode-menu"),
  runStatus: document.querySelector("#run-status"),
  sendButton: document.querySelector("#send-button"),
  settingsView: document.querySelector("#settings-view"),
  settingsBackButton: document.querySelector("#settings-back-button"),
  settingsForm: document.querySelector("#settings-form"),
  useSystemConfig: document.querySelector("#use-system-config"),
  systemProvider: document.querySelector("#system-provider"),
  systemEndpoint: document.querySelector("#system-endpoint"),
  fetchSystemModelsButton: document.querySelector("#fetch-system-models-button"),
  customSettings: document.querySelector("#custom-settings"),
  apiProtocol: document.querySelector("#api-protocol"),
  apiUrl: document.querySelector("#api-url"),
  apiKey: document.querySelector("#api-key"),
  fetchModelsButton: document.querySelector("#fetch-models-button"),
  settingsModel: document.querySelector("#settings-model"),
  contextWindow: document.querySelector("#context-window"),
  settingsEffort: document.querySelector("#settings-effort"),
  maxSteps: document.querySelector("#max-steps"),
  mappingNote: document.querySelector("#mapping-note"),
  settingsMessage: document.querySelector("#settings-message"),
  settingsCancelButton: document.querySelector("#settings-cancel-button"),
  settingsSaveButton: document.querySelector("#settings-save-button"),
  confirmModal: document.querySelector("#confirm-modal"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmCancelButton: document.querySelector("#confirm-cancel-button"),
  confirmAcceptButton: document.querySelector("#confirm-accept-button"),
};

const history = new HistoryState();
const activityRows = new Map();
const activityGroups = new Map();
const registeredWorksheetIds = new Set();
const settingsBackground = [...document.querySelectorAll(".app-shell > :not(#settings-view):not(#confirm-modal)")];
let attachments = [];
let approvalMode = "required";
let configState = null;
let selectedModel = null;
let selectedReasoningEffort = null;
let currentContext = null;
let workbookIdentity = "当前工作簿";
let configStatusTitle = "配置尚未读取";
let settingsDiscoveredModels = [];
let pendingConfirmation = null;
let workbookCollectionEventsRegistered = false;
let workbookLabelTimer = null;
let manualChangePromptActive = false;
let suppressWorkbookChangesUntil = 0;
let streamingAssistantId = null;
let currentOperationId = null;
let currentRunOutcome = "success";
let uiBusy = false;

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function requestJson(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (response.status === 204) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("API_RESPONSE_INVALID", "本地服务返回了无效响应。", response.status);
  }
  if (!response.ok || payload.ok === false) {
    throw new ApiError(
      payload.error?.code ?? "API_ERROR",
      payload.error?.message ?? "本地服务请求失败。",
      response.status,
    );
  }
  return payload;
}

async function requestStream(path, { method = "POST", body, signal, onEvent } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: "text/event-stream",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError("API_RESPONSE_INVALID", "本地服务返回了无效响应。", response.status);
    }
    if (!response.ok || payload.ok === false) {
      throw new ApiError(
        payload.error?.code ?? "API_ERROR",
        payload.error?.message ?? "本地服务请求失败。",
        response.status,
      );
    }
    return payload;
  }

  if (!response.ok || !response.body?.getReader) {
    throw new ApiError("API_STREAM_UNAVAILABLE", "本地服务无法建立事件流。", response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];
  let result = null;

  const handleFrame = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    const currentEvent = eventName;
    eventName = "message";
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new ApiError("API_STREAM_INVALID", "本地服务返回了无效事件。", response.status);
    }
    if (currentEvent === "delta") {
      onEvent?.(payload);
    } else if (currentEvent === "result") {
      result = payload;
    } else if (currentEvent === "error") {
      throw new ApiError(
        payload.error?.code ?? "API_ERROR",
        payload.error?.message ?? "本地服务请求失败。",
        response.status,
      );
    }
  };

  try {
    while (true) {
      signal?.throwIfAborted?.();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const normalized = line.replace(/\r$/, "");
        if (normalized === "") {
          handleFrame();
        } else if (normalized.startsWith("event:")) {
          eventName = normalized.slice(6).trim() || "message";
        } else if (normalized.startsWith("data:")) {
          dataLines.push(normalized.slice(5).replace(/^ /, ""));
        }
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") {
      const normalized = buffer.replace(/\r$/, "");
      if (normalized.startsWith("data:")) dataLines.push(normalized.slice(5).replace(/^ /, ""));
    }
    handleFrame();
  } finally {
    reader.releaseLock?.();
  }

  if (result === null) {
    throw new ApiError("API_STREAM_INCOMPLETE", "本地服务事件流未返回最终结果。", response.status);
  }
  return result;
}

const api = {
  start: ({ sessionId, message, attachments: images, model, reasoningEffort, signal, onEvent }) =>
    requestStream("/api/sessions", {
      method: "POST",
      body: { sessionId, message, attachments: images, model, reasoningEffort },
      signal,
      onEvent,
    }),
  addMessage: ({ sessionId, message, attachments: images, model, reasoningEffort, signal, onEvent }) =>
    requestStream(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: { message, attachments: images, model, reasoningEffort },
      signal,
      onEvent,
    }),
  submitToolResults: ({ sessionId, results, signal, onEvent }) =>
    requestStream(`/api/sessions/${encodeURIComponent(sessionId)}/tool-results`, {
      method: "POST",
      body: { results },
      signal,
      onEvent,
    }),
  cancel: ({ sessionId }) =>
    requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  saveSettings: (settings) => requestJson("/api/settings", { method: "POST", body: settings }),
  discoverModels: (settings) => requestJson("/api/models", { method: "POST", body: settings }),
};

function createIcon(source) {
  const image = document.createElement("img");
  image.src = source;
  image.alt = "";
  return image;
}

function targetFromArguments(args) {
  const worksheet = args.worksheet ?? args.currentName ?? "当前工作表";
  const address = args.address ?? args.sourceAddress ?? args.newName ?? args.name ?? "";
  return address ? `${worksheet} · ${address}` : String(worksheet);
}

function updateWorkbookStatusTitle() {
  elements.workbookStatus.title = `${workbookIdentity}\n${configStatusTitle}`;
}

function setWorkbookIdentity(label) {
  workbookIdentity = label;
  elements.workbookLabel.textContent = label;
  updateWorkbookStatusTitle();
}

function fileBaseName(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return "当前工作簿";
  let decoded = rawUrl;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    // Keep the original URL when it contains invalid escaping.
  }
  const path = decoded.split(/[?#]/, 1)[0];
  const fileName = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return fileName.replace(/\.(?:xlsx|xlsm|xlsb|xls)$/i, "") || "当前工作簿";
}

async function readWorkbookIdentity() {
  if (previewMode || !globalThis.Excel) return "销售分析-Sheet1";
  try {
    return await Excel.run(async (context) => {
      const workbook = context.workbook;
      const activeWorksheet = workbook.worksheets.getActiveWorksheet();
      workbook.load("name");
      activeWorksheet.load("name");
      await context.sync();
      return `${workbook.name || "当前工作簿"}-${activeWorksheet.name}`;
    });
  } catch {
    return Excel.run(async (context) => {
      const activeWorksheet = context.workbook.worksheets.getActiveWorksheet();
      activeWorksheet.load("name");
      await context.sync();
      const documentName = fileBaseName(globalThis.Office?.context?.document?.url);
      return `${documentName}-${activeWorksheet.name}`;
    });
  }
}

async function refreshWorkbookIdentity() {
  try {
    setWorkbookIdentity(await readWorkbookIdentity());
  } catch (error) {
    setWorkbookIdentity("当前工作簿");
    configStatusTitle = error instanceof Error ? error.message : configStatusTitle;
    updateWorkbookStatusTitle();
  }
}

function queueWorkbookIdentityRefresh() {
  clearTimeout(workbookLabelTimer);
  workbookLabelTimer = setTimeout(() => void refreshWorkbookIdentity(), 120);
}

function appendMessage(role, text, messageAttachments = []) {
  history.addMessage(role, text || "模型未返回文本。", { attachments: messageAttachments });
  renderConversation();
}

function appendAssistantDelta(text) {
  if (typeof text !== "string" || text === "") return;
  if (!streamingAssistantId) {
    const message = history.addMessage("assistant", "", { timelineIndex: history.latestIndex });
    streamingAssistantId = message.id;
  }
  const message = history.updateMessage(streamingAssistantId, {
    text: `${history.messages.find((entry) => entry.id === streamingAssistantId)?.text ?? ""}${text}`,
  });
  if (message) renderConversation();
}

function finishAssistantMessage(text) {
  if (streamingAssistantId) {
    history.updateMessage(streamingAssistantId, { text: text || "模型未返回文本。" });
    streamingAssistantId = null;
    renderConversation();
    return;
  }
  appendMessage("assistant", text);
}

function renderConversation() {
  const visibleMessages = history.visibleMessages();
  const fragment = document.createDocumentFragment();
  if (visibleMessages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.append(createIcon("/assets/fluent/model.svg"));
    const label = document.createElement("strong");
    label.textContent = "准备就绪";
    empty.append(label);
    fragment.append(empty);
  } else {
    for (const entry of visibleMessages) {
      const message = document.createElement("div");
      message.className = `message ${entry.role}`;
      if (entry.id === streamingAssistantId) message.classList.add("is-streaming");
      if (entry.attachments.length > 0) {
        const images = document.createElement("div");
        images.className = "message-images";
        for (const attachment of entry.attachments) {
          const image = document.createElement("img");
          image.src = attachment.dataUrl;
          image.alt = attachment.name || "消息图片";
          images.append(image);
        }
        message.append(images);
      }
      const copy = document.createElement("div");
      copy.textContent = entry.text;
      message.append(copy);
      fragment.append(message);
    }
  }
  elements.conversation.replaceChildren(fragment);
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function truncateText(value, maxLength = 56) {
  const text = String(value ?? "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function operationStatusText(status) {
  if (status === "running") return "进行中";
  if (status === "error") return "失败";
  if (status === "stopped") return "已停止";
  return "完成";
}

function renderActivityGroup(operationId) {
  const group = activityGroups.get(operationId);
  const operation = history.getOperation(operationId);
  if (!group || !operation) return;
  const entries = operation.stepIndexes
    .map((index) => history.activities[index])
    .filter(Boolean);
  const hasRunning = entries.some((entry) => entry.status === "pending" || entry.status === "running");
  const hasError = entries.some((entry) => entry.status === "error" || entry.status === "denied");
  const status = operation.status !== "running"
    ? operation.status
    : hasRunning || entries.length === 0 ? "running" : hasError ? "error" : "success";
  group.dataset.status = status;
  group.querySelector(".activity-group-title").textContent = truncateText(operation.label || "本次操作");
  group.querySelector(".activity-group-preview").textContent = entries.length > 0
    ? entries.map((entry) => entry.label).join(" · ")
    : "等待步骤";
  group.querySelector(".activity-group-count").textContent = `${entries.length} 步`;
  group.querySelector(".activity-group-state").textContent = operationStatusText(status);
  group.querySelector(".activity-group-steps").hidden = operation.collapsed !== false;
  group.querySelector(".activity-group-header").setAttribute("aria-expanded", String(operation.collapsed === false));
  group.classList.toggle("is-collapsed", operation.collapsed !== false);
  elements.activityCount.textContent = String(history.operations.length);
}

function ensureActivityGroup(operationId) {
  let group = activityGroups.get(operationId);
  if (group) return group;
  const operation = history.getOperation(operationId);
  if (!operation) return null;
  operation.collapsed = true;
  group = document.createElement("section");
  group.className = "activity-group";
  group.dataset.operationId = operation.id;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "activity-group-header";
  header.title = "展开或折叠本次任务的全部步骤";
  const indicator = document.createElement("span");
  indicator.className = "activity-indicator";
  const copy = document.createElement("span");
  copy.className = "activity-group-copy";
  const title = document.createElement("strong");
  title.className = "activity-group-title";
  const preview = document.createElement("span");
  preview.className = "activity-group-preview";
  copy.append(title, preview);
  const meta = document.createElement("span");
  meta.className = "activity-group-meta";
  const count = document.createElement("span");
  count.className = "activity-group-count";
  const state = document.createElement("span");
  state.className = "activity-group-state";
  const chevron = createIcon("/assets/fluent/chevron-down.svg");
  chevron.className = "activity-group-chevron";
  meta.append(count, state, chevron);
  header.append(indicator, copy, meta);

  const steps = document.createElement("div");
  steps.className = "activity-group-steps";
  header.addEventListener("click", () => {
    operation.collapsed = operation.collapsed === false;
    renderActivityGroup(operation.id);
  });
  group.append(header, steps);
  elements.activityList.append(group);
  activityGroups.set(operation.id, group);
  renderActivityGroup(operation.id);
  return group;
}

function ensureActivityRow(event) {
  let row = activityRows.get(event.call.callId);
  if (row) return row;

  const entry = history.addActivity({
    callId: event.call.callId,
    label: event.tool.label,
    target: targetFromArguments(event.arguments),
    result: "",
    status: "pending",
    state: "等待",
  });
  const group = ensureActivityGroup(entry.operationId);
  row = document.createElement("button");
  row.type = "button";
  row.className = "activity-row";
  row.dataset.status = "pending";
  row.dataset.index = String(entry.index);
  row.title = "查看此步骤对应的历史上下文";

  const indicator = document.createElement("span");
  indicator.className = "activity-indicator";
  const copy = document.createElement("span");
  copy.className = "activity-copy";
  const name = document.createElement("span");
  name.className = "activity-name";
  name.textContent = entry.label;
  const detail = document.createElement("span");
  detail.className = "activity-detail";
  const target = document.createElement("span");
  target.className = "activity-target";
  target.textContent = entry.target;
  target.title = entry.target;
  const result = document.createElement("span");
  result.className = "activity-result";
  result.hidden = true;
  detail.append(target, result);
  copy.append(name, detail);
  const state = document.createElement("span");
  state.className = "activity-state";
  state.textContent = entry.state;
  row.append(indicator, copy, state);
  row.addEventListener("click", () => {
    if (runner.running) return;
    history.select(entry.index);
    renderHistoricalState();
  });

  elements.activityEmpty.hidden = true;
  group?.querySelector(".activity-group-steps")?.append(row);
  elements.activityCount.textContent = String(history.operations.length);
  activityRows.set(entry.callId, row);
  renderActivityGroup(entry.operationId);
  renderHistoricalState();
  return row;
}

function updateActivity(event, status, stateText, resultText = null) {
  const row = ensureActivityRow(event);
  const entry = history.updateActivity(event.call.callId, {
    status,
    state: stateText,
    ...(resultText ? { result: resultText } : {}),
  });
  row.dataset.status = status;
  row.querySelector(".activity-state").textContent = stateText;
  if (resultText) {
    const result = row.querySelector(".activity-result");
    result.textContent = resultText;
    result.title = resultText;
    result.hidden = false;
  }
  renderActivityGroup(entry?.operationId);
  if (!history.isHistorical) {
    elements.activityList.scrollTop = elements.activityList.scrollHeight;
  }
}

function renderHistoricalState() {
  const selected = history.cursor;
  for (const entry of history.activities) {
    activityRows.get(entry.callId)?.classList.toggle("is-selected", entry.index === selected);
  }
  for (const operation of history.operations) renderActivityGroup(operation.id);
  elements.activityEmpty.hidden = history.operations.length > 0;
  elements.historyBanner.hidden = !history.isHistorical;
  if (history.isHistorical) {
    elements.historyLabel.textContent = `历史上下文 #${history.selectedIndex + 1} · 不会回滚工作簿`;
  }
  renderConversation();
}

function goToLatestHistory() {
  history.goLatest();
  renderHistoricalState();
}

function showConfirmation({ title, message, confirmText = "确认", cancelText = "取消" }) {
  if (pendingConfirmation) return Promise.resolve(false);
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmAcceptButton.textContent = confirmText;
  elements.confirmCancelButton.textContent = cancelText;
  elements.confirmModal.hidden = false;
  elements.confirmAcceptButton.focus();
  return new Promise((resolve) => {
    pendingConfirmation = resolve;
  });
}

function resolveConfirmation(value) {
  if (!pendingConfirmation) return;
  const resolve = pendingConfirmation;
  pendingConfirmation = null;
  elements.confirmModal.hidden = true;
  resolve(value);
}

async function guardHistoricalConversation() {
  if (!history.isHistorical) return true;
  const confirmed = await showConfirmation({
    title: "从最新状态继续？",
    message: `你正在查看操作 #${history.selectedIndex + 1} 的历史上下文。确认后会回到最新对话继续，工作簿不会自动回滚。`,
    confirmText: "回到最新并继续",
    cancelText: "留在历史",
  });
  if (confirmed) goToLatestHistory();
  return confirmed;
}

async function undoLatestWorkbookChange() {
  suppressWorkbookChangesUntil = Date.now() + 1_500;
  await Excel.run(async (context) => {
    context.workbook.application.undo();
    await context.sync();
  });
}

async function handleManualWorkbookChange() {
  if (
    previewMode ||
    runner.running ||
    Date.now() <= suppressWorkbookChangesUntil ||
    !history.isHistorical ||
    manualChangePromptActive
  ) {
    return;
  }
  manualChangePromptActive = true;
  try {
    const keepChange = await showConfirmation({
      title: "检测到手动修改",
      message: "当前正在查看历史上下文。确认可保留这次表格修改并回到最新状态；取消将尝试使用 Excel 原生撤销。",
      confirmText: "保留修改",
      cancelText: "撤销修改",
    });
    if (keepChange) {
      goToLatestHistory();
    } else {
      try {
        await undoLatestWorkbookChange();
      } catch (error) {
        appendMessage(
          "error",
          error instanceof Error ? `无法撤销手动修改：${error.message}` : "无法撤销手动修改。",
        );
      }
    }
  } finally {
    manualChangePromptActive = false;
  }
}

async function registerWorkbookEvents() {
  if (previewMode || !globalThis.Excel) return;
  await Excel.run(async (context) => {
    const worksheets = context.workbook.worksheets;
    worksheets.load("items/id");
    await context.sync();
    for (const worksheet of worksheets.items) {
      if (registeredWorksheetIds.has(worksheet.id)) continue;
      worksheet.onChanged.add(() => void handleManualWorkbookChange());
      worksheet.onActivated.add(queueWorkbookIdentityRefresh);
      registeredWorksheetIds.add(worksheet.id);
    }
    if (!workbookCollectionEventsRegistered && worksheets.onAdded?.add) {
      worksheets.onAdded.add(() => {
        queueWorkbookIdentityRefresh();
        void registerWorkbookEvents();
      });
      workbookCollectionEventsRegistered = true;
    }
    await context.sync();
  });
}

function closeMenus(except = null) {
  const pairs = [
    [elements.modelMenu, elements.modelButton],
    [elements.effortMenu, elements.effortButton],
    [elements.modeMenu, elements.modeButton],
  ];
  for (const [menu, button] of pairs) {
    if (menu === except) continue;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }
}

function toggleMenu(menu, button) {
  const opening = menu.hidden;
  closeMenus(opening ? menu : null);
  menu.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
}

function modelEntry(modelId) {
  return configState?.models?.find((model) => model.id === modelId) ?? null;
}

function availableReasoningEfforts() {
  return modelEntry(selectedModel)?.reasoningEfforts ?? configState?.config?.reasoningEfforts ?? [];
}

function renderModelMenu() {
  elements.modelMenu.replaceChildren();
  for (const model of configState?.models ?? []) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `menu-option${model.id === selectedModel ? " is-selected" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(model.id === selectedModel));
    option.append(createIcon("/assets/fluent/model.svg"));
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = model.id;
    const detail = document.createElement("small");
    detail.textContent = `${model.reasoningEfforts.length} 个思考等级`;
    copy.append(name, detail);
    option.append(copy);
    option.addEventListener("click", () => {
      selectedModel = model.id;
      const efforts = model.reasoningEfforts;
      selectedReasoningEffort = efforts.includes(selectedReasoningEffort)
        ? selectedReasoningEffort
        : efforts[0] ?? null;
      updateComposerControls();
      closeMenus();
    });
    elements.modelMenu.append(option);
  }
}

function renderEffortMenu() {
  elements.effortMenu.replaceChildren();
  for (const effort of availableReasoningEfforts()) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `menu-option${effort === selectedReasoningEffort ? " is-selected" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(effort === selectedReasoningEffort));
    option.append(createIcon("/assets/fluent/brain.svg"));
    const label = document.createElement("strong");
    label.textContent = effort;
    const copy = document.createElement("span");
    copy.append(label);
    option.append(copy);
    option.addEventListener("click", () => {
      selectedReasoningEffort = effort;
      updateComposerControls();
      closeMenus();
    });
    elements.effortMenu.append(option);
  }
}

function updateContextControl() {
  if (currentContext?.status === "available") {
    elements.contextLabel.textContent = `${currentContext.percent}%`;
    elements.contextButton.title = `上下文 ${currentContext.usedTokens.toLocaleString()} / ${currentContext.limitTokens.toLocaleString()} tokens`;
  } else {
    elements.contextLabel.textContent = "--";
    elements.contextButton.title = "提供方尚未返回上下文用量";
  }
}

function updateComposerControls() {
  elements.modelLabel.textContent = selectedModel || "模型";
  elements.modelButton.title = selectedModel ? `模型：${selectedModel}` : "选择模型";
  elements.effortLabel.textContent = selectedReasoningEffort || "思考";
  elements.effortButton.title = selectedReasoningEffort
    ? `思考等级：${selectedReasoningEffort}`
    : "选择思考等级";
  renderModelMenu();
  renderEffortMenu();
  updateContextControl();
}

function normalizeConfigState(payload) {
  const models = Array.isArray(payload.models) ? payload.models.map((model) => ({ ...model })) : [];
  if (payload.config?.model && !models.some((model) => model.id === payload.config.model)) {
    models.unshift({
      id: payload.config.model,
      reasoningEfforts: payload.config.reasoningEfforts ?? [payload.config.reasoningEffort ?? "none"],
      reasoningSource: payload.config.reasoningSource ?? "inferred",
    });
  }
  return {
    source: payload.source ?? "system",
    config: payload.config,
    models,
    protocols: Array.isArray(payload.protocols) ? payload.protocols.map((protocol) => ({ ...protocol })) : [],
    settings: payload.settings ?? {
      useSystemConfig: true,
      model: payload.config?.model,
      contextWindow: payload.config?.contextWindow,
      reasoningEffort: payload.config?.reasoningEffort,
      maxSteps: 100,
    },
  };
}

function applyConfigState(payload, { preserveSelection = true } = {}) {
  const previousModel = selectedModel;
  const previousEffort = selectedReasoningEffort;
  configState = normalizeConfigState(payload);
  selectedModel = preserveSelection && configState.models.some((model) => model.id === previousModel)
    ? previousModel
    : configState.config.model;
  const efforts = modelEntry(selectedModel)?.reasoningEfforts ?? [];
  selectedReasoningEffort = preserveSelection && efforts.includes(previousEffort)
    ? previousEffort
    : efforts.includes(configState.config.reasoningEffort)
      ? configState.config.reasoningEffort
      : efforts[0] ?? null;
  elements.statusDot.className = "status-dot is-ready";
  configStatusTitle = `${configState.config.providerName} · ${configState.config.model}\n${configState.config.endpoint}`;
  updateWorkbookStatusTitle();
  updateComposerControls();
}

async function refreshConfig() {
  elements.statusDot.className = "status-dot is-loading";
  configStatusTitle = "正在连接本地配置";
  updateWorkbookStatusTitle();
  try {
    const payload = await requestJson("/api/config");
    applyConfigState(payload);
    return payload;
  } catch (error) {
    elements.statusDot.className = "status-dot is-error";
    configStatusTitle = error instanceof Error ? error.message : "配置不可用";
    updateWorkbookStatusTitle();
    throw error;
  }
}

function setApprovalMode(mode) {
  approvalMode = mode === "auto" ? "auto" : "required";
  const isAuto = approvalMode === "auto";
  elements.modeButton.className = `mode-button ${isAuto ? "is-auto" : "is-required"}`;
  elements.modeIcon.src = isAuto ? "/assets/fluent/auto.svg" : "/assets/fluent/approval.svg";
  elements.modeLabel.textContent = isAuto ? "免审批" : "需审批";
  elements.modeButton.title = isAuto ? "无需审批：告知后直接执行" : "需要审批：每次修改由你决定";
  for (const option of elements.modeMenu.querySelectorAll("[data-mode]")) {
    option.classList.toggle("is-selected", option.dataset.mode === approvalMode);
  }
}

function updateSendState() {
  const hasContent = elements.promptInput.value.trim() !== "" || attachments.length > 0;
  const busy = uiBusy;
  elements.sendButton.disabled = busy ? false : !configState || !hasContent;
  elements.sendButton.classList.toggle("is-busy", busy);
  elements.sendButton.setAttribute("aria-busy", String(busy));
  elements.sendButton.title = busy ? "停止当前任务" : "发送";
  elements.sendButton.setAttribute("aria-label", busy ? "停止当前任务" : "发送");
}

function resizePromptInput() {
  elements.promptInput.style.height = "34px";
  elements.promptInput.style.height = `${Math.min(Math.max(34, elements.promptInput.scrollHeight), 118)}px`;
}

function setBusy(busy) {
  uiBusy = busy;
  elements.promptInput.disabled = busy;
  elements.modelButton.disabled = busy || !configState;
  elements.effortButton.disabled = busy || availableReasoningEfforts().length === 0;
  elements.imageButton.disabled = busy;
  elements.modeButton.disabled = busy;
  elements.settingsButton.disabled = busy;
  for (const row of activityRows.values()) row.disabled = busy;
  if (!busy) elements.runStatus.textContent = "";
  updateSendState();
}

function requestApproval(call, { signal }) {
  if (approvalMode === "auto") {
    const target = targetFromArguments(call.arguments);
    appendMessage("notice", `无需审批：即将执行“${call.label}”${target ? `（${target}）` : ""}。`);
    elements.runStatus.textContent = "已告知，正在执行修改";
    return Promise.resolve(true);
  }

  elements.approvalTitle.textContent = call.label;
  elements.approvalTarget.textContent = targetFromArguments(call.arguments);
  elements.approvalArguments.textContent = JSON.stringify(call.arguments, null, 2);
  elements.approval.hidden = false;
  elements.runStatus.textContent = "等待审批";

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      elements.approval.hidden = true;
      elements.approveButton.removeEventListener("click", approve);
      elements.denyButton.removeEventListener("click", deny);
      signal.removeEventListener("abort", abort);
    };
    const approve = () => {
      cleanup();
      resolve(true);
    };
    const deny = () => {
      cleanup();
      resolve(false);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Agent stopped", "AbortError"));
    };
    elements.approveButton.addEventListener("click", approve, { once: true });
    elements.denyButton.addEventListener("click", deny, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function safeExecuteTool(name, args) {
  suppressWorkbookChangesUntil = Date.now() + 1_200;
  try {
    return await executeExcelTool(name, args);
  } catch (error) {
    return toToolErrorResult(error);
  } finally {
    suppressWorkbookChangesUntil = Date.now() + 1_200;
  }
}

function handleRunnerEvent(event) {
  switch (event.type) {
    case "run_started":
      currentOperationId = history.startOperation({ label: event.message || "分析图片" }).id;
      currentRunOutcome = "success";
      streamingAssistantId = null;
      ensureActivityGroup(currentOperationId);
      elements.activityEmpty.hidden = true;
      appendMessage("user", event.message || "分析图片", event.attachments);
      elements.runStatus.textContent = "";
      setBusy(true);
      break;
    case "assistant_delta":
      appendAssistantDelta(event.text);
      break;
    case "context_updated":
      currentContext = event.context;
      updateContextControl();
      break;
    case "tool_pending":
      updateActivity(
        event,
        "pending",
        event.tool.mode === "modify"
          ? approvalMode === "auto" ? "将执行" : "待审批"
          : "待读取",
      );
      break;
    case "tool_running":
      updateActivity(event, "running", "执行中");
      elements.runStatus.textContent = "";
      break;
    case "tool_denied":
      updateActivity(event, "denied", "已拒绝", summarizeToolOutput(event.output));
      elements.runStatus.textContent = "";
      break;
    case "tool_completed":
      updateActivity(
        event,
        event.output?.ok === false ? "error" : "success",
        event.output?.ok === false ? "失败" : "完成",
        summarizeToolOutput(event.output),
      );
      elements.runStatus.textContent = "";
      break;
    case "assistant_message":
      finishAssistantMessage(event.message);
      break;
    case "run_error":
      currentRunOutcome = "error";
      streamingAssistantId = null;
      renderConversation();
      appendMessage("error", event.error instanceof Error ? event.error.message : "任务失败。" );
      break;
    case "run_stopped":
      currentRunOutcome = "stopped";
      streamingAssistantId = null;
      renderConversation();
      appendMessage("error", "任务已停止。" );
      break;
    case "run_finished":
      history.finishOperation(currentRunOutcome);
      currentOperationId = null;
      renderHistoricalState();
      elements.approval.hidden = true;
      setBusy(false);
      elements.promptInput.focus();
      break;
  }
}

const runner = new AgentRunner({
  api,
  executeTool: safeExecuteTool,
  requestApproval,
  onEvent: handleRunnerEvent,
});

function showAttachmentError(message) {
  elements.attachmentError.textContent = message;
  elements.attachmentError.hidden = !message;
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  for (const attachment of attachments) {
    const item = document.createElement("div");
    item.className = "attachment-item";
    item.title = `${attachment.name} · ${formatAttachmentSize(attachment.byteLength)}`;
    const image = document.createElement("img");
    image.src = attachment.dataUrl;
    image.alt = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.title = `删除 ${attachment.name}`;
    remove.setAttribute("aria-label", `删除 ${attachment.name}`);
    remove.append(createIcon("/assets/fluent/dismiss.svg"));
    remove.addEventListener("click", () => {
      attachments = attachments.filter((candidate) => candidate.id !== attachment.id);
      renderAttachments();
      updateSendState();
    });
    item.append(image, remove);
    elements.attachmentList.append(item);
  }
  elements.attachmentList.hidden = attachments.length === 0;
}

async function addSelectedImages(fileList) {
  showAttachmentError("");
  const files = [...fileList];
  if (attachments.length + files.length > MAX_ATTACHMENTS) {
    showAttachmentError(`每条消息最多添加 ${MAX_ATTACHMENTS} 张图片。`);
    return;
  }
  elements.imageButton.disabled = true;
  try {
    for (const file of files) {
      attachments.push(await prepareImageFile(file));
      renderAttachments();
      updateSendState();
    }
  } catch (error) {
    showAttachmentError(
      error instanceof AttachmentError || error instanceof Error
        ? error.message
        : "无法添加图片。",
    );
  } finally {
    elements.imageButton.disabled = runner.running;
    elements.imageInput.value = "";
  }
}

async function submitPrompt() {
  const message = elements.promptInput.value.trim();
  if ((message === "" && attachments.length === 0) || runner.running || !configState) return;
  if (!(await guardHistoricalConversation())) return;

  const outgoingAttachments = attachments.map(({ name, mimeType, dataUrl }) => ({
    name,
    mimeType,
    dataUrl,
  }));
  elements.promptInput.value = "";
  attachments = [];
  renderAttachments();
  resizePromptInput();
  updateSendState();
  try {
    await runner.run(message, {
      attachments: outgoingAttachments,
      model: selectedModel,
      reasoningEffort: selectedReasoningEffort,
    });
  } catch {
    // Runner events already render a safe error.
  }
}

function setSettingsMessage(message, kind = "") {
  elements.settingsMessage.textContent = message;
  elements.settingsMessage.className = `settings-message${kind ? ` is-${kind}` : ""}`;
}

function renderSettingsProtocols(preferredProtocol = "openai-responses") {
  const protocols = configState?.protocols ?? [];
  elements.apiProtocol.replaceChildren();
  for (const protocol of protocols) {
    const option = document.createElement("option");
    option.value = protocol.id;
    option.textContent = protocol.label;
    elements.apiProtocol.append(option);
  }
  if (protocols.length === 0) {
    const option = document.createElement("option");
    option.value = preferredProtocol;
    option.textContent = preferredProtocol;
    elements.apiProtocol.append(option);
  }
  elements.apiProtocol.value = protocols.some((protocol) => protocol.id === preferredProtocol)
    ? preferredProtocol
    : protocols[0]?.id ?? preferredProtocol;
}

function renderSettingsEfforts(preferredEffort = null) {
  const entry = settingsDiscoveredModels.find((model) => model.id === elements.settingsModel.value);
  elements.settingsEffort.replaceChildren();
  if (!entry) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "请先选择模型";
    elements.settingsEffort.append(option);
    elements.settingsEffort.disabled = true;
    elements.mappingNote.textContent = "";
    return;
  }
  for (const effort of entry.reasoningEfforts) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = effort;
    elements.settingsEffort.append(option);
  }
  elements.settingsEffort.disabled = false;
  elements.settingsEffort.value = entry.reasoningEfforts.includes(preferredEffort)
    ? preferredEffort
    : entry.reasoningEfforts[0] ?? "";
  elements.mappingNote.textContent = entry.reasoningSource === "provider"
    ? "思考等级来自提供方模型元数据。"
    : "提供方未声明思考等级，当前按模型 ID 保守映射。";
}

function renderSettingsModels(preferredModel = null, preferredEffort = null) {
  elements.settingsModel.replaceChildren();
  if (settingsDiscoveredModels.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "请先获取模型";
    elements.settingsModel.append(option);
    elements.settingsModel.disabled = true;
    renderSettingsEfforts();
    return;
  }
  for (const model of settingsDiscoveredModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.id;
    elements.settingsModel.append(option);
  }
  elements.settingsModel.disabled = false;
  elements.settingsModel.value = settingsDiscoveredModels.some((model) => model.id === preferredModel)
    ? preferredModel
    : settingsDiscoveredModels[0].id;
  renderSettingsEfforts(preferredEffort);
}

function toggleCustomSettings() {
  const useSystemConfig = elements.useSystemConfig.checked;
  elements.customSettings.hidden = useSystemConfig;
  elements.fetchSystemModelsButton.hidden = !useSystemConfig;
}

function populateSettings() {
  if (!configState) return;
  elements.useSystemConfig.checked = configState.settings.useSystemConfig;
  elements.systemProvider.textContent = `${configState.config.providerName} · ${configState.config.model}`;
  elements.systemEndpoint.textContent = configState.config.endpoint;
  renderSettingsProtocols(configState.settings.protocol ?? "openai-responses");
  elements.apiUrl.value = configState.settings.apiUrl ?? "";
  elements.apiKey.value = "";
  elements.apiKey.placeholder = configState.source === "custom"
    ? "已配置，留空表示不修改"
    : "保存到当前 Windows 用户的加密配置";
  elements.contextWindow.value = String(configState.settings.contextWindow ?? 200000);
  elements.maxSteps.value = String(configState.settings.maxSteps ?? 100);
  settingsDiscoveredModels = Array.isArray(configState.settings.models)
    ? configState.settings.models.map((model) => ({ ...model }))
    : [];
  renderSettingsModels(configState.settings.model, configState.settings.reasoningEffort);
  toggleCustomSettings();
  setSettingsMessage("");
}

function openSettings() {
  if (runner.running || !configState) return;
  closeMenus();
  populateSettings();
  for (const section of settingsBackground) {
    section.inert = true;
    section.setAttribute("aria-hidden", "true");
  }
  elements.settingsView.hidden = false;
  elements.settingsBackButton.focus();
}

function closeSettings() {
  elements.settingsView.hidden = true;
  for (const section of settingsBackground) {
    section.inert = false;
    section.removeAttribute("aria-hidden");
  }
  elements.settingsButton.focus();
}

async function discoverModels(useSystemConfig) {
  const button = useSystemConfig ? elements.fetchSystemModelsButton : elements.fetchModelsButton;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "获取中";
  setSettingsMessage("正在获取模型列表…");
  try {
    const result = await api.discoverModels({
      useSystemConfig,
      ...(useSystemConfig
        ? {}
        : {
            protocol: elements.apiProtocol.value,
            apiUrl: elements.apiUrl.value.trim(),
            apiKey: elements.apiKey.value,
          }),
    });
    if (useSystemConfig) {
      configState.models = result.models;
      if (!configState.models.some((model) => model.id === configState.config.model)) {
        configState.models.unshift({
          id: configState.config.model,
          reasoningEfforts: configState.config.reasoningEfforts,
          reasoningSource: configState.config.reasoningSource,
        });
      }
      updateComposerControls();
      setSettingsMessage(`已获取 ${result.models.length} 个模型，可在对话框底部切换。`, "success");
    } else {
      settingsDiscoveredModels = result.models;
      renderSettingsModels(configState.settings.model, configState.settings.reasoningEffort);
      setSettingsMessage(`已获取 ${result.models.length} 个模型。`, "success");
    }
  } catch (error) {
    setSettingsMessage(error instanceof Error ? error.message : "获取模型失败。", "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  elements.settingsSaveButton.disabled = true;
  setSettingsMessage("正在保存配置…");
  try {
    const useSystemConfig = elements.useSystemConfig.checked;
    const payload = await api.saveSettings(
      useSystemConfig
        ? { useSystemConfig: true, maxSteps: Number(elements.maxSteps.value) }
        : {
            useSystemConfig: false,
            protocol: elements.apiProtocol.value,
            apiUrl: elements.apiUrl.value.trim(),
            apiKey: elements.apiKey.value,
            model: elements.settingsModel.value,
            contextWindow: Number(elements.contextWindow.value),
            reasoningEffort: elements.settingsEffort.value,
            maxSteps: Number(elements.maxSteps.value),
          },
    );
    await runner.resetSession();
    applyConfigState(payload, { preserveSelection: false });
    setSettingsMessage("配置已更新。", "success");
    closeSettings();
    elements.runStatus.textContent = "配置已更新，新消息将使用当前选择";
  } catch (error) {
    setSettingsMessage(error instanceof Error ? error.message : "保存配置失败。", "error");
  } finally {
    elements.settingsSaveButton.disabled = false;
  }
}

function seedPreviewState() {
  if (!previewMode || history.activities.length > 0) return;
  history.addMessage("user", "整理 Sheet1 的验收数据，并汇报实际表格名与图表名。", {
    timelineIndex: -1,
  });
  history.startOperation({ label: "整理 Sheet1 的验收数据" });
  const samples = [
    {
      call: { callId: "preview-read" },
      tool: { label: "读取指定范围" },
      arguments: { worksheet: "Sheet1", address: "A1:D5" },
      output: { ok: true, target: "Sheet1!A1:D5", rowCount: 5, columnCount: 4 },
    },
    {
      call: { callId: "preview-table" },
      tool: { label: "创建 Excel 表格" },
      arguments: { worksheet: "Sheet1", address: "A1:C5" },
      output: { ok: true, target: "Sheet1!A1:C5", table: "AcceptanceTable" },
    },
    {
      call: { callId: "preview-chart" },
      tool: { label: "创建图表" },
      arguments: { worksheet: "Sheet1", sourceAddress: "A1:C4" },
      output: { ok: true, target: "Sheet1!A1:C4", chart: "Chart 1" },
    },
  ];
  for (const sample of samples) {
    updateActivity(sample, "success", "完成", summarizeToolOutput(sample.output));
  }
  history.finishOperation("success");
  history.addMessage(
    "assistant",
    "已整理 Sheet1!A1:D5，并创建表格 AcceptanceTable 与图表 Chart 1。",
    { timelineIndex: history.latestIndex },
  );
  renderHistoricalState();
}

function previewConfigState() {
  return {
    source: "system",
    config: {
      providerName: "本地配置",
      model: "gpt-5.6-sol",
      endpoint: "http://localhost:8080/responses",
      reasoningEffort: "max",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      reasoningSource: "inferred",
      contextWindow: 200000,
    },
    protocols: [
      { id: "openai-responses", label: "OpenAI Responses" },
      { id: "openai-chat-completions", label: "OpenAI Chat Completions" },
      { id: "anthropic-messages", label: "Anthropic Messages" },
      { id: "google-gemini", label: "Google Gemini generateContent" },
    ],
    models: [
      { id: "gpt-5.6-sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], reasoningSource: "inferred" },
      { id: "gpt-5.6-terra", reasoningEfforts: ["low", "medium", "high", "xhigh"], reasoningSource: "inferred" },
      { id: "gpt-5.5", reasoningEfforts: ["low", "medium", "high"], reasoningSource: "inferred" },
    ],
    settings: {
      useSystemConfig: true,
      model: "gpt-5.6-sol",
      contextWindow: 200000,
      reasoningEffort: "max",
      protocol: "openai-responses",
      maxSteps: 100,
      models: [],
    },
  };
}

async function initializePreview() {
  setWorkbookIdentity("销售分析-Sheet1");
  try {
    await refreshConfig();
  } catch {
    applyConfigState(previewConfigState(), { preserveSelection: false });
  }
  seedPreviewState();
  setBusy(false);
  elements.promptInput.focus();
}

async function initializeExcel(info) {
  if (info.host !== Office.HostType.Excel) {
    if (previewMode) {
      await initializePreview();
      return;
    }
    elements.statusDot.className = "status-dot is-error";
    setWorkbookIdentity("请在 Microsoft Excel 中打开");
    elements.promptInput.disabled = true;
    return;
  }
  await Promise.allSettled([refreshConfig(), refreshWorkbookIdentity(), registerWorkbookEvents()]);
  setBusy(false);
  elements.promptInput.focus();
}

elements.promptInput.addEventListener("input", () => {
  resizePromptInput();
  updateSendState();
});
elements.promptInput.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
    /^(image\/(?:png|jpeg|webp))$/i.test(file.type),
  );
  if (files.length === 0) return;
  event.preventDefault();
  const pastedText = event.clipboardData?.getData("text/plain") ?? "";
  if (pastedText !== "") {
    const start = elements.promptInput.selectionStart ?? elements.promptInput.value.length;
    const end = elements.promptInput.selectionEnd ?? start;
    elements.promptInput.value = `${elements.promptInput.value.slice(0, start)}${pastedText}${elements.promptInput.value.slice(end)}`;
    const caret = start + pastedText.length;
    elements.promptInput.setSelectionRange(caret, caret);
    elements.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  void addSelectedImages(files);
});
elements.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitPrompt();
  }
});
elements.sendButton.addEventListener("click", () => {
  if (runner.running) void runner.stop();
  else void submitPrompt();
});
elements.imageButton.addEventListener("click", () => elements.imageInput.click());
elements.imageInput.addEventListener("change", () => void addSelectedImages(elements.imageInput.files));
elements.easterTrigger.addEventListener("click", () => {
  const active = elements.easterFooter.classList.toggle("is-active");
  elements.easterTrigger.setAttribute("aria-pressed", String(active));
  elements.easterTrigger.title = active ? "收起 ChatEx 彩蛋" : "打开 ChatEx 彩蛋";
});
elements.modelButton.addEventListener("click", () => toggleMenu(elements.modelMenu, elements.modelButton));
elements.effortButton.addEventListener("click", () => toggleMenu(elements.effortMenu, elements.effortButton));
elements.modeButton.addEventListener("click", () => toggleMenu(elements.modeMenu, elements.modeButton));
elements.modeMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-mode]");
  if (!option) return;
  setApprovalMode(option.dataset.mode);
  closeMenus();
});
elements.activityToggle.addEventListener("click", () => {
  const collapsed = elements.activity.classList.toggle("is-collapsed");
  elements.activityToggle.setAttribute("aria-expanded", String(!collapsed));
});
elements.historyLatestButton.addEventListener("click", goToLatestHistory);
elements.settingsButton.addEventListener("click", openSettings);
elements.settingsBackButton.addEventListener("click", closeSettings);
elements.settingsCancelButton.addEventListener("click", closeSettings);
elements.useSystemConfig.addEventListener("change", toggleCustomSettings);
elements.apiProtocol.addEventListener("change", () => {
  settingsDiscoveredModels = [];
  renderSettingsModels();
  setSettingsMessage("协议已更改，请重新获取模型列表。");
});
elements.fetchSystemModelsButton.addEventListener("click", () => void discoverModels(true));
elements.fetchModelsButton.addEventListener("click", () => void discoverModels(false));
elements.settingsModel.addEventListener("change", () => renderSettingsEfforts());
elements.settingsForm.addEventListener("submit", saveSettings);
elements.confirmCancelButton.addEventListener("click", () => resolveConfirmation(false));
elements.confirmAcceptButton.addEventListener("click", () => resolveConfirmation(true));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-anchor")) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (pendingConfirmation) resolveConfirmation(false);
    else closeMenus();
  }
});

setApprovalMode("required");
resizePromptInput();
renderConversation();
updateSendState();

if (previewMode) {
  void initializePreview();
} else if (globalThis.Office?.onReady) {
  Office.onReady((info) => void initializeExcel(info));
} else {
  elements.statusDot.className = "status-dot is-error";
  setWorkbookIdentity("Office.js 未加载");
  elements.promptInput.disabled = true;
}
