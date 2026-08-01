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
