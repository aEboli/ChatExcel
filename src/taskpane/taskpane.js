import { AgentRunner } from "./agent-runner.js";
import { summarizeToolOutput } from "./activity-summary.js";
import { executeExcelTool, toToolErrorResult } from "./excel-executor.js";
import {
  captureOfficeHistoryPreview,
  historyPreviewFallback,
  historyPreviewTarget,
} from "./history-preview.js";
import { HistoryState } from "./history-state.js";
import {
  normalizeReasoningModel,
  reasoningEffortDisplayName,
  reasoningEffortLevel,
  reasoningEffortMenuValues,
  reconcileReasoningEffort,
} from "./model-selection.js";
import {
  AttachmentError,
  clipboardImageFiles,
  formatAttachmentSize,
  MAX_ATTACHMENTS,
  prepareImageFile,
} from "./image-attachments.js";

const pageParameters = new URLSearchParams(globalThis.location.search);
const previewMode = pageParameters.get("preview") === "1";
const legacySessionId = pageParameters.get("legacy");
const legacyMode = /^[0-9a-f]{48}$/.test(legacySessionId ?? "");
const RECOVERY_HEARTBEAT_MS = 30_000;
const RECOVERY_BINDING_UNAVAILABLE_MESSAGE =
  "当前工作簿没有可验证的稳定标识，已关闭本地恢复以避免将对话恢复到其他工作簿。";

const PROTOCOL_MODEL_EXAMPLES = Object.freeze({
  "openai-responses": ["GPT-5", "GPT-4.1", "o3", "o4-mini"],
  "openai-chat-completions": ["Qwen3", "DeepSeek-V3", "GLM-4", "Kimi K2"],
  "anthropic-messages": ["Claude Opus", "Claude Sonnet", "Claude Haiku"],
  "google-gemini": ["Gemini 2.5 Pro", "Gemini 2.5 Flash", "Gemini Flash-Lite"],
});

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
  historyPreview: document.querySelector("#history-preview"),
  historyPreviewTitle: document.querySelector("#history-preview-title"),
  historyPreviewBody: document.querySelector("#history-preview-body"),
  conversation: document.querySelector("#conversation"),
  recoveryNotice: document.querySelector("#recovery-notice"),
  recoveryNoticeText: document.querySelector("#recovery-notice-text"),
  clearRecoveryButton: document.querySelector("#clear-recovery-button"),
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
  modelEffortLabel: document.querySelector("#model-effort-label"),
  modelSettingsMenu: document.querySelector("#model-settings-menu"),
  modelSettingsPanel: document.querySelector("#model-settings-panel"),
  modelSettingsModelRow: document.querySelector("#model-settings-model-row"),
  modelMenuValue: document.querySelector("#model-menu-value"),
  modelSubmenu: document.querySelector("#model-submenu"),
  modelMenuBack: document.querySelector("#model-menu-back"),
  modelMenu: document.querySelector("#model-menu"),
  effortButton: document.querySelector("#effort-button"),
  effortLabel: document.querySelector("#effort-label"),
  effortSubmenu: document.querySelector("#effort-submenu"),
  effortMenuBack: document.querySelector("#effort-menu-back"),
  effortMenu: document.querySelector("#effort-menu"),
  resetModelSettings: document.querySelector("#reset-model-settings"),
  contextButton: document.querySelector("#context-button"),
  contextLabel: document.querySelector("#context-label"),
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
  protocolModelList: document.querySelector("#protocol-model-list"),
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
  imagePreviewModal: document.querySelector("#image-preview-modal"),
  imagePreviewImage: document.querySelector("#image-preview-image"),
  imagePreviewClose: document.querySelector("#image-preview-close"),
};

const history = new HistoryState();
const activityRows = new Map();
const activityGroups = new Map();
const registeredWorksheetIds = new Set();
const settingsBackground = [...document.querySelectorAll(".app-shell > :not(#settings-view):not(#confirm-modal)")];
let attachments = [];
let imagePreviewTrigger = null;
let approvalMode = "required";
let approvalModeSaving = false;
let providerConnectivityState = "checking";
let providerConnectivityCode = "";
let providerProbeId = 0;
let configState = null;
let selectedModel = null;
let selectedReasoningEffort = null;
let currentContext = null;
let workbookIdentity = "当前工作簿";
let workbookBinding = null;
let sessionWorkbookBinding = null;
let configStatusTitle = "配置尚未读取";
let settingsDiscoveredModels = [];
let pendingConfirmation = null;
let workbookCollectionEventsRegistered = false;
let workbookLabelTimer = null;
let manualChangePromptActive = false;
let suppressWorkbookChangesUntil = 0;
let legacyRevision = 0;
let legacyActiveSheetRevision = 0;
let legacyStateTimer = null;
let streamingAssistantId = null;
let streamingAssistantStepTextLength = 0;
let currentOperationId = null;
let currentRunOutcome = "success";
let uiBusy = false;
let recoveryHeartbeatTimer = null;
let clearingRecoverySession = false;
let suppressNextStoppedNotice = false;
let recoveryUnavailable = false;
let recoveryDisabledForBinding = false;
let selectedHistoryActivityIndex = null;

class ApiError extends Error {
  constructor(code, message, status, { recoverableSession = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.recoverableSession = recoverableSession === true;
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
      { recoverableSession: payload.error?.recoverableSession === true },
    );
  }
  return payload;
}

async function requestStream(path, { method = "POST", body, signal, onEvent } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Accept: "text/event-stream",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    throw new ApiError(
      "API_TRANSPORT_ERROR",
      "无法连接本地服务，当前会话可在服务恢复后继续。",
      0,
      { recoverableSession: true },
    );
  }
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
          { recoverableSession: payload.error?.recoverableSession === true },
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
        { recoverableSession: payload.error?.recoverableSession === true },
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
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError" || error instanceof ApiError) throw error;
    throw new ApiError(
      "API_STREAM_INTERRUPTED",
      "本地服务事件流已中断，当前会话可在服务恢复后继续。",
      response.status,
      { recoverableSession: true },
    );
  } finally {
    reader.releaseLock?.();
  }

  if (result === null) {
    throw new ApiError(
      "API_STREAM_INCOMPLETE",
      "本地服务事件流未返回最终结果，当前会话可在服务恢复后继续。",
      response.status,
      { recoverableSession: true },
    );
  }
  return result;
}

const api = {
  start: ({ sessionId, message, attachments: images, model, reasoningEffort, workbookBinding, signal, onEvent }) =>
    requestStream("/api/sessions", {
      method: "POST",
      body: { sessionId, message, attachments: images, model, reasoningEffort, workbookBinding },
      signal,
      onEvent,
    }),
  addMessage: ({ sessionId, message, attachments: images, model, reasoningEffort, workbookBinding, signal, onEvent }) =>
    requestStream(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: { message, attachments: images, model, reasoningEffort, workbookBinding },
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
  restoreConversation: ({ workbookBinding }) => requestJson("/api/conversation-recovery/restore", {
    method: "POST",
    body: { workbookBinding },
  }),
  touchConversation: ({ sessionId, workbookBinding }) => requestJson("/api/conversation-recovery/touch", {
    method: "POST",
    body: { sessionId, workbookBinding },
  }),
  clearConversation: ({ sessionId }) =>
    requestJson(`/api/conversation-recovery/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  saveSettings: (settings) => requestJson("/api/settings", { method: "POST", body: settings }),
  saveApprovalMode: (approvalMode) => requestJson("/api/settings/approval-mode", {
    method: "POST",
    body: { approvalMode },
  }),
  discoverModels: (settings) => requestJson("/api/models", { method: "POST", body: settings }),
  probeProviderConnectivity: () => requestJson("/api/provider-connectivity", { method: "POST", body: {} }),
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

function workbookBindingFromDocumentUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
  const path = rawUrl.trim().split(/[?#]/, 1)[0];
  return path === "" ? null : `document-url:${path}`;
}

async function readWorkbookIdentity() {
  if (legacyMode) {
    const state = await requestLegacy({ action: "state" });
    legacyRevision = state.revision;
    legacyActiveSheetRevision = state.activeSheetRevision;
    return state.label;
  }
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

async function readWorkbookBinding() {
  if (legacyMode) return null;
  if (previewMode || !globalThis.Excel) return null;

  return workbookBindingFromDocumentUrl(globalThis.Office?.context?.document?.url);
}

async function prepareWorkbookBinding() {
  const wasDisabledForBinding = recoveryDisabledForBinding;
  try {
    workbookBinding = await readWorkbookBinding();
  } catch {
    workbookBinding = null;
  }
  recoveryDisabledForBinding = !workbookBinding && !previewMode;
  if (recoveryDisabledForBinding) {
    stopRecoveryHeartbeat();
    setRecoveryNotice(RECOVERY_BINDING_UNAVAILABLE_MESSAGE, { kind: "warning" });
  } else if (wasDisabledForBinding && !recoveryUnavailable) {
    setRecoveryNotice("");
  }
  return workbookBinding;
}

function queueWorkbookIdentityRefresh() {
  clearTimeout(workbookLabelTimer);
  workbookLabelTimer = setTimeout(() => void refreshWorkbookIdentity(), 120);
}

function setRecoveryNotice(message, { clearable = false, kind = "info" } = {}) {
  const visible = typeof message === "string" && message.trim() !== "";
  elements.recoveryNotice.hidden = !visible;
  elements.recoveryNotice.dataset.kind = visible ? kind : "";
  elements.recoveryNoticeText.textContent = visible ? message : "";
  elements.clearRecoveryButton.hidden = !visible || !clearable;
  elements.clearRecoveryButton.disabled = !clearable;
}

function resetRecoveredPresentation() {
  history.clear();
  selectedHistoryActivityIndex = null;
  activityRows.clear();
  activityGroups.clear();
  elements.activityList.replaceChildren(elements.activityEmpty);
  elements.activityEmpty.hidden = false;
  elements.activityCount.textContent = "0";
  currentOperationId = null;
  streamingAssistantId = null;
  streamingAssistantStepTextLength = 0;
}

function recoveryStateFromPayload(payload) {
  const value = payload?.recovery ?? payload?.active ?? payload;
  return value && typeof value === "object" ? value : null;
}

function recoveryPresentationMessages(recovery) {
  return Array.isArray(recovery?.presentationMessages) ? recovery.presentationMessages : [];
}

function stopRecoveryHeartbeat() {
  if (recoveryHeartbeatTimer === null) return;
  clearInterval(recoveryHeartbeatTimer);
  recoveryHeartbeatTimer = null;
}

async function touchConversationRecovery() {
  await prepareWorkbookBinding();
  const sessionId = runner.sessionId;
  const binding = workbookBinding;
  if (!sessionId || !binding || previewMode) return;

  try {
    const response = await api.touchConversation({ sessionId, workbookBinding: binding });
    if (runner.sessionId !== sessionId) return;
    const active = recoveryStateFromPayload(response);
    if (active?.status === "touched") {
      if (recoveryUnavailable) {
        recoveryUnavailable = false;
        if (!runner.running) {
          setRecoveryNotice("本地恢复已恢复，可继续防护闪退。", { clearable: true, kind: "info" });
        }
      }
      return;
    }
    if (active?.status === "unavailable") {
      recoveryUnavailable = true;
      setRecoveryNotice(
        "本地恢复暂不可用，当前对话仍可继续但闪退后可能无法恢复。",
        { kind: "warning" },
      );
      return;
    }
    if (["expired", "missing", "mismatch"].includes(active?.status)) {
      stopRecoveryHeartbeat();
      if (active.status === "expired") {
        setRecoveryNotice("当前恢复会话已过期并被安全清除。", { kind: "warning" });
      } else {
        recoveryUnavailable = true;
        setRecoveryNotice(
          "本地恢复记录已不存在，当前对话仍可继续但闪退后可能无法恢复。",
          { kind: "warning" },
        );
      }
    }
  } catch {
    // The in-memory conversation can still finish; a later heartbeat may recover the cache.
  }
}

function startRecoveryHeartbeat() {
  stopRecoveryHeartbeat();
  if (!runner.sessionId || !workbookBinding || previewMode) return;
  recoveryHeartbeatTimer = setInterval(() => void touchConversationRecovery(), RECOVERY_HEARTBEAT_MS);
}

async function restoreConversationRecovery() {
  if (!workbookBinding || previewMode) return;

  try {
    const response = await api.restoreConversation({ workbookBinding });
    const recovery = recoveryStateFromPayload(response);
    if (!recovery) return;

    if (recovery.status === "available") {
      if (typeof recovery.sessionId !== "string" || recovery.sessionId.trim() === "") {
        setRecoveryNotice("本地恢复记录无效，未恢复旧对话。", { kind: "warning" });
        return;
      }
      runner.restoreSession(recovery.sessionId);
      sessionWorkbookBinding = workbookBinding;
      resetRecoveredPresentation();
      history.restorePresentation(recoveryPresentationMessages(recovery));
      renderHistoricalState();
      setRecoveryNotice(
        "已恢复当前工作簿的短期对话。中断的模型请求或 Excel 修改不会自动重发，请检查后再继续。",
        { clearable: true, kind: "warning" },
      );
      startRecoveryHeartbeat();
      void touchConversationRecovery();
      return;
    }

    if (recovery.status === "expired") {
      setRecoveryNotice("上次会话恢复期限已结束，记录已安全清除。", { kind: "warning" });
    } else if (recovery.status === "unavailable") {
      setRecoveryNotice("本地恢复暂不可用，未恢复旧对话。", { kind: "warning" });
    }
  } catch {
    setRecoveryNotice("本地恢复暂不可用，未恢复旧对话。", { kind: "warning" });
  }
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
  if (message) {
    streamingAssistantStepTextLength += text.length;
    renderConversation();
  }
}

function resetStreamingAssistant(discardTextLength) {
  if (!Number.isSafeInteger(discardTextLength) || discardTextLength <= 0) {
    return;
  }
  streamingAssistantStepTextLength = Math.max(0, streamingAssistantStepTextLength - discardTextLength);
  if (!streamingAssistantId) return;
  const message = history.messages.find((entry) => entry.id === streamingAssistantId);
  if (!message) {
    streamingAssistantId = null;
    return;
  }
  const updated = history.trimMessageSuffix(streamingAssistantId, discardTextLength);
  if (!updated || updated.text === "") {
    streamingAssistantId = null;
  }
  renderConversation();
}

function finishAssistantMessage(text) {
  if (streamingAssistantId) {
    const messageId = streamingAssistantId;
    const message = history.messages.find((entry) => entry.id === messageId);
    const preservePrefixLength = Math.max(
      0,
      (typeof message?.text === "string" ? message.text.length : 0) - streamingAssistantStepTextLength,
    );
    streamingAssistantId = null;
    streamingAssistantStepTextLength = 0;
    if (history.finalizeMessage(messageId, text, { preservePrefixLength })) {
      renderConversation();
      return;
    }
  }
  streamingAssistantStepTextLength = 0;
  appendMessage("assistant", text);
}

function openImagePreview(attachment, trigger) {
  if (typeof attachment?.dataUrl !== "string" || attachment.dataUrl === "") return;
  closeMenus();
  imagePreviewTrigger = trigger ?? document.activeElement;
  elements.imagePreviewImage.src = attachment.dataUrl;
  elements.imagePreviewImage.alt = attachment.name || "图片预览";
  elements.imagePreviewModal.hidden = false;
  elements.imagePreviewClose.focus();
}

function closeImagePreview() {
  if (elements.imagePreviewModal.hidden) return;
  elements.imagePreviewModal.hidden = true;
  elements.imagePreviewImage.removeAttribute("src");
  elements.imagePreviewImage.alt = "";
  const trigger = imagePreviewTrigger;
  imagePreviewTrigger = null;
  if (typeof trigger?.focus === "function" && trigger.isConnected !== false) trigger.focus();
}

function createImagePreviewButton(attachment, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = `放大查看 ${attachment.name || "图片"}`;
  button.setAttribute("aria-label", button.title);
  const image = document.createElement("img");
  image.src = attachment.dataUrl;
  image.alt = attachment.name || "消息图片";
  button.append(image);
  button.addEventListener("click", () => openImagePreview(attachment, button));
  return button;
}

function createConversationMessage(entry, { actionStep = false } = {}) {
  const message = document.createElement("div");
  message.className = `message ${entry.role}`;
  if (actionStep) message.classList.add("action-flow-step");
  if (entry.id === streamingAssistantId) message.classList.add("is-streaming");
  if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
    const images = document.createElement("div");
    images.className = "message-images";
    for (const attachment of entry.attachments) {
      if (typeof attachment?.dataUrl !== "string" || attachment.dataUrl === "") continue;
      images.append(createImagePreviewButton(attachment, "message-image-button"));
    }
    if (images.childElementCount > 0) message.append(images);
  }
  const copy = document.createElement("div");
  copy.textContent = entry.text;
  message.append(copy);
  return message;
}

function createActionFlow(entries) {
  const flow = document.createElement("div");
  flow.className = "action-flow";
  flow.setAttribute("aria-label", "自动审批动作");
  for (const [index, entry] of entries.entries()) {
    flow.append(createConversationMessage(entry, { actionStep: true }));
    if (index < entries.length - 1) {
      const arrow = createIcon("/assets/fluent/arrow-up.svg");
      arrow.className = "action-flow-arrow";
      arrow.setAttribute("aria-hidden", "true");
      flow.append(arrow);
    }
  }
  return flow;
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
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const entry = visibleMessages[index];
      if (entry.role !== "notice") {
        fragment.append(createConversationMessage(entry));
        continue;
      }

      const notices = [entry];
      while (visibleMessages[index + 1]?.role === "notice") {
        notices.push(visibleMessages[index + 1]);
        index += 1;
      }
      fragment.append(createActionFlow(notices));
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
  row.title = "查看此步骤对应的历史表格和对话上下文";

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
    selectedHistoryActivityIndex = entry.index;
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
    ...(event.preview ? { preview: event.preview } : {}),
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

function renderHistoryPreview(entry) {
  elements.historyPreviewBody.replaceChildren();
  elements.historyPreview.hidden = !entry;
  if (!entry) return;

  const preview = entry.preview;
  const target = [preview?.worksheet, preview?.address].filter(Boolean).join(" · ");
  elements.historyPreviewTitle.textContent = target || entry.label || "历史步骤预览";

  if (!preview || preview.kind === "summary") {
    const message = document.createElement("p");
    message.className = "history-preview-empty";
    message.textContent = preview?.message ?? "该步骤的表格预览不可用。";
    elements.historyPreviewBody.append(message);
    return;
  }

  if (preview.kind === "image") {
    const image = document.createElement("img");
    image.className = "history-preview-image";
    image.src = preview.dataUrl;
    image.alt = `操作 #${entry.index + 1} 的${target || "工作簿"}预览`;
    elements.historyPreviewBody.append(image);
  } else if (preview.kind === "grid") {
    const table = document.createElement("table");
    table.className = "history-preview-grid";
    const header = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerRow.append(document.createElement("th"));
    for (const column of preview.columns ?? []) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column;
      headerRow.append(cell);
    }
    header.append(headerRow);
    const body = document.createElement("tbody");
    for (const row of preview.rows ?? []) {
      const rowElement = document.createElement("tr");
      const rowLabel = document.createElement("th");
      rowLabel.scope = "row";
      rowLabel.textContent = String(row.row);
      rowElement.append(rowLabel);
      for (const cell of row.cells) {
        const cellElement = document.createElement("td");
        cellElement.textContent = cell.text;
        if (cell.formula) cellElement.title = cell.formula;
        rowElement.append(cellElement);
      }
      body.append(rowElement);
    }
    table.append(header, body);
    elements.historyPreviewBody.append(table);
  }

  if (preview.truncated) {
    const notice = document.createElement("p");
    notice.className = "history-preview-note";
    notice.textContent = "预览已裁剪为可查看的范围。";
    elements.historyPreviewBody.append(notice);
  }
}

function renderHistoricalState() {
  const selected = selectedHistoryActivityIndex;
  const selectedEntry = selected === null ? null : history.activities[selected] ?? null;
  for (const entry of history.activities) {
    activityRows.get(entry.callId)?.classList.toggle("is-selected", entry.index === selected);
  }
  for (const operation of history.operations) renderActivityGroup(operation.id);
  elements.activityEmpty.hidden = history.operations.length > 0;
  elements.historyBanner.hidden = !selectedEntry;
  if (selectedEntry) {
    elements.historyLabel.textContent = `历史步骤 #${selectedEntry.index + 1} · 仅预览，不会修改或保存工作簿`;
    elements.historyLatestButton.textContent = history.isHistorical ? "回到最新" : "关闭预览";
  }
  renderHistoryPreview(selectedEntry);
  renderConversation();
}

function goToLatestHistory() {
  history.goLatest();
  selectedHistoryActivityIndex = null;
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
  if (legacyMode) {
    const result = await requestLegacy({ action: "undo" });
    legacyRevision = result.revision;
    return;
  }
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
  if (legacyMode) {
    clearInterval(legacyStateTimer);
    legacyStateTimer = setInterval(() => void pollLegacyState(), 750);
    return;
  }
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

async function pollLegacyState() {
  try {
    const state = await requestLegacy({ action: "state" });
    if (state.closed) throw new Error("原生 .xls 工作簿已关闭。");
    if (state.activeSheetRevision !== legacyActiveSheetRevision) {
      legacyActiveSheetRevision = state.activeSheetRevision;
      setWorkbookIdentity(state.label);
    }
    if (state.revision !== legacyRevision) {
      const wasExternal = Date.now() > suppressWorkbookChangesUntil;
      legacyRevision = state.revision;
      if (wasExternal) void handleManualWorkbookChange();
    }
  } catch (error) {
    clearInterval(legacyStateTimer);
    legacyStateTimer = null;
    elements.statusDot.className = "status-dot is-error";
    setWorkbookIdentity("XLS 原生会话已断开");
    elements.promptInput.disabled = true;
    updateSendState();
  }
}

function closeMenus() {
  elements.modelSettingsMenu.hidden = true;
  elements.modelSettingsPanel.hidden = false;
  elements.modelSubmenu.hidden = true;
  elements.effortSubmenu.hidden = true;
  elements.modelMenu.hidden = true;
  elements.effortMenu.hidden = true;
  elements.modelButton.setAttribute("aria-expanded", "false");
  elements.modelSettingsModelRow.setAttribute("aria-expanded", "false");
  elements.effortButton.setAttribute("aria-expanded", "false");
  elements.modeMenu.hidden = true;
  elements.modeButton.setAttribute("aria-expanded", "false");
}

function openModelSettingsMenu() {
  closeMenus();
  elements.modelSettingsMenu.hidden = false;
  elements.modelSettingsPanel.hidden = false;
  elements.modelButton.setAttribute("aria-expanded", "true");
}

function openModelSettingsSubmenu(kind) {
  closeMenus();
  elements.modelSettingsMenu.hidden = false;
  elements.modelSettingsPanel.hidden = true;
  const isModel = kind === "model";
  const submenu = isModel ? elements.modelSubmenu : elements.effortSubmenu;
  const menu = isModel ? elements.modelMenu : elements.effortMenu;
  const row = isModel ? elements.modelSettingsModelRow : elements.effortButton;
  submenu.hidden = false;
  menu.hidden = false;
  row.setAttribute("aria-expanded", "true");
  elements.modelButton.setAttribute("aria-expanded", "true");
}

function toggleModelSettingsMenu() {
  if (elements.modelSettingsMenu.hidden) openModelSettingsMenu();
  else closeMenus();
}

function toggleMenu(menu, button) {
  if (menu === elements.modeMenu) {
    const opening = menu.hidden;
    closeMenus();
    menu.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
  }
}

function modelEntry(modelId) {
  return configState?.models?.find((model) => model.id === modelId) ?? null;
}

function modelDisplayName(modelId) {
  const value = String(modelId ?? "").trim();
  if (!value) return "--";
  const match = value.match(/^gpt-(\d+(?:\.\d+)?)-(sol|terra)$/i);
  if (match) return `${match[1]} ${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}`;
  return value;
}

function defaultReasoningEffortForModel(modelId) {
  return reconcileReasoningEffortForModel(modelId, undefined);
}

function reconcileReasoningEffortForModel(modelId, selectedEffort) {
  return reconcileReasoningEffort({
    model: modelEntry(modelId),
    selectedEffort,
    configuredModelId: configState?.config?.model,
    configuredEffort: configState?.config?.reasoningEffort,
  });
}

function availableReasoningEfforts() {
  return reasoningEffortMenuValues(modelEntry(selectedModel));
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
    name.textContent = modelDisplayName(model.id);
    const detail = document.createElement("small");
    const menuValues = reasoningEffortMenuValues(model);
    const compatibilitySuffix = model.reasoningEfforts.length === 0 && model.compatibleReasoningEfforts.length > 0
      ? "（兼容）"
      : "";
    const effortSummary = menuValues.length > 0
      ? `${menuValues.length} 个推理选项${compatibilitySuffix}`
      : "提供方默认";
    detail.textContent = model.id === modelDisplayName(model.id)
      ? effortSummary
      : `${model.id} · ${effortSummary}`;
    copy.append(name, detail);
    option.append(copy);
    option.addEventListener("click", () => {
      selectedModel = model.id;
      selectedReasoningEffort = reconcileReasoningEffortForModel(selectedModel, selectedReasoningEffort);
      updateComposerControls();
      closeMenus();
    });
    elements.modelMenu.append(option);
  }
}

function renderEffortMenu() {
  elements.effortMenu.replaceChildren();
  const model = modelEntry(selectedModel);
  const hasCompatibleEfforts = model?.reasoningEfforts.length === 0 && model.compatibleReasoningEfforts.length > 0;
  for (const effort of availableReasoningEfforts()) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `menu-option${effort === selectedReasoningEffort ? " is-selected" : ""}`;
    option.dataset.effortLevel = reasoningEffortLevel(effort);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(effort === selectedReasoningEffort));
    option.append(createIcon("/assets/fluent/brain.svg"));
    const label = document.createElement("strong");
    label.textContent = reasoningEffortDisplayName(effort);
    const description = effort === null
      ? "提供方默认"
      : hasCompatibleEfforts
        ? "兼容档位"
        : null;
    option.setAttribute(
      "aria-label",
      `推理强度：${label.textContent}${effort === null ? "" : `（${effort}）`}${description ? `，${description}` : ""}`,
    );
    const copy = document.createElement("span");
    copy.append(label);
    if (description) {
      const detail = document.createElement("small");
      detail.textContent = description;
      copy.append(detail);
    }
    option.append(copy);
    option.addEventListener("click", () => {
      selectedReasoningEffort = effort;
      updateComposerControls();
      closeMenus();
    });
    elements.effortMenu.append(option);
  }
}

function compactTokenCount(value) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) return "--";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(Math.round(tokens));
}

function updateContextControl() {
  const limitTokens = Number(currentContext?.limitTokens ?? configState?.config?.contextWindow ?? configState?.settings?.contextWindow);
  const compactLimit = compactTokenCount(limitTokens);
  const hasUsage = currentContext?.status === "available" && Number.isFinite(Number(currentContext.percent));
  const percent = hasUsage ? Math.max(0, Math.min(100, Number(currentContext.percent))) : 0;
  const usedTokens = Number(currentContext?.usedTokens);
  const displayedLimit = compactLimit === "--" ? "上下文长度尚未读取" : `上下文长度 ${compactLimit}`;
  elements.contextLabel.textContent = compactLimit;
  elements.contextButton.dataset.contextState = hasUsage ? "available" : "unavailable";
  elements.contextButton.style.setProperty("--context-progress", `${percent * 3.6}deg`);
  elements.contextButton.title = hasUsage && Number.isFinite(usedTokens) && Number.isFinite(limitTokens)
    ? `${displayedLimit} · 已使用 ${usedTokens.toLocaleString()} / ${limitTokens.toLocaleString()} tokens（${Math.round(percent)}%）`
    : `${displayedLimit} · 提供方尚未返回上下文用量`;
  elements.contextButton.setAttribute("aria-label", elements.contextButton.title);
}

function providerConnectivityDescription() {
  if (providerConnectivityState === "ready") return "当前模型提供方连通成功";
  if (providerConnectivityState === "error") {
    if (providerConnectivityCode === "PROVIDER_TIMEOUT") return "当前模型提供方连接超时";
    if (providerConnectivityCode === "PROVIDER_HTTP_ERROR") return "当前模型提供方拒绝连接";
    if (providerConnectivityCode === "PROVIDER_RESPONSE_INVALID") return "当前模型提供方响应无效";
    return "无法连接当前模型提供方";
  }
  return "正在测试当前模型提供方连通性";
}

function updateProviderConnectivityVisuals() {
  const state = providerConnectivityState === "ready"
    ? "ready"
    : providerConnectivityState === "error"
      ? "error"
      : "checking";
  const description = providerConnectivityDescription();
  const modelTitle = selectedModel
    ? `模型：${modelDisplayName(selectedModel)}，推理强度：${reasoningEffortDisplayName(selectedReasoningEffort)}`
    : "选择模型";
  for (const button of [elements.modelButton, elements.settingsButton]) {
    button.dataset.providerConnectivity = state;
    button.setAttribute("aria-busy", String(state === "checking"));
  }
  elements.modelButton.title = `${modelTitle} · ${description}`;
  elements.modelButton.setAttribute("aria-label", `${modelTitle}，${description}`);
  elements.settingsButton.title = `打开设置 · ${description}`;
  elements.settingsButton.setAttribute("aria-label", `打开设置，${description}`);
}

function setProviderConnectivityState(state, code = "") {
  providerConnectivityState = state === "ready" ? "ready" : state === "error" ? "error" : "checking";
  providerConnectivityCode = typeof code === "string" ? code : "";
  updateProviderConnectivityVisuals();
}

function updateComposerControls() {
  const modelName = modelDisplayName(selectedModel);
  const effortName = reasoningEffortDisplayName(selectedReasoningEffort);
  elements.modelLabel.textContent = modelName;
  elements.modelEffortLabel.textContent = effortName;
  elements.modelMenuValue.textContent = modelName;
  elements.effortLabel.textContent = effortName;
  elements.modelButton.dataset.effortLevel = reasoningEffortLevel(selectedReasoningEffort);
  elements.effortButton.dataset.effortLevel = reasoningEffortLevel(selectedReasoningEffort);
  elements.effortButton.disabled = uiBusy || availableReasoningEfforts().length === 0;
  elements.effortButton.title = selectedReasoningEffort
    ? `推理强度：${effortName}（${selectedReasoningEffort}）`
    : "推理强度：自动（提供方默认）";
  elements.effortButton.setAttribute("aria-label", elements.effortButton.title);
  renderModelMenu();
  renderEffortMenu();
  updateContextControl();
  updateProviderConnectivityVisuals();
}

function resetModelSettings() {
  const defaultModel = configState?.config?.model
    ?? configState?.settings?.model
    ?? configState?.models?.[0]?.id
    ?? null;
  selectedModel = defaultModel;
  selectedReasoningEffort = defaultReasoningEffortForModel(defaultModel);
  updateComposerControls();
  closeMenus();
}

function modelFromPublicConfig(config = {}) {
  return normalizeReasoningModel({
    id: config.model,
    reasoningEfforts: config.reasoningEfforts,
    compatibleReasoningEfforts: config.compatibleReasoningEfforts,
    reasoningMode: config.reasoningMode ?? "levels",
    reasoningSource: config.reasoningSource ?? "inferred",
    defaultReasoningEffort: config.defaultReasoningEffort ?? null,
    contextWindow: config.contextWindow,
    contextSource: config.contextSource ?? null,
  });
}

function normalizeConfigState(payload) {
  const config = payload.config ?? {};
  const models = Array.isArray(payload.models) ? payload.models.map(normalizeReasoningModel) : [];
  if (config.model && !models.some((model) => model.id === config.model)) {
    models.unshift(modelFromPublicConfig(config));
  }
  const settings = payload.settings ?? {
    useSystemConfig: true,
    model: config.model,
    contextWindow: config.contextWindow,
    reasoningEffort: config.reasoningEffort,
    maxSteps: 100,
    approvalMode: "required",
  };
  return {
    source: payload.source ?? "system",
    config,
    models,
    protocols: Array.isArray(payload.protocols) ? payload.protocols.map((protocol) => ({ ...protocol })) : [],
    settings: {
      ...settings,
      models: Array.isArray(settings.models) ? settings.models.map(normalizeReasoningModel) : [],
    },
  };
}

function replaceConversationModels(models) {
  const previousModel = selectedModel;
  const previousEffort = selectedReasoningEffort;
  configState.models = Array.isArray(models) ? models.map(normalizeReasoningModel) : [];
  if (configState.config.model && !configState.models.some((model) => model.id === configState.config.model)) {
    configState.models.unshift(modelFromPublicConfig(configState.config));
  }
  selectedModel = configState.models.some((model) => model.id === previousModel)
    ? previousModel
    : configState.config.model ?? configState.models[0]?.id ?? null;
  selectedReasoningEffort = reconcileReasoningEffortForModel(selectedModel, previousEffort);
}

function applyConfigState(payload, { preserveSelection = true } = {}) {
  const previousModel = selectedModel;
  const previousEffort = selectedReasoningEffort;
  configState = normalizeConfigState(payload);
  selectedModel = preserveSelection && configState.models.some((model) => model.id === previousModel)
    ? previousModel
    : configState.config.model ?? configState.models[0]?.id ?? null;
  selectedReasoningEffort = reconcileReasoningEffortForModel(
    selectedModel,
    preserveSelection ? previousEffort : undefined,
  );
  elements.statusDot.className = "status-dot is-ready";
  configStatusTitle = `${configState.config.providerName} · ${configState.config.model}\n${configState.config.endpoint}`;
  updateWorkbookStatusTitle();
  setApprovalMode(configState.settings.approvalMode);
  updateComposerControls();
}

async function refreshConfig() {
  elements.statusDot.className = "status-dot is-loading";
  setProviderConnectivityState("checking");
  configStatusTitle = "正在连接本地配置";
  updateWorkbookStatusTitle();
  try {
    const payload = await requestJson("/api/config");
    applyConfigState(payload);
    return payload;
  } catch (error) {
    elements.statusDot.className = "status-dot is-error";
    setProviderConnectivityState("error", typeof error?.code === "string" ? error.code : "");
    configStatusTitle = error instanceof Error ? error.message : "配置不可用";
    updateWorkbookStatusTitle();
    throw error;
  }
}

async function refreshProviderConnectivity() {
  const probeId = ++providerProbeId;
  setProviderConnectivityState("checking");
  try {
    const payload = await api.probeProviderConnectivity();
    if (probeId !== providerProbeId) return payload;
    const connectivity = payload?.connectivity;
    setProviderConnectivityState(
      connectivity?.status === "connected" ? "ready" : "error",
      connectivity?.code,
    );
    return payload;
  } catch (error) {
    if (probeId === providerProbeId) {
      setProviderConnectivityState("error", error?.code);
    }
    return null;
  }
}

function setApprovalMode(mode) {
  approvalMode = mode === "auto" ? "auto" : "required";
  const isAuto = approvalMode === "auto";
  elements.modeButton.className = `mode-button ${isAuto ? "is-auto" : "is-required"}`;
  elements.modeIcon.src = isAuto ? "/assets/fluent/auto.svg" : "/assets/fluent/approval.svg";
  elements.modeLabel.textContent = isAuto ? "免审批" : "需审批";
  elements.modeButton.title = isAuto ? "无需审批：告知后直接执行" : "需要审批：每次修改由你决定";
  elements.modeButton.setAttribute("aria-label", elements.modeButton.title);
  elements.modeButton.dataset.mode = approvalMode;
  for (const option of elements.modeMenu.querySelectorAll("[data-mode]")) {
    option.classList.toggle("is-selected", option.dataset.mode === approvalMode);
  }
}

async function persistApprovalMode(mode) {
  const nextMode = mode === "auto" ? "auto" : "required";
  if (nextMode === approvalMode) {
    closeMenus();
    return;
  }
  const previousMode = approvalMode;
  setApprovalMode(nextMode);
  closeMenus();
  approvalModeSaving = true;
  elements.modeButton.disabled = true;
  updateSendState();
  try {
    const payload = await api.saveApprovalMode(nextMode);
    applyConfigState(payload);
  } catch (error) {
    setApprovalMode(previousMode);
    elements.runStatus.textContent = error instanceof Error ? `审批设置未保存：${error.message}` : "审批设置未保存。";
  } finally {
    approvalModeSaving = false;
    elements.modeButton.disabled = uiBusy || !configState;
    updateSendState();
  }
}

function showAttachmentError(message) {
  const visible = typeof message === "string" && message.trim() !== "";
  elements.attachmentError.textContent = visible ? message : "";
  elements.attachmentError.hidden = !visible;
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  for (const attachment of attachments) {
    const item = document.createElement("div");
    item.className = "attachment-item";
    item.title = `${attachment.name} · ${formatAttachmentSize(attachment.byteLength)}`;
    const preview = createImagePreviewButton(attachment, "attachment-preview");
    preview.title = `${item.title}，点击放大查看`;
    preview.setAttribute("aria-label", preview.title);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.title = `删除 ${attachment.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.append(createIcon("/assets/fluent/dismiss.svg"));
    remove.addEventListener("click", () => {
      attachments = attachments.filter((candidate) => candidate.id !== attachment.id);
      renderAttachments();
      updateSendState();
    });
    item.append(preview, remove);
    elements.attachmentList.append(item);
  }
  elements.attachmentList.hidden = attachments.length === 0;
  elements.attachmentList.inert = uiBusy;
}

async function addSelectedImages(fileList) {
  const files = Array.from(fileList ?? []);
  if (files.length === 0) return;
  showAttachmentError("");
  if (attachments.length + files.length > MAX_ATTACHMENTS) {
    showAttachmentError(`每条消息最多添加 ${MAX_ATTACHMENTS} 张图片。`);
    return;
  }

  try {
    const prepared = [];
    for (const file of files) prepared.push(await prepareImageFile(file));
    attachments = [...attachments, ...prepared];
    renderAttachments();
    updateSendState();
  } catch (error) {
    showAttachmentError(
      error instanceof AttachmentError || error instanceof Error
        ? error.message
        : "无法添加图片。",
    );
  }
}

function clipboardContainsUnsupportedImage(clipboardData) {
  const itemTypes = [
    ...Array.from(clipboardData?.files ?? []).map((file) => file?.type),
    ...Array.from(clipboardData?.items ?? []).map((item) => item?.type),
  ];
  return itemTypes.some((type) => /^image\//i.test(String(type ?? "")) && !/^image\/(?:png|jpeg|webp)$/i.test(String(type)));
}

function insertClipboardText(text) {
  if (typeof text !== "string" || text === "") return;
  const input = elements.promptInput;
  const value = input.value;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  const nextValue = `${value.slice(0, start)}${text}${value.slice(end)}`;
  if (nextValue.length > Number(input.maxLength)) {
    input.value = nextValue.slice(0, Number(input.maxLength));
  } else {
    input.value = nextValue;
  }
  const nextCursor = Math.min(start + text.length, input.value.length);
  input.setSelectionRange?.(nextCursor, nextCursor);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function updateSendState() {
  const hasContent = elements.promptInput.value.trim() !== "" || attachments.length > 0;
  const busy = uiBusy;
  elements.sendButton.disabled = busy ? false : approvalModeSaving || !configState || !hasContent;
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
  if (busy) closeMenus();
  elements.promptInput.disabled = busy;
  elements.modelButton.disabled = busy || !configState;
  elements.effortButton.disabled = busy || availableReasoningEfforts().length === 0;
  elements.modeButton.disabled = busy || approvalModeSaving || !configState;
  elements.settingsButton.disabled = busy;
  elements.attachmentList.inert = busy;
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
    const result = legacyMode
      ? await requestLegacy({ action: "execute", name, arguments: args })
      : await executeExcelTool(name, args);
    if (legacyMode) {
      const state = await requestLegacy({ action: "state" });
      legacyRevision = state.revision;
      legacyActiveSheetRevision = state.activeSheetRevision;
      setWorkbookIdentity(state.label);
    }
    return result;
  } catch (error) {
    return toToolErrorResult(error);
  } finally {
    suppressWorkbookChangesUntil = Date.now() + 1_200;
  }
}

async function captureLegacyHistoryPreview(details) {
  const fallback = historyPreviewFallback(details);
  const target = historyPreviewTarget(details);
  if (details.output?.ok === false || !target?.address) return fallback;

  try {
    const output = await requestLegacy({
      action: "execute",
      name: "read_range",
      arguments: { worksheet: target.worksheet ?? null, address: target.address },
    });
    return historyPreviewFallback({ ...details, output });
  } catch {
    return fallback;
  }
}

async function captureToolPreview(details) {
  return legacyMode
    ? captureLegacyHistoryPreview(details)
    : captureOfficeHistoryPreview(details);
}

function requestLegacy(body) {
  if (!legacyMode) throw new ApiError("LEGACY_SESSION_INVALID", "原生 XLS 会话不可用。", 400);
  return requestJson(`/api/legacy/${legacySessionId}`, { method: "POST", body });
}

function handleRunnerEvent(event) {
  switch (event.type) {
    case "run_started":
      currentOperationId = history.startOperation({ label: event.message || "分析图片" }).id;
      currentRunOutcome = "success";
      streamingAssistantId = null;
      streamingAssistantStepTextLength = 0;
      ensureActivityGroup(currentOperationId);
      elements.activityEmpty.hidden = true;
      appendMessage("user", event.message || "已发送图片", event.attachments);
      elements.runStatus.textContent = "";
      setBusy(true);
      startRecoveryHeartbeat();
      break;
    case "assistant_delta":
      elements.runStatus.textContent = "";
      appendAssistantDelta(event.text);
      break;
    case "stream_reset":
      resetStreamingAssistant(event.discardTextLength);
      break;
    case "provider_reconnecting": {
      const seconds = Math.max(1, Math.round((event.delayMs ?? 3_000) / 1_000));
      elements.runStatus.textContent = `网络连接已中断，${seconds} 秒后第 ${event.attempt}/${event.maxAttempts} 次重连…`;
      break;
    }
    case "context_updated":
      currentContext = event.context;
      updateContextControl();
      break;
    case "recovery_unavailable":
      recoveryUnavailable = true;
      setRecoveryNotice(
        "本地恢复暂不可用，当前对话仍可继续但闪退后可能无法恢复。",
        { kind: "warning" },
      );
      break;
    case "recovery_available":
      recoveryUnavailable = false;
      if (!runner.running) {
        setRecoveryNotice("本地恢复已恢复，可继续防护闪退。", { clearable: true, kind: "info" });
      }
      break;
    case "tool_pending":
      streamingAssistantStepTextLength = 0;
      updateActivity(
        event,
        "pending",
        event.tool.mode === "modify"
          ? approvalMode === "auto" ? "将执行" : "待审批"
          : "待读取",
      );
      break;
    case "model_step_boundary":
      streamingAssistantStepTextLength = 0;
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
      elements.runStatus.textContent = "";
      finishAssistantMessage(event.message);
      break;
    case "run_error":
      currentRunOutcome = "error";
      streamingAssistantId = null;
      streamingAssistantStepTextLength = 0;
      elements.runStatus.textContent = "";
      renderConversation();
      if (event.recoverableSession) {
        const recoveryDisabled = recoveryUnavailable || recoveryDisabledForBinding;
        setRecoveryNotice(
          recoveryDisabled
            ? "连接中断，当前对话仍在内存，但本地恢复暂不可用；闪退后可能无法恢复。"
            : "连接中断，当前对话已保留。不会自动重发模型请求或 Excel 修改，请确认后手动继续。",
          { clearable: !recoveryDisabled, kind: "warning" },
        );
        startRecoveryHeartbeat();
      } else {
        recoveryUnavailable = false;
        stopRecoveryHeartbeat();
      }
      appendMessage("error", event.error instanceof Error ? event.error.message : "任务失败。" );
      break;
    case "run_stopped":
      currentRunOutcome = "stopped";
      streamingAssistantId = null;
      streamingAssistantStepTextLength = 0;
      elements.runStatus.textContent = "";
      renderConversation();
      stopRecoveryHeartbeat();
      recoveryUnavailable = false;
      setRecoveryNotice("");
      if (clearingRecoverySession || suppressNextStoppedNotice) {
        suppressNextStoppedNotice = false;
      } else {
        appendMessage("error", "任务已停止。" );
      }
      break;
    case "run_finished":
      history.finishOperation(currentRunOutcome);
      currentOperationId = null;
      renderHistoricalState();
      elements.approval.hidden = true;
      setBusy(false);
      if (runner.sessionId) {
        startRecoveryHeartbeat();
        if (currentRunOutcome === "success" && !recoveryUnavailable && !recoveryDisabledForBinding) {
          setRecoveryNotice("当前会话可继续使用。", { clearable: true, kind: "info" });
        } else if (currentRunOutcome === "success" && recoveryDisabledForBinding) {
          setRecoveryNotice(RECOVERY_BINDING_UNAVAILABLE_MESSAGE, { kind: "warning" });
        }
      } else {
        stopRecoveryHeartbeat();
      }
      elements.promptInput.focus();
      break;
  }
}

const runner = new AgentRunner({
  api,
  executeTool: safeExecuteTool,
  captureToolPreview,
  requestApproval,
  onEvent: handleRunnerEvent,
});

async function clearRecoverySession() {
  const sessionId = runner.sessionId;
  if (!sessionId) return;

  const confirmed = await showConfirmation({
    title: "清空恢复会话？",
    message: "这会停止当前任务并清除本机上的短期恢复记录，无法恢复。已写入工作簿的内容不会被回滚。",
    confirmText: "清空会话",
    cancelText: "保留",
  });
  if (!confirmed) return;

  clearingRecoverySession = true;
  stopRecoveryHeartbeat();
  try {
    await api.clearConversation({ sessionId });
    if (runner.running) suppressNextStoppedNotice = true;
    runner.discardSession(sessionId);
    sessionWorkbookBinding = null;
    recoveryUnavailable = false;
    setRecoveryNotice("");
    resetRecoveredPresentation();
    renderHistoricalState();
    setRecoveryNotice("当前恢复会话已清除。", { kind: "info" });
  } catch (error) {
    if (runner.sessionId === sessionId) startRecoveryHeartbeat();
    setRecoveryNotice(
      error instanceof Error
        ? `无法清除当前恢复会话：${error.message}`
        : "无法清除当前恢复会话，请稍后重试。",
      { clearable: true, kind: "warning" },
    );
  } finally {
    clearingRecoverySession = false;
  }
}

async function submitPrompt() {
  const message = elements.promptInput.value.trim();
  if ((message === "" && attachments.length === 0) || runner.running || approvalModeSaving || !configState) return;
  if (!(await guardHistoricalConversation())) return;

  const outgoingAttachments = attachments.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl }));
  elements.promptInput.value = "";
  attachments = [];
  showAttachmentError("");
  renderAttachments();
  resizePromptInput();
  updateSendState();
  try {
    await prepareWorkbookBinding();
    if (runner.sessionId && sessionWorkbookBinding !== workbookBinding) {
      const previousSessionId = runner.sessionId;
      await api.clearConversation({ sessionId: previousSessionId });
      runner.discardSession(previousSessionId);
      sessionWorkbookBinding = null;
      recoveryUnavailable = false;
      stopRecoveryHeartbeat();
      resetRecoveredPresentation();
      renderHistoricalState();
    }
    if (!runner.sessionId) sessionWorkbookBinding = workbookBinding;
    await runner.run(message, {
      attachments: outgoingAttachments,
      model: selectedModel,
      reasoningEffort: selectedReasoningEffort,
      workbookBinding: workbookBinding ?? undefined,
    });
  } catch (error) {
    if (!runner.running) {
      elements.promptInput.value = message;
      attachments = outgoingAttachments;
      renderAttachments();
      resizePromptInput();
      updateSendState();
      if (runner.sessionId) startRecoveryHeartbeat();
      setRecoveryNotice(
        error instanceof Error
          ? `工作簿标识已变化，但旧会话无法安全清除：${error.message}`
          : "工作簿标识已变化，但旧会话无法安全清除，请稍后重试。",
        { clearable: true, kind: "warning" },
      );
    }
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
  renderProtocolModelExamples();
}

function renderProtocolModelExamples() {
  elements.protocolModelList.replaceChildren();
  for (const model of PROTOCOL_MODEL_EXAMPLES[elements.apiProtocol.value] ?? []) {
    const chip = document.createElement("span");
    chip.className = "protocol-model-chip";
    chip.textContent = model;
    elements.protocolModelList.append(chip);
  }
}

function renderSettingsEfforts() {
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
  const usesAutomaticDefault = entry.reasoningMode === "provider-default"
    || entry.reasoningMode === "thinking-toggle"
    || entry.reasoningEfforts.length === 0;
  if (usesAutomaticDefault) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "自动（提供方默认）";
    elements.settingsEffort.append(option);
  } else {
    for (const effort of entry.reasoningEfforts) {
      const option = document.createElement("option");
      option.value = effort;
      option.textContent = `${reasoningEffortDisplayName(effort)}（${effort}）`;
      elements.settingsEffort.append(option);
    }
  }
  elements.settingsEffort.disabled = true;
  elements.settingsEffort.value = entry.defaultReasoningEffort ?? "";
  const contextNote = entry.contextWindow
    ? entry.contextSource === "official"
      ? "上下文长度来自官方模型目录。"
      : "上下文长度来自提供方模型元数据。"
    : "";
  const reasoningNote = entry.reasoningSource === "compatibility"
    ? "模型接口未声明思考等级，默认使用提供方自动模式。"
    : entry.reasoningMode === "thinking-toggle"
      ? "官方仅声明自动思考与关闭开关，设置默认保持自动。"
      : entry.reasoningMode === "provider-default"
        ? "支持思考模式，等级由提供方自动决定。"
        : entry.reasoningSource === "official"
          ? "思考等级来自官方模型目录，不能手动修改。"
          : entry.reasoningSource === "provider"
            ? "思考等级来自提供方模型元数据，不能手动修改。"
            : "当前按模型 ID 保守映射，不能手动修改。";
  elements.mappingNote.textContent = [contextNote, reasoningNote].filter(Boolean).join(" ");
}

function renderSettingsModels(preferredModel = null) {
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
  renderSettingsEfforts();
}

function applySettingsModelContextWindow() {
  const entry = settingsDiscoveredModels.find((model) => model.id === elements.settingsModel.value);
  if (Number.isSafeInteger(entry?.contextWindow)) {
    elements.contextWindow.value = String(entry.contextWindow);
  }
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
    ? configState.settings.models.map(normalizeReasoningModel)
    : [];
  renderSettingsModels(configState.settings.model);
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
      replaceConversationModels(result.models);
      updateComposerControls();
      setSettingsMessage(`已获取 ${result.models.length} 个模型，可在对话框底部切换。`, "success");
    } else {
      settingsDiscoveredModels = result.models.map(normalizeReasoningModel);
      renderSettingsModels(configState.settings.model);
      applySettingsModelContextWindow();
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
            maxSteps: Number(elements.maxSteps.value),
          },
    );
    await runner.resetSession();
    recoveryUnavailable = false;
    stopRecoveryHeartbeat();
    setRecoveryNotice(
      recoveryDisabledForBinding ? RECOVERY_BINDING_UNAVAILABLE_MESSAGE : "",
      recoveryDisabledForBinding ? { kind: "warning" } : {},
    );
    applyConfigState(payload, { preserveSelection: false });
    setSettingsMessage("配置已更新。", "success");
    closeSettings();
    elements.runStatus.textContent = "配置已更新，新消息将使用当前选择";
    void refreshProviderConnectivity();
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
      call: { callId: "preview-read", name: "read_range" },
      tool: { label: "读取指定范围" },
      arguments: { worksheet: "Sheet1", address: "A1:D5" },
      output: {
        ok: true,
        target: "Sheet1!A1:D5",
        worksheet: "Sheet1",
        rowCount: 5,
        columnCount: 4,
        values: [
          ["月份", "销售额", "成本", "利润"],
          ["1月", 120, 80, 40],
          ["2月", 150, 90, 60],
          ["3月", 180, 100, 80],
          ["4月", 210, 120, 90],
        ],
      },
    },
    {
      call: { callId: "preview-table", name: "create_table" },
      tool: { label: "创建 Excel 表格" },
      arguments: { worksheet: "Sheet1", address: "A1:C5" },
      output: { ok: true, target: "Sheet1!A1:C5", table: "AcceptanceTable" },
    },
    {
      call: { callId: "preview-chart", name: "create_chart" },
      tool: { label: "创建图表" },
      arguments: { worksheet: "Sheet1", sourceAddress: "A1:C4" },
      output: { ok: true, target: "Sheet1!A1:C4", chart: "Chart 1" },
    },
  ];
  for (const sample of samples) {
    sample.preview = historyPreviewFallback(sample);
    updateActivity(sample, "success", "完成", summarizeToolOutput(sample.output));
  }
  history.finishOperation("success");
  history.addMessage("notice", "无需审批：即将执行“创建 Excel 表格”（Sheet1!A1:C5）。", {
    timelineIndex: history.latestIndex,
  });
  history.addMessage("notice", "无需审批：即将执行“创建图表”（Sheet1!A1:C4）。", {
    timelineIndex: history.latestIndex,
  });
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
      approvalMode: "required",
      models: [],
    },
  };
}

async function initializePreview() {
  setWorkbookIdentity("销售分析-Sheet1");
  try {
    await refreshConfig();
    await refreshProviderConnectivity();
  } catch {
    applyConfigState(previewConfigState(), { preserveSelection: false });
    setProviderConnectivityState("ready");
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
  const [configResult, workbookResult] = await Promise.allSettled([
    refreshConfig(),
    refreshWorkbookIdentity(),
    registerWorkbookEvents(),
  ]);
  if (configResult.status === "fulfilled") await refreshProviderConnectivity();
  if (workbookResult.status === "fulfilled") {
    await prepareWorkbookBinding();
    await restoreConversationRecovery();
  }
  setBusy(false);
  elements.promptInput.focus();
}

async function initializeLegacy() {
  try {
    await Promise.all([refreshConfig(), refreshWorkbookIdentity()]);
    await refreshProviderConnectivity();
    await registerWorkbookEvents();
    await prepareWorkbookBinding();
    await restoreConversationRecovery();
    configStatusTitle = `${configStatusTitle} · XLS 原生引擎`;
    updateWorkbookStatusTitle();
    setBusy(false);
    elements.promptInput.focus();
  } catch (error) {
    elements.statusDot.className = "status-dot is-error";
    setWorkbookIdentity("无法连接 XLS 原生引擎");
    elements.promptInput.disabled = true;
    elements.runStatus.textContent = error instanceof Error ? error.message : "原生 XLS 初始化失败。";
  }
}

elements.promptInput.addEventListener("input", () => {
  resizePromptInput();
  updateSendState();
});
elements.promptInput.addEventListener("paste", (event) => {
  const clipboardData = event.clipboardData;
  const files = clipboardImageFiles(clipboardData);
  const hasUnsupportedImage = clipboardContainsUnsupportedImage(clipboardData);
  if (files.length === 0) {
    if (hasUnsupportedImage) showAttachmentError("只支持 PNG、JPEG 或 WebP 图片。");
    return;
  }

  event.preventDefault();
  insertClipboardText(clipboardData?.getData?.("text/plain") ?? "");
  if (hasUnsupportedImage) {
    showAttachmentError("部分图片格式不受支持，仅保留 PNG、JPEG 或 WebP 图片。");
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
elements.easterTrigger.addEventListener("click", () => {
  const active = elements.easterFooter.classList.toggle("is-active");
  elements.easterTrigger.setAttribute("aria-pressed", String(active));
  elements.easterTrigger.title = active ? "收起 ChatEx 彩蛋" : "打开 ChatEx 彩蛋";
});
elements.modelButton.addEventListener("click", toggleModelSettingsMenu);
elements.modelSettingsModelRow.addEventListener("click", () => openModelSettingsSubmenu("model"));
elements.effortButton.addEventListener("click", () => openModelSettingsSubmenu("effort"));
elements.modelMenuBack.addEventListener("click", openModelSettingsMenu);
elements.effortMenuBack.addEventListener("click", openModelSettingsMenu);
elements.resetModelSettings.addEventListener("click", resetModelSettings);
elements.modeButton.addEventListener("click", () => toggleMenu(elements.modeMenu, elements.modeButton));
elements.modeMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-mode]");
  if (!option) return;
  void persistApprovalMode(option.dataset.mode);
});
elements.activityToggle.addEventListener("click", () => {
  const collapsed = elements.activity.classList.toggle("is-collapsed");
  elements.activityToggle.setAttribute("aria-expanded", String(!collapsed));
});
elements.historyLatestButton.addEventListener("click", goToLatestHistory);
elements.clearRecoveryButton.addEventListener("click", () => void clearRecoverySession());
elements.settingsButton.addEventListener("click", openSettings);
elements.apiProtocol.addEventListener("change", renderProtocolModelExamples);
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
elements.settingsModel.addEventListener("change", () => {
  renderSettingsEfforts();
  applySettingsModelContextWindow();
});
elements.settingsForm.addEventListener("submit", saveSettings);
elements.confirmCancelButton.addEventListener("click", () => resolveConfirmation(false));
elements.confirmAcceptButton.addEventListener("click", () => resolveConfirmation(true));
elements.imagePreviewClose.addEventListener("click", closeImagePreview);
elements.imagePreviewModal.addEventListener("click", (event) => {
  if (event.target === elements.imagePreviewModal) closeImagePreview();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-anchor")) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!elements.imagePreviewModal.hidden) {
      event.preventDefault();
      closeImagePreview();
    } else if (pendingConfirmation) resolveConfirmation(false);
    else closeMenus();
  }
});
globalThis.addEventListener?.("pagehide", stopRecoveryHeartbeat);

setApprovalMode("required");
resizePromptInput();
renderAttachments();
renderConversation();
updateSendState();

if (legacyMode) {
  void initializeLegacy();
} else if (previewMode) {
  void initializePreview();
} else if (globalThis.Office?.onReady) {
  Office.onReady((info) => void initializeExcel(info));
} else {
  elements.statusDot.className = "status-dot is-error";
  setWorkbookIdentity("Office.js 未加载");
  elements.promptInput.disabled = true;
}
