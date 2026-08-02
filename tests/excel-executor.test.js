import assert from "node:assert/strict";
import test from "node:test";
import * as executorModule from "../src/taskpane/excel-executor.js";

function makeRange({ rows = 2, columns = 2 } = {}) {
  let assignedValues = 0;
  let assignedFormulas = 0;
  let assignedNumberFormats = 0;
  let lastAssignedNumberFormat = null;
  let numberFormat = [["General", "General"], ["General", "General"]];
  const loaded = [];
  const range = {
    address: "测试!A1:B2",
    rowCount: rows,
    columnCount: columns,
    worksheet: null,
    load(properties) {
      loaded.push(properties);
    },
    format: {
      fill: {},
      font: {},
      autofitColumns() {},
      autofitRows() {},
    },
    sort: { apply() {} },
    clear() {},
    get values() {
      return [[1, 2], [3, 4]];
    },
    set values(_value) {
      assignedValues += 1;
    },
    get formulas() {
      return [[1, 2], [3, 4]];
    },
    set formulas(_value) {
      assignedFormulas += 1;
    },
    get numberFormat() {
      return numberFormat;
    },
    set numberFormat(value) {
      assignedNumberFormats += 1;
      lastAssignedNumberFormat = value;
      numberFormat = value;
    },
  };
  return {
    range,
    loaded,
    get assignedValues() {
      return assignedValues;
    },
    get assignedFormulas() {
      return assignedFormulas;
    },
    get assignedNumberFormats() {
      return assignedNumberFormats;
    },
    get lastAssignedNumberFormat() {
      return lastAssignedNumberFormat;
    },
  };
}

function installExcelMock(rangeState) {
  const worksheet = {
    name: "测试",
    load() {},
    getRange() {
      return rangeState.range;
    },
  };
  rangeState.range.worksheet = worksheet;
  const context = {
    workbook: {
      worksheets: {
        getActiveWorksheet() {
          return worksheet;
        },
      },
      getSelectedRange() {
        return rangeState.range;
      },
    },
    async sync() {},
  };
  globalThis.Excel = {
    async run(callback) {
      return callback(context);
    },
  };
}

test("尺寸不匹配时不触发 Excel 值赋值", async () => {
  const state = makeRange({ rows: 2, columns: 2 });
  installExcelMock(state);

  await assert.rejects(
    () =>
      executorModule.executeExcelTool("write_values", {
        worksheet: null,
        address: "A1:B2",
        values: [[1, 2]],
      }),
    (error) => error.code === "MATRIX_SIZE_MISMATCH",
  );
  assert.equal(state.assignedValues, 0);
});

test("尺寸匹配时只执行一次批量赋值", async () => {
  const state = makeRange({ rows: 2, columns: 2 });
  installExcelMock(state);

  const result = await executorModule.executeExcelTool("write_values", {
    worksheet: null,
    address: "A1:B2",
    values: [[1, 2], [3, 4]],
  });

  assert.equal(result.ok, true);
  assert.equal(state.assignedValues, 1);
});

test("安全数字格式范围只赋值一次且矩阵尺寸匹配", async () => {
  const state = makeRange({ rows: 2, columns: 3 });
  state.range.address = "测试!A1:C2";
  installExcelMock(state);

  const result = await executorModule.executeExcelTool("set_number_format", {
    worksheet: null,
    address: "A1:C2",
    formatCode: "#,##0.00",
  });

  assert.equal(result.ok, true);
  assert.equal(state.assignedNumberFormats, 1);
  assert.deepEqual(state.lastAssignedNumberFormat, [
    ["#,##0.00", "#,##0.00", "#,##0.00"],
    ["#,##0.00", "#,##0.00", "#,##0.00"],
  ]);
});

async function assertOversizedNumberFormatIsRejectedBeforeMatrixCreation({
  rows,
  columns,
  address,
}) {
  const state = makeRange({ rows, columns });
  state.range.address = `测试!${address}`;
  installExcelMock(state);

  const originalArrayFrom = Array.from;
  let attemptedLargeMatrixCreation = false;
  Array.from = function guardedArrayFrom(source, ...args) {
    if (source?.length > 5_000) {
      attemptedLargeMatrixCreation = true;
      throw new Error("不应在超限范围构造数字格式矩阵。");
    }
    return originalArrayFrom.call(this, source, ...args);
  };

  try {
    await assert.rejects(
      () =>
        executorModule.executeExcelTool("set_number_format", {
          worksheet: null,
          address,
          formatCode: "0.00",
        }),
      (error) => error.code === "NUMBER_FORMAT_RANGE_TOO_LARGE",
    );
  } finally {
    Array.from = originalArrayFrom;
  }

  assert.equal(attemptedLargeMatrixCreation, false);
  assert.equal(state.assignedNumberFormats, 0);
  assert.deepEqual(state.loaded, ["address,rowCount,columnCount"]);
}

test("超大整列或整行数字格式在创建矩阵前被拒绝", async () => {
  await assertOversizedNumberFormatIsRejectedBeforeMatrixCreation({
    rows: 1_048_576,
    columns: 1,
    address: "A:A",
  });
  await assertOversizedNumberFormatIsRejectedBeforeMatrixCreation({
    rows: 1,
    columns: 16_384,
    address: "1:1",
  });
});

test("超限选区只读取尺寸元数据，不加载单元格内容", async () => {
  const state = makeRange({ rows: 2_001, columns: 1 });
  state.range.address = "测试!A1:A2001";
  installExcelMock(state);

  await assert.rejects(
    () => executorModule.executeExcelTool("get_selection", {}),
    (error) => error.code === "READ_RANGE_TOO_LARGE",
  );
  assert.deepEqual(state.loaded, ["address,rowCount,columnCount"]);
});

test("图表选中时工作簿信息回退到活动单元格", async () => {
  let runCount = 0;
  const worksheet = { name: "Sheet1", load() {} };
  const selection = {
    address: "Sheet1!A1",
    rowCount: 1,
    columnCount: 1,
    load() {},
  };
  globalThis.Excel = {
    async run(callback) {
      runCount += 1;
      const currentRun = runCount;
      const context = {
        workbook: {
          worksheets: {
            items: [worksheet],
            load() {},
            getActiveWorksheet() {
              return worksheet;
            },
          },
          getSelectedRange() {
            return selection;
          },
          getActiveCell() {
            return selection;
          },
        },
        async sync() {
          if (currentRun === 1) {
            const error = new Error("当前所选内容对于此操作无效。");
            error.code = "InvalidSelection";
            throw error;
          }
        },
      };
      return callback(context);
    },
  };

  const result = await executorModule.executeExcelTool("get_workbook_info", {});

  assert.equal(runCount, 2);
  assert.equal(result.ok, true);
  assert.equal(result.workbook.selection.address, "Sheet1!A1");
  assert.equal(result.workbook.selection.mode, "activeCell");
});
