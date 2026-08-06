import assert from "node:assert/strict";
import test from "node:test";
import { HistoryState } from "../src/taskpane/history-state.js";

test("选择历史操作时只返回当时已有的对话", () => {
  const history = new HistoryState();
  history.addMessage("user", "开始", { timelineIndex: -1 });
  history.addActivity({ callId: "call-1", label: "读取" });
  history.addMessage("assistant", "第一步", { timelineIndex: 0 });
  history.addActivity({ callId: "call-2", label: "写入" });
  history.addMessage("assistant", "第二步", { timelineIndex: 1 });

  history.select(0);

  assert.equal(history.isHistorical, true);
  assert.deepEqual(history.visibleMessages().map((message) => message.text), ["开始", "第一步"]);
  history.goLatest();
  assert.equal(history.isHistorical, false);
  assert.equal(history.visibleMessages().length, 3);
});

test("选择最新操作不会进入历史锁", () => {
  const history = new HistoryState();
  history.addActivity({ callId: "call-1" });

  history.select(0);

  assert.equal(history.isHistorical, false);
  assert.equal(history.cursor, null);
});

test("一次任务把多个步骤归入同一个操作组", () => {
  const history = new HistoryState();
  const operation = history.startOperation({ label: "整理数据" });
  const first = history.addActivity({ callId: "call-1", label: "读取" });
  const second = history.addActivity({ callId: "call-2", label: "写入" });
  history.finishOperation("success");

  assert.equal(history.operations.length, 1);
  assert.deepEqual(operation.stepIndexes, [first.index, second.index]);
  assert.equal(history.getOperation(first.operationId).status, "success");
  assert.equal(second.operationId, first.operationId);
});

test("动作完成后把流式助手终态消息移到对话底部", () => {
  const history = new HistoryState();
  history.addMessage("user", "补全毛利率公式", { timelineIndex: -1 });
  const draft = history.addMessage("assistant", "正在处理", { timelineIndex: -1 });
  history.addActivity({ callId: "call-1", label: "写入公式" });
  history.addMessage("notice", "无需审批：即将执行“写入公式”。");
  history.addActivity({ callId: "call-2", label: "设置数字格式" });
  history.addMessage("notice", "无需审批：即将执行“设置数字格式”。");

  history.finalizeMessage(draft.id, "已完成毛利率公式补全。");

  assert.deepEqual(history.visibleMessages().map((message) => message.text), [
    "补全毛利率公式",
    "无需审批：即将执行“写入公式”。",
    "无需审批：即将执行“设置数字格式”。",
    "已完成毛利率公式补全。",
  ]);
  assert.equal(history.messages.at(-1)?.id, draft.id);

  history.select(0);
  assert.deepEqual(history.visibleMessages().map((message) => message.text), [
    "补全毛利率公式",
    "无需审批：即将执行“写入公式”。",
  ]);
});

test("多步骤终态只替换当前模型步骤的流式后缀", () => {
  const history = new HistoryState();
  history.addMessage("user", "用户任务", { timelineIndex: -1 });
  const draft = history.addMessage("assistant", "已读取 A1。正在汇总", { timelineIndex: -1 });
  history.addActivity({ callId: "call-1", label: "读取" });
  history.addMessage("notice", "工具通知");

  history.finalizeMessage(draft.id, "已完成汇总。", {
    preservePrefixLength: "已读取 A1。".length,
  });

  assert.equal(history.messages.at(-1)?.id, draft.id);
  assert.equal(history.messages.at(-1)?.text, "已读取 A1。已完成汇总。");
  assert.deepEqual(history.visibleMessages().map((message) => message.text), [
    "用户任务",
    "工具通知",
    "已读取 A1。已完成汇总。",
  ]);
});

test("流式重连只撤销当前尝试新增的文字后缀", () => {
  const history = new HistoryState();
  const draft = history.addMessage("assistant", "已读取数据，正在生成汇总", { timelineIndex: -1 });

  const retained = history.trimMessageSuffix(draft.id, "正在生成汇总".length);

  assert.equal(retained?.text, "已读取数据，");
  assert.equal(history.messages.length, 1);

  history.trimMessageSuffix(draft.id, "已读取数据，".length);
  assert.equal(history.messages.length, 0);
});

test("恢复展示消息会清除本地瞬时操作状态", () => {
  const history = new HistoryState();
  history.startOperation({ label: "旧任务" });
  history.addActivity({ callId: "old-call", label: "旧步骤" });
  history.addMessage("assistant", "旧消息");
  history.select(0);

  const restored = history.restorePresentation([
    { role: "user", text: "继续整理当前工作簿" },
    { role: "assistant", text: "已恢复可见对话。" },
    { role: "notice", text: "中断操作不会自动重放。" },
    { role: "system", text: "不应显示" },
    { role: "assistant", text: 42 },
  ]);

  assert.equal(restored, 3);
  assert.equal(history.activities.length, 0);
  assert.equal(history.operations.length, 0);
  assert.equal(history.activeOperationId, null);
  assert.equal(history.cursor, null);
  assert.deepEqual(history.visibleMessages().map(({ role, text, timelineIndex }) => ({ role, text, timelineIndex })), [
    { role: "user", text: "继续整理当前工作簿", timelineIndex: -1 },
    { role: "assistant", text: "已恢复可见对话。", timelineIndex: -1 },
    { role: "notice", text: "中断操作不会自动重放。", timelineIndex: -1 },
  ]);
});

test("图片附件只保留当前页面对话，恢复展示不接收附件", () => {
  const history = new HistoryState();
  const attachment = {
    name: "标注.png",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,YQ==",
  };

  const message = history.addMessage("user", "分析图片", { attachments: [attachment] });
  attachment.name = "已修改.png";

  assert.deepEqual(message.attachments, [{
    name: "标注.png",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,YQ==",
  }]);

  history.restorePresentation([{
    role: "user",
    text: "恢复后的文本任务",
    attachments: [{ dataUrl: "data:image/png;base64,YQ==" }],
  }]);

  assert.deepEqual(history.visibleMessages(), [
    {
      id: history.messages[0].id,
      role: "user",
      text: "恢复后的文本任务",
      attachments: [],
      timelineIndex: -1,
    },
  ]);
});
