import assert from "node:assert/strict";
import test from "node:test";
import {
  captureOfficeHistoryPreview,
  historyPreviewFallback,
  historyPreviewTarget,
} from "../src/taskpane/history-preview.js";

test("范围写入的回退预览保留目标地址和单元格内容", () => {
  const preview = historyPreviewFallback({
    call: { name: "write_values" },
    tool: { label: "写入值" },
    arguments: {
      worksheet: "销售",
      address: "B2:C3",
      values: [["一月", 12], ["二月", 18]],
    },
    output: { ok: true, target: "销售!B2:C3", worksheet: "销售" },
  });

  assert.equal(preview.kind, "grid");
  assert.equal(preview.worksheet, "销售");
  assert.equal(preview.address, "B2:C3");
  assert.deepEqual(preview.columns, ["B", "C"]);
  assert.deepEqual(preview.rows, [
    { row: 2, cells: [{ text: "一月", formula: null }, { text: "12", formula: null }] },
    { row: 3, cells: [{ text: "二月", formula: null }, { text: "18", formula: null }] },
  ]);
});

test("拒绝或失败的写入只显示失败摘要，不展示参数中的待写入值", async () => {
  const details = {
    call: { name: "write_values" },
    tool: { label: "写入值" },
    arguments: {
      worksheet: "销售",
      address: "A1:B1",
      values: [[1, 2]],
    },
    output: {
      ok: false,
      error: { code: "USER_DENIED", message: "用户拒绝执行此修改操作。" },
    },
  };

  const fallback = historyPreviewFallback(details);
  const officePreview = await captureOfficeHistoryPreview(details);

  assert.equal(fallback.kind, "summary");
  assert.equal(fallback.message, "用户拒绝执行此修改操作。");
  assert.equal("rows" in fallback, false);
  assert.deepEqual(officePreview, fallback);
});

test("预览目标从实际输出中解析工作表和图表", () => {
  assert.deepEqual(
    historyPreviewTarget({
      call: { name: "read_range" },
      arguments: { worksheet: null, address: "A1:B2" },
      output: { ok: true, target: "报价表!A1:B2", worksheet: "报价表" },
    }),
    { kind: "range", worksheet: "报价表", address: "A1:B2" },
  );
  assert.deepEqual(
    historyPreviewTarget({
      call: { name: "create_chart" },
      arguments: { worksheet: "报价表", sourceAddress: "A1:B4" },
      output: { ok: true, worksheet: "报价表", chart: "Chart 1" },
    }),
    { kind: "chart", worksheet: "报价表", chart: "Chart 1", address: "A1:B4" },
  );
});

test("Office 预览在内存中裁剪范围图像，不写入单元格", async (t) => {
  const originalExcel = globalThis.Excel;
  let crop;
  let assignedValues = 0;
  const croppedRange = {
    address: "销售!B2:M31",
    load() {},
    getImage() {
      return { value: "aGVsbG8=" };
    },
  };
  const range = {
    rowIndex: 1,
    columnIndex: 1,
    rowCount: 80,
    columnCount: 20,
    address: "销售!B2:U81",
    load() {},
    set values(_value) {
      assignedValues += 1;
    },
  };
  const worksheet = {
    name: "销售",
    load() {},
    getRange() {
      return range;
    },
    getRangeByIndexes(row, column, rowCount, columnCount) {
      crop = { row, column, rowCount, columnCount };
      return croppedRange;
    },
  };
  globalThis.Excel = {
    async run(callback) {
      return callback({
        workbook: {
          worksheets: {
            getItem() {
              return worksheet;
            },
            getActiveWorksheet() {
              return worksheet;
            },
          },
        },
        async sync() {},
      });
    },
  };
  t.after(() => {
    globalThis.Excel = originalExcel;
  });

  const preview = await captureOfficeHistoryPreview({
    call: { name: "format_range" },
    tool: { label: "设置范围格式" },
    arguments: { worksheet: "销售", address: "B2:U81" },
    output: { ok: true, worksheet: "销售", target: "销售!B2:U81" },
  });

  assert.deepEqual(crop, { row: 1, column: 1, rowCount: 30, columnCount: 12 });
  assert.equal(preview.kind, "image");
  assert.equal(preview.address, "销售!B2:M31");
  assert.equal(preview.dataUrl, "data:image/png;base64,aGVsbG8=");
  assert.equal(preview.truncated, true);
  assert.equal(assignedValues, 0);
});

test("过大的图像安全回退为范围网格", async (t) => {
  const originalExcel = globalThis.Excel;
  const range = {
    rowIndex: 0,
    columnIndex: 0,
    rowCount: 1,
    columnCount: 1,
    address: "Sheet1!A1",
    load() {},
    getImage() {
      return { value: "a".repeat(384_001) };
    },
  };
  const worksheet = {
    name: "Sheet1",
    load() {},
    getRange() {
      return range;
    },
  };
  globalThis.Excel = {
    async run(callback) {
      return callback({
        workbook: {
          worksheets: {
            getItem() {
              return worksheet;
            },
            getActiveWorksheet() {
              return worksheet;
            },
          },
        },
        async sync() {},
      });
    },
  };
  t.after(() => {
    globalThis.Excel = originalExcel;
  });

  const preview = await captureOfficeHistoryPreview({
    call: { name: "write_values" },
    tool: { label: "写入值" },
    arguments: { worksheet: "Sheet1", address: "A1", values: [["仅预览"]] },
    output: { ok: true, worksheet: "Sheet1", target: "Sheet1!A1" },
  });

  assert.equal(preview.kind, "grid");
  assert.equal(preview.rows[0].cells[0].text, "仅预览");
});
