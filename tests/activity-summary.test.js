import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolOutput } from "../src/taskpane/activity-summary.js";

test("工作簿读取摘要包含活动工作表、选区和数量", () => {
  assert.equal(
    summarizeToolOutput({
      ok: true,
      workbook: {
        activeWorksheet: "Sheet1",
        selection: { address: "Sheet1!A1:C5" },
        worksheets: ["Sheet1", "验收数据"],
      },
    }),
    "活动工作表 Sheet1 · 选区 Sheet1!A1:C5 · 2 张工作表",
  );
});

test("原生对象摘要包含实际目标和对象名", () => {
  assert.equal(
    summarizeToolOutput({
      ok: true,
      target: "Sheet1!A1:C5",
      worksheet: "Sheet1",
      table: "验收表",
    }),
    "Sheet1!A1:C5 · 表格 验收表",
  );
});

test("失败摘要保留安全错误消息", () => {
  assert.equal(
    summarizeToolOutput({
      ok: false,
      error: { code: "USER_DENIED", message: "用户拒绝执行此修改操作。" },
    }),
    "失败：用户拒绝执行此修改操作。",
  );
});
