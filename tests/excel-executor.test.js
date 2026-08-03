import assert from "node:assert/strict";
import test from "node:test";
import * as executorModule from "../src/taskpane/excel-executor.js";

function makeRange({
  rows = 2,
  columns = 2,
  initialValues = [[1, 2], [3, 4]],
  initialFormulas = initialValues,
  preserveValuesOnWrite = false,
} = {}) {
  let assignedValues = 0;
  let assignedFormulas = 0;
  let assignedNumberFormats = 0;
  let autofitColumnsCalls = 0;
  let autofitRowsCalls = 0;
  let clearCalls = 0;
  let sortCalls = 0;
  let tableAdds = 0;
  let chartAdds = 0;
  let lastAssignedNumberFormat = null;
  let numberFormat = [["General", "General"], ["General", "General"]];
  let values = initialValues.map((row) => [...row]);
  let formulas = initialFormulas.map((row) => [...row]);
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
      load() {},
      fill: { load() {} },
      font: { load() {} },
      autofitColumns() { autofitColumnsCalls += 1; },
      autofitRows() { autofitRowsCalls += 1; },
    },
    sort: {
      apply(fields, _matchCase, hasHeaders) {
        sortCalls += 1;
        const key = fields?.[0]?.key ?? 0;
        const ascending = fields?.[0]?.ascending !== false;
        const start = hasHeaders ? 1 : 0;
        const body = values.slice(start).map((row, index) => ({
          row,
          formula: formulas[start + index],
        }));
        body.sort((left, right) => {
          const leftValue = left.row[key];
          const rightValue = right.row[key];
          const comparison = leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
          return ascending ? comparison : -comparison;
        });
        values = [...values.slice(0, start), ...body.map((item) => item.row)];
        formulas = [...formulas.slice(0, start), ...body.map((item) => item.formula)];
      },
    },
    clear(applyTo) {
      clearCalls += 1;
      if (applyTo !== "Formats") {
        values = Array.from({ length: rows }, () => Array(columns).fill(""));
        formulas = Array.from({ length: rows }, () => Array(columns).fill(""));
      }
    },
    get values() {
      return values;
    },
    set values(value) {
      assignedValues += 1;
      if (!preserveValuesOnWrite) values = value.map((row) => [...row]);
    },
    get formulas() {
      return formulas;
    },
    set formulas(value) {
      assignedFormulas += 1;
      formulas = value.map((row) => [...row]);
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
    get autofitColumnsCalls() {
      return autofitColumnsCalls;
    },
    get autofitRowsCalls() {
      return autofitRowsCalls;
    },
    get clearCalls() {
      return clearCalls;
    },
    get sortCalls() {
      return sortCalls;
    },
    get tableAdds() {
      return tableAdds;
    },
    get chartAdds() {
      return chartAdds;
    },
    get lastAssignedNumberFormat() {
      return lastAssignedNumberFormat;
    },
    addTable() {
      tableAdds += 1;
      return { name: "Table1", style: "TableStyleMedium2", load() {} };
    },
    addChart(chartType) {
      chartAdds += 1;
      return {
        name: "Chart 1",
        chartType,
        title: {},
        load() {},
        setPosition() {},
      };
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
    tables: { add() { return rangeState.addTable(); } },
    charts: { add(_chartType, _sourceRange, _seriesBy) { return rangeState.addChart(_chartType); } },
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
  assert.equal(result.impact.cellCount, 4);
  assert.equal(result.verification.kind, "values");
  assert.equal(result.verification.matches, true);
});

test("公式写入会读回公式并报告公式错误", async () => {
  const state = makeRange({
    rows: 1,
    columns: 1,
    initialValues: [["#DIV/0!"]],
    initialFormulas: [["=1/0"]],
  });
  state.range.address = "测试!A1";
  installExcelMock(state);

  const result = await executorModule.executeExcelTool("write_formulas", {
    worksheet: null,
    address: "A1",
    formulas: [["=1/0"]],
  });

  assert.equal(state.assignedFormulas, 1);
  assert.equal(result.verification.kind, "formulas");
  assert.equal(result.verification.matches, true);
  assert.equal(result.verification.formulaErrorCells, 1);
});

test("写后读回不匹配时不会报告写入成功", async () => {
  const state = makeRange({
    rows: 1,
    columns: 1,
    initialValues: [[0]],
    preserveValuesOnWrite: true,
  });
  state.range.address = "测试!A1";
  installExcelMock(state);

  await assert.rejects(
    () => executorModule.executeExcelTool("write_values", {
      worksheet: null,
      address: "A1",
      values: [[1]],
    }),
    (error) => error.code === "WRITE_VERIFICATION_FAILED",
  );
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
  assert.equal(result.impact.cellCount, 6);
  assert.equal(result.verification.kind, "numberFormat");
  assert.equal(result.verification.matches, true);
  assert.deepEqual(state.lastAssignedNumberFormat, [
    ["#,##0.00", "#,##0.00", "#,##0.00"],
    ["#,##0.00", "#,##0.00", "#,##0.00"],
  ]);
});

test("范围格式、清除和排序返回读回验证摘要", async () => {
  const formatState = makeRange();
  installExcelMock(formatState);
  const formatResult = await executorModule.executeExcelTool("format_range", {
    worksheet: null,
    address: "A1:B2",
    fillColor: "#112233",
    fontColor: "#FFFFFF",
    bold: true,
    italic: false,
    fontSize: 12,
    horizontalAlignment: "Center",
    verticalAlignment: "Bottom",
    wrapText: true,
  });
  assert.equal(formatResult.verification.kind, "format");
  assert.equal(formatResult.verification.matches, true);
  assert.equal(formatResult.verification.properties.fillColor, "#112233");

  const clearState = makeRange();
  installExcelMock(clearState);
  const clearResult = await executorModule.executeExcelTool("clear_range", {
    worksheet: null,
    address: "A1:B2",
    applyTo: "Contents",
  });
  assert.equal(clearState.clearCalls, 1);
  assert.equal(clearResult.verification.kind, "clear");
  assert.equal(clearResult.verification.contentsCleared, true);

  const sortState = makeRange({ initialValues: [[3, "b"], [1, "a"]] });
  installExcelMock(sortState);
  const sortResult = await executorModule.executeExcelTool("sort_range", {
    worksheet: null,
    address: "A1:B2",
    keyColumn: 1,
    direction: "Ascending",
    hasHeaders: false,
  });
  assert.equal(sortState.sortCalls, 1);
  assert.deepEqual(sortResult.verification.keyValues, [1, 3]);
  assert.equal(sortResult.verification.readBack, true);
});

test("安全自动调整按受影响列数预检，整列 N:R 保持兼容", async () => {
  const state = makeRange({ rows: 1_048_576, columns: 5 });
  state.range.address = "测试!N:R";
  installExcelMock(state);

  const result = await executorModule.executeExcelTool("autofit_range", {
    worksheet: null,
    address: "N:R",
    columns: true,
    rows: false,
  });

  assert.equal(state.autofitColumnsCalls, 1);
  assert.equal(state.autofitRowsCalls, 0);
  assert.equal(result.impact.affectedColumns, 5);
  assert.equal(result.impact.affectedRows, 0);
  assert.equal(result.verification.kind, "autofit");
});

test("过宽行范围自动调整列宽会在执行前被拒绝", async () => {
  const state = makeRange({ rows: 1, columns: 16_384 });
  state.range.address = "测试!1:1";
  installExcelMock(state);

  await assert.rejects(
    () => executorModule.executeExcelTool("autofit_range", {
      worksheet: null,
      address: "1:1",
      columns: true,
      rows: false,
    }),
    (error) => error.code === "AUTOFIT_TARGET_TOO_LARGE",
  );
  assert.equal(state.autofitColumnsCalls, 0);
  assert.deepEqual(state.loaded, ["address,rowCount,columnCount"]);
});

test("安全建表和建图返回对象确认，超限范围不会触发任一修改", async () => {
  const safeTableState = makeRange();
  installExcelMock(safeTableState);
  const tableResult = await executorModule.executeExcelTool("create_table", {
    worksheet: null,
    address: "A1:B2",
    hasHeaders: true,
    name: "SalesTable",
    style: "TableStyleMedium2",
  });
  assert.equal(safeTableState.tableAdds, 1);
  assert.equal(tableResult.verification.kind, "table");
  assert.equal(tableResult.verification.exists, true);

  const safeChartState = makeRange();
  installExcelMock(safeChartState);
  const chartResult = await executorModule.executeExcelTool("create_chart", {
    worksheet: null,
    sourceAddress: "A1:B2",
    chartType: "ColumnClustered",
    seriesBy: "Columns",
    title: "销售额",
    positionAddress: "D1:F10",
  });
  assert.equal(safeChartState.chartAdds, 1);
  assert.equal(chartResult.verification.kind, "chart");
  assert.equal(chartResult.verification.exists, true);

  const oversizedArgs = [
    ["format_range", {
      worksheet: null,
      address: "A1:A5001",
      fillColor: "#112233",
      fontColor: null,
      bold: null,
      italic: null,
      fontSize: null,
      horizontalAlignment: null,
      verticalAlignment: null,
      wrapText: null,
    }],
    ["clear_range", { worksheet: null, address: "A1:A5001", applyTo: "All" }],
    ["sort_range", {
      worksheet: null,
      address: "A1:A5001",
      keyColumn: 1,
      direction: "Ascending",
      hasHeaders: false,
    }],
    ["create_table", {
      worksheet: null,
      address: "A1:A5001",
      hasHeaders: false,
      name: null,
      style: null,
    }],
    ["create_chart", {
      worksheet: null,
      sourceAddress: "A1:A5001",
      chartType: "Line",
      seriesBy: "Auto",
      title: null,
      positionAddress: null,
    }],
  ];

  for (const [name, args] of oversizedArgs) {
    const state = makeRange({ rows: 5_001, columns: 1 });
    state.range.address = "测试!A1:A5001";
    installExcelMock(state);
    await assert.rejects(
      () => executorModule.executeExcelTool(name, args),
      (error) => error.code === "MODIFY_RANGE_TOO_LARGE",
    );
    assert.equal(state.clearCalls, 0);
    assert.equal(state.sortCalls, 0);
    assert.equal(state.tableAdds, 0);
    assert.equal(state.chartAdds, 0);
    assert.equal(state.range.format.fill.color, undefined);
  }
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
