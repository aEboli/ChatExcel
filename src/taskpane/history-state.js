export class HistoryState {
  constructor() {
    this.activities = [];
    this.messages = [];
    this.cursor = null;
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

  addActivity(activity) {
    const index = this.activities.length;
    const entry = { ...activity, index };
    this.activities.push(entry);
    return entry;
  }

  updateActivity(callId, patch) {
    const entry = this.activities.find((activity) => activity.callId === callId);
    if (!entry) return null;
    Object.assign(entry, patch);
    return entry;
  }

  addMessage(role, text, { attachments = [], timelineIndex = this.latestIndex } = {}) {
    const message = {
      id: globalThis.crypto?.randomUUID?.() ?? `message_${this.messages.length + 1}`,
      role,
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
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
