export class HistoryState {
  constructor() {
    this.activities = [];
    this.operations = [];
    this.messages = [];
    this.cursor = null;
    this.activeOperationId = null;
  }

  get latestIndex() {
    return this.activities.length - 1;
  }

  get selectedIndex() {
    return this.cursor === null ? this.latestIndex : this.cursor;
  }

  get isHistorical() {
    return this.cursor !== null && this.cursor < this.latestIndex;
  }

  startOperation({ label = "本次操作" } = {}) {
    const operation = {
      id: globalThis.crypto?.randomUUID?.() ?? `operation_${this.operations.length + 1}`,
      label: String(label || "本次操作"),
      status: "running",
      stepIndexes: [],
    };
    this.operations.push(operation);
    this.activeOperationId = operation.id;
    return operation;
  }

  getOperation(operationId) {
    return this.operations.find((operation) => operation.id === operationId) ?? null;
  }

  updateOperation(operationId, patch) {
    const operation = this.getOperation(operationId);
    if (!operation) return null;
    Object.assign(operation, patch);
    return operation;
  }

  finishOperation(status = "success") {
    if (!this.activeOperationId) return null;
    const operation = this.updateOperation(this.activeOperationId, { status });
    this.activeOperationId = null;
    return operation;
  }

  clear() {
    this.activities = [];
    this.operations = [];
    this.messages = [];
    this.cursor = null;
    this.activeOperationId = null;
  }

  restorePresentation(messages) {
    if (!Array.isArray(messages)) {
      throw new TypeError("恢复展示消息必须是数组。" );
    }

    this.clear();
    const roles = new Set(["user", "assistant", "notice", "error"]);
    for (const entry of messages) {
      if (!entry || !roles.has(entry.role) || typeof entry.text !== "string") continue;
      this.addMessage(entry.role, entry.text, { timelineIndex: -1 });
    }
    return this.messages.length;
  }

  addActivity(activity) {
    const index = this.activities.length;
    let operationId = activity.operationId ?? this.activeOperationId;
    if (!operationId) operationId = this.startOperation().id;
    const operation = this.getOperation(operationId);
    const entry = { ...activity, operationId, index };
    this.activities.push(entry);
    operation?.stepIndexes.push(index);
    return entry;
  }

  updateMessage(messageId, patch) {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) return null;
    Object.assign(message, patch);
    return message;
  }

  removeMessage(messageId) {
    const messageIndex = this.messages.findIndex((entry) => entry.id === messageId);
    if (messageIndex === -1) return null;
    return this.messages.splice(messageIndex, 1)[0];
  }

  trimMessageSuffix(messageId, length) {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message || !Number.isSafeInteger(length) || length <= 0) return message ?? null;
    message.text = message.text.slice(0, Math.max(0, message.text.length - length));
    return message.text === "" ? this.removeMessage(messageId) : message;
  }

  finalizeMessage(messageId, text, { preservePrefixLength = 0 } = {}) {
    const messageIndex = this.messages.findIndex((entry) => entry.id === messageId);
    if (messageIndex === -1) return null;

    const message = this.messages[messageIndex];
    const currentText = typeof message.text === "string" ? message.text : "";
    const prefixLength = Number.isSafeInteger(preservePrefixLength)
      ? Math.max(0, Math.min(preservePrefixLength, currentText.length))
      : 0;
    const prefix = currentText.slice(0, prefixLength);
    const currentStepText = typeof text === "string" && text !== ""
      ? text
      : currentText.slice(prefixLength);
    const finalText = `${prefix}${currentStepText}` || "模型未返回文本。";
    if (message.timelineIndex === this.latestIndex) {
      message.text = finalText;
      return message;
    }

    this.messages.splice(messageIndex, 1);
    message.text = finalText;
    message.timelineIndex = this.latestIndex;
    this.messages.push(message);
    return message;
  }

  updateActivity(callId, patch) {
    const entry = this.activities.find((activity) => activity.callId === callId);
    if (!entry) return null;
    Object.assign(entry, patch);
    return entry;
  }

  addMessage(role, text, { timelineIndex = this.latestIndex } = {}) {
    const message = {
      id: globalThis.crypto?.randomUUID?.() ?? `message_${this.messages.length + 1}`,
      role,
      text,
      timelineIndex,
    };
    this.messages.push(message);
    return message;
  }

  select(index) {
    if (!Number.isInteger(index) || index < 0 || index > this.latestIndex) {
      throw new RangeError("历史操作索引无效。" );
    }
    this.cursor = index === this.latestIndex ? null : index;
    return this.selectedIndex;
  }

  goLatest() {
    this.cursor = null;
  }

  visibleMessages() {
    const limit = this.selectedIndex;
    return this.messages.filter((message) => message.timelineIndex <= limit);
  }
}
