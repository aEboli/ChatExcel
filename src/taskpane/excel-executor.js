import {
  MAX_AUTOFIT_DIMENSIONS,
  MAX_MUTATION_CELLS,
  MAX_NUMBER_FORMAT_CELLS,
  MAX_READ_CELLS,
  parseAndValidateToolArguments,
  ToolValidationError,
} from "../shared/excel-tools.js";

export class ExcelToolError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ExcelToolError";
    this.code = code;
  }
}

export function assertReadableSize(rowCount, columnCount) {
  const cellCount = rowCount * columnCount;
  if (cellCount > MAX_READ_CELLS) {
    throw new ExcelToolError(
      "READ_RANGE_TOO_LARGE",
      `目标范围包含 ${cellCount} 个单元格，超过 ${MAX_READ_CELLS} 个读取限制。`,
    );
  }
  return cellCount;
}

export function assertNumberFormatSize(rowCount, columnCount) {
  const cellCount = rowCount * columnCount;
  if (cellCount > MAX_NUMBER_FORMAT_CELLS) {
    throw new ExcelToolError(
      "NUMBER_FORMAT_RANGE_TOO_LARGE",
      `目标范围包含 ${cellCount} 个单元格，超过 ${MAX_NUMBER_FORMAT_CELLS} 个数字格式限制；请缩小范围或分块执行。`,
    );
  }
  return cellCount;
}

export function assertMutationSize(rowCount, columnCount) {
  const cellCount = rowCount * columnCount;
  if (cellCount > MAX_MUTATION_CELLS) {
    throw new ExcelToolError(
      "MODIFY_RANGE_TOO_LARGE",
      `目标范围包含 ${cellCount} 个单元格，超过 ${MAX_MUTATION_CELLS} 个修改限制；请缩小范围或分块执行。`,
    );
  }
  return cellCount;
}

export function assertAutofitDimensions(rowCount, columnCount, { columns, rows }) {
  if (columns && columnCount > MAX_AUTOFIT_DIMENSIONS) {
    throw new ExcelToolError(
      "AUTOFIT_TARGET_TOO_LARGE",
      `自动调整将影响 ${columnCount} 列，超过 ${MAX_AUTOFIT_DIMENSIONS} 个列限制；请缩小范围。`,
    );
  }
  if (rows && rowCount > MAX_AUTOFIT_DIMENSIONS) {
    throw new ExcelToolError(
      "AUTOFIT_TARGET_TOO_LARGE",
      `自动调整将影响 ${rowCount} 行，超过 ${MAX_AUTOFIT_DIMENSIONS} 个行限制；请缩小范围。`,
    );
  }
  return {
    columns: columns ? columnCount : 0,
    rows: rows ? rowCount : 0,
  };
}

export function assertMatrixMatchesRange(matrix, rowCount, columnCount) {
  if (matrix.length !== rowCount || matrix.some((row) => row.length !== columnCount)) {
    throw new ExcelToolError(
      "MATRIX_SIZE_MISMATCH",
      `二维数组尺寸与目标范围不一致；目标为 ${rowCount} 行 x ${columnCount} 列。`,
    );
  }
}

function getWorksheet(workbook, worksheetName) {
  return worksheetName === null
    ? workbook.worksheets.getActiveWorksheet()
    : workbook.worksheets.getItem(worksheetName);
}

async function loadRangeMetadata(context, range, worksheet) {
  range.load("address,rowCount,columnCount");
  worksheet.load("name");
  await context.sync();
  return {
    address: range.address,
    worksheet: worksheet.name,
    rowCount: range.rowCount,
    columnCount: range.columnCount,
  };
}

const FORMULA_ERROR_VALUES = new Set([
  "#BLOCKED!",
  "#BUSY!",
  "#CALC!",
  "#CONNECT!",
  "#DIV/0!",
  "#FIELD!",
  "#GETTING_DATA",
  "#N/A",
  "#NAME?",
  "#NULL!",
  "#NUM!",
  "#REF!",
  "#SPILL!",
  "#UNKNOWN!",
  "#VALUE!",
]);

function matrixValueAt(matrix, row, column) {
  return Array.isArray(matrix) && Array.isArray(matrix[row]) ? matrix[row][column] : undefined;
}

function isNonEmptyCell(value) {
  return value !== null && value !== undefined && value !== "";
}

function isFormulaCell(value) {
  return typeof value === "string" && value.startsWith("=");
}

function isFormulaError(value) {
  return typeof value === "string" && FORMULA_ERROR_VALUES.has(value.toUpperCase());
}

function summarizeRangeContents(values, formulas, rowCount, columnCount) {
  let nonEmptyCells = 0;
  let formulaCells = 0;
  let formulaErrorCells = 0;
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const value = matrixValueAt(values, row, column);
      const formula = matrixValueAt(formulas, row, column);
      if (isNonEmptyCell(value)) nonEmptyCells += 1;
      if (isFormulaCell(formula)) formulaCells += 1;
      if (isFormulaError(value)) formulaErrorCells += 1;
    }
  }
  return { nonEmptyCells, formulaCells, formulaErrorCells };
}

function matricesEqual(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
    return false;
  }
  return actual.every((row, rowIndex) =>
    Array.isArray(row) &&
    Array.isArray(expected[rowIndex]) &&
    row.length === expected[rowIndex].length &&
    row.every((value, columnIndex) => Object.is(value, expected[rowIndex][columnIndex])),
  );
}

function matrixIsBlank(matrix, rowCount, columnCount) {
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      if (isNonEmptyCell(matrixValueAt(matrix, row, column))) return false;
    }
  }
  return true;
}

function copyMatrix(matrix) {
  return Array.isArray(matrix)
    ? matrix.map((row) => (Array.isArray(row) ? [...row] : row))
    : matrix;
}

function compareSortValues(left, right) {
  const leftBlank = !isNonEmptyCell(left);
  const rightBlank = !isNonEmptyCell(right);
  if (leftBlank || rightBlank) {
    if (leftBlank && rightBlank) return 0;
    return leftBlank ? -1 : 1;
  }
  if (typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)) {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  }
  return null;
}

function inspectSortOrder(values, keyColumn, hasHeaders, direction) {
  const keyValues = values
    .slice(hasHeaders ? 1 : 0)
    .map((row) => (Array.isArray(row) ? row[keyColumn - 1] : undefined));
  let orderChecked = true;
  let ordered = true;
  for (let index = 1; index < keyValues.length; index += 1) {
    const comparison = compareSortValues(keyValues[index - 1], keyValues[index]);
    if (comparison === null) {
      orderChecked = false;
      break;
    }
    if ((direction === "Ascending" && comparison > 0) || (direction === "Descending" && comparison < 0)) {
      ordered = false;
      break;
    }
  }
  return { keyValues, orderChecked, ordered };
}

async function loadRangeImpact(context, range, metadata) {
  range.load("values,formulas");
  await context.sync();
  return {
    target: metadata.address,
    rowCount: metadata.rowCount,
    columnCount: metadata.columnCount,
    cellCount: metadata.rowCount * metadata.columnCount,
    ...summarizeRangeContents(range.values, range.formulas, metadata.rowCount, metadata.columnCount),
  };
}

async function inspectMutationRange(context, range, worksheet, assertSize = assertMutationSize) {
  const metadata = await loadRangeMetadata(context, range, worksheet);
  assertSize(metadata.rowCount, metadata.columnCount);
  const impact = await loadRangeImpact(context, range, metadata);
  return {
    metadata,
    impact,
    values: copyMatrix(range.values),
    formulas: copyMatrix(range.formulas),
  };
}

async function readBackRange(context, range, metadata) {
  range.load("values,formulas,numberFormat");
  await context.sync();
  return {
    values: range.values,
    formulas: range.formulas,
    numberFormat: range.numberFormat,
    ...summarizeRangeContents(range.values, range.formulas, metadata.rowCount, metadata.columnCount),
  };
}

function assertVerification(matches, code, message) {
  if (!matches) throw new ExcelToolError(code, message);
}

function colorsMatch(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return actual === expected;
  return actual.replace(/^#/, "").toUpperCase() === expected.replace(/^#/, "").toUpperCase();
}

async function verifyRangeFormat(context, range, args) {
  range.format.load("horizontalAlignment,verticalAlignment,wrapText");
  range.format.fill.load("color");
  range.format.font.load("color,bold,italic,size");
  await context.sync();

  const actual = {
    fillColor: range.format.fill.color,
    fontColor: range.format.font.color,
    bold: range.format.font.bold,
    italic: range.format.font.italic,
    fontSize: range.format.font.size,
    horizontalAlignment: range.format.horizontalAlignment,
    verticalAlignment: range.format.verticalAlignment,
    wrapText: range.format.wrapText,
  };
  const matches = Object.entries(actual).every(([key, value]) => {
    const expected = args[key];
    if (expected === null) return true;
    return key.endsWith("Color") ? colorsMatch(value, expected) : Object.is(value, expected);
  });
  assertVerification(matches, "FORMAT_VERIFICATION_FAILED", "Excel 未能确认范围格式已按请求应用。");
  return { kind: "format", matches, properties: actual };
}

function mutationResult(metadata, impact, verification, extra = {}) {
  return {
    ok: true,
    target: metadata.address,
    worksheet: metadata.worksheet,
    rowCount: metadata.rowCount,
    columnCount: metadata.columnCount,
    impact,
    verification,
    ...extra,
  };
}

async function readRange(context, range, worksheet) {
  const metadata = await loadRangeMetadata(context, range, worksheet);
  const cellCount = assertReadableSize(metadata.rowCount, metadata.columnCount);
  range.load("values,formulas,numberFormat");
  await context.sync();
  return {
    ok: true,
    target: metadata.address,
    worksheet: metadata.worksheet,
    rowCount: metadata.rowCount,
    columnCount: metadata.columnCount,
    cellCount,
    values: range.values,
    formulas: range.formulas,
    numberFormat: range.numberFormat,
  };
}

async function loadWorkbookInfo(selectionMode) {
  return Excel.run(async (context) => {
    const worksheets = context.workbook.worksheets;
    const activeWorksheet = worksheets.getActiveWorksheet();
    const selection = selectionMode === "range"
      ? context.workbook.getSelectedRange()
      : context.workbook.getActiveCell();
    worksheets.load("items/name");
    activeWorksheet.load("name");
    selection.load("address,rowCount,columnCount");
    await context.sync();

    return {
      ok: true,
      workbook: {
        worksheets: worksheets.items.map((worksheet) => worksheet.name),
        activeWorksheet: activeWorksheet.name,
        selection: {
          address: selection.address,
          rowCount: selection.rowCount,
          columnCount: selection.columnCount,
          mode: selectionMode,
        },
      },
    };
  });
}

async function getWorkbookInfo() {
  try {
    return await loadWorkbookInfo("range");
  } catch (error) {
    if (error?.code !== "InvalidSelection" && error?.code !== "InvalidArgument") {
      throw error;
    }
    return loadWorkbookInfo("activeCell");
  }
}

async function getSelection() {
  return Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    return readRange(context, range, range.worksheet);
  });
}

async function readNamedRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    return readRange(context, range, worksheet);
  });
}

async function writeMatrix(args, property) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const { metadata, impact } = await inspectMutationRange(context, range, worksheet);
    const matrix = args[property];
    assertMatrixMatchesRange(matrix, metadata.rowCount, metadata.columnCount);
    range[property] = matrix;
    await context.sync();

    const readBack = await readBackRange(context, range, metadata);
    const matches = matricesEqual(readBack[property], matrix);
    assertVerification(
      matches,
      "WRITE_VERIFICATION_FAILED",
      "Excel 未能确认目标范围已按请求写入。",
    );
    return mutationResult(metadata, impact, {
      kind: property === "formulas" ? "formulas" : "values",
      matches,
      formulaErrorCells: readBack.formulaErrorCells,
    });
  });
}

async function formatRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const { metadata, impact } = await inspectMutationRange(context, range, worksheet);

    if (args.fillColor !== null) range.format.fill.color = args.fillColor;
    if (args.fontColor !== null) range.format.font.color = args.fontColor;
    if (args.bold !== null) range.format.font.bold = args.bold;
    if (args.italic !== null) range.format.font.italic = args.italic;
    if (args.fontSize !== null) range.format.font.size = args.fontSize;
    if (args.horizontalAlignment !== null) {
      range.format.horizontalAlignment = args.horizontalAlignment;
    }
    if (args.verticalAlignment !== null) {
      range.format.verticalAlignment = args.verticalAlignment;
    }
    if (args.wrapText !== null) range.format.wrapText = args.wrapText;
    await context.sync();

    const verification = await verifyRangeFormat(context, range, args);
    return mutationResult(metadata, impact, verification);
  });
}

async function setNumberFormat(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const { metadata, impact } = await inspectMutationRange(
      context,
      range,
      worksheet,
      assertNumberFormatSize,
    );
    const expectedNumberFormat = Array.from({ length: metadata.rowCount }, () =>
      Array(metadata.columnCount).fill(args.formatCode),
    );
    range.numberFormat = expectedNumberFormat;
    await context.sync();
    const readBack = await readBackRange(context, range, metadata);
    const matches = matricesEqual(readBack.numberFormat, expectedNumberFormat);
    assertVerification(
      matches,
      "NUMBER_FORMAT_VERIFICATION_FAILED",
      "Excel 未能确认数字格式已按请求应用。",
    );
    return mutationResult(metadata, impact, {
      kind: "numberFormat",
      matches,
      formatCode: args.formatCode,
      formulaErrorCells: readBack.formulaErrorCells,
    });
  });
}

async function autofitRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const metadata = await loadRangeMetadata(context, range, worksheet);
    const dimensions = assertAutofitDimensions(metadata.rowCount, metadata.columnCount, args);
    if (args.columns) range.format.autofitColumns();
    if (args.rows) range.format.autofitRows();
    range.format.load("columnWidth,rowHeight");
    await context.sync();
    return mutationResult(
      metadata,
      {
        target: metadata.address,
        rowCount: metadata.rowCount,
        columnCount: metadata.columnCount,
        affectedColumns: dimensions.columns,
        affectedRows: dimensions.rows,
      },
      {
        kind: "autofit",
        columns: args.columns,
        rows: args.rows,
        columnWidth: args.columns ? range.format.columnWidth : null,
        rowHeight: args.rows ? range.format.rowHeight : null,
      },
    );
  });
}

async function clearRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const { metadata, impact, values: previousValues, formulas: previousFormulas } =
      await inspectMutationRange(context, range, worksheet);
    range.clear(args.applyTo);
    await context.sync();
    const readBack = await readBackRange(context, range, metadata);
    const contentsCleared =
      args.applyTo !== "Formats" &&
      matrixIsBlank(readBack.values, metadata.rowCount, metadata.columnCount) &&
      matrixIsBlank(readBack.formulas, metadata.rowCount, metadata.columnCount);
    const contentsPreserved =
      args.applyTo === "Formats" &&
      matricesEqual(readBack.values, previousValues) &&
      matricesEqual(readBack.formulas, previousFormulas);
    const matches = contentsCleared || contentsPreserved;
    assertVerification(matches, "CLEAR_VERIFICATION_FAILED", "Excel 未能确认目标范围已按请求清除。");
    return mutationResult(metadata, impact, {
      kind: "clear",
      applyTo: args.applyTo,
      matches,
      contentsCleared,
      contentsPreserved,
      formulaErrorCells: readBack.formulaErrorCells,
    });
  });
}

async function addWorksheet(args) {
  return Excel.run(async (context) => {
    const worksheets = context.workbook.worksheets;
    const existing = worksheets.getItemOrNullObject(args.name);
    existing.load("isNullObject");
    await context.sync();
    if (!existing.isNullObject) {
      throw new ExcelToolError("WORKSHEET_EXISTS", `工作表“${args.name}”已存在。`);
    }

    const worksheet = worksheets.add(args.name);
    worksheet.load("name");
    await context.sync();
    return { ok: true, target: worksheet.name, worksheet: worksheet.name };
  });
}

async function renameWorksheet(args) {
  return Excel.run(async (context) => {
    const worksheets = context.workbook.worksheets;
    const worksheet = worksheets.getItem(args.currentName);
    worksheet.load("name");

    if (args.currentName !== args.newName) {
      const duplicate = worksheets.getItemOrNullObject(args.newName);
      duplicate.load("isNullObject");
      await context.sync();
      if (!duplicate.isNullObject) {
        throw new ExcelToolError("WORKSHEET_EXISTS", `工作表“${args.newName}”已存在。`);
      }
      worksheet.name = args.newName;
      await context.sync();
    } else {
      await context.sync();
    }

    return { ok: true, target: args.newName, worksheet: args.newName };
  });
}

async function createTable(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const { metadata, impact } = await inspectMutationRange(context, range, worksheet);
    const table = worksheet.tables.add(range, args.hasHeaders);
    if (args.name !== null) table.name = args.name;
    if (args.style !== null) table.style = args.style;
    table.load("name,style");
    await context.sync();
    const matches =
      typeof table.name === "string" &&
      table.name.length > 0 &&
      (args.name === null || table.name === args.name) &&
      (args.style === null || table.style === args.style);
    assertVerification(
      matches,
      "TABLE_VERIFICATION_FAILED",
      "Excel 未能确认表格名称或样式已按请求应用。",
    );
    return mutationResult(
      metadata,
      impact,
      { kind: "table", exists: true, matches, name: table.name, style: table.style },
      { table: table.name, style: table.style },
    );
  });
}

async function createChart(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const sourceRange = worksheet.getRange(args.sourceAddress);
    const { metadata, impact } = await inspectMutationRange(context, sourceRange, worksheet);
    const chart = worksheet.charts.add(args.chartType, sourceRange, args.seriesBy);

    if (args.title !== null) {
      chart.title.visible = true;
      chart.title.text = args.title;
    }
    if (args.positionAddress !== null) {
      const [startCell, endCell] = args.positionAddress.split(":");
      chart.setPosition(startCell, endCell ?? null);
    }
    chart.load("name,chartType");
    await context.sync();
    const matches =
      typeof chart.name === "string" &&
      chart.name.length > 0 &&
      chart.chartType === args.chartType;
    assertVerification(
      matches,
      "CHART_VERIFICATION_FAILED",
      "Excel 未能确认图表名称或类型已按请求应用。",
    );
    return mutationResult(
      metadata,
      impact,
      { kind: "chart", exists: true, matches, name: chart.name, chartType: chart.chartType },
      { chart: chart.name, chartType: args.chartType },
    );
  });
}

async function sortRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const { metadata, impact } = await inspectMutationRange(context, range, worksheet);
    if (args.keyColumn > metadata.columnCount) {
      throw new ExcelToolError(
        "SORT_KEY_OUT_OF_RANGE",
        `排序列 ${args.keyColumn} 超出目标范围的 ${metadata.columnCount} 列。`,
      );
    }
    range.sort.apply(
      [{ key: args.keyColumn - 1, ascending: args.direction === "Ascending" }],
      false,
      args.hasHeaders,
      "Rows",
    );
    await context.sync();
    const readBack = await readBackRange(context, range, metadata);
    const sortCheck = inspectSortOrder(
      readBack.values,
      args.keyColumn,
      args.hasHeaders,
      args.direction,
    );
    assertVerification(
      !sortCheck.orderChecked || sortCheck.ordered,
      "SORT_VERIFICATION_FAILED",
      "Excel 未能确认目标范围已按请求排序。",
    );
    return mutationResult(
      metadata,
      impact,
      {
        kind: "sort",
        readBack: true,
        matches: true,
        orderChecked: sortCheck.orderChecked,
        ordered: sortCheck.ordered,
        keyColumn: args.keyColumn,
        direction: args.direction,
        hasHeaders: args.hasHeaders,
        keyValues: sortCheck.keyValues,
        formulaErrorCells: readBack.formulaErrorCells,
      },
      { keyColumn: args.keyColumn, direction: args.direction },
    );
  });
}

const executors = {
  get_workbook_info: getWorkbookInfo,
  get_selection: getSelection,
  read_range: readNamedRange,
  write_values: (args) => writeMatrix(args, "values"),
  write_formulas: (args) => writeMatrix(args, "formulas"),
  format_range: formatRange,
  set_number_format: setNumberFormat,
  autofit_range: autofitRange,
  clear_range: clearRange,
  add_worksheet: addWorksheet,
  rename_worksheet: renameWorksheet,
  create_table: createTable,
  create_chart: createChart,
  sort_range: sortRange,
};

export async function executeExcelTool(name, rawArguments) {
  const args = parseAndValidateToolArguments(name, rawArguments);
  const executor = executors[name];
  if (!executor) {
    throw new ExcelToolError("TOOL_NOT_IMPLEMENTED", `Excel 工具尚未实现：${name}`);
  }
  return executor(args);
}

export function toToolErrorResult(error) {
  if (error instanceof ToolValidationError || error instanceof ExcelToolError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  const officeCode = typeof error?.code === "string" ? error.code : "OFFICE_ERROR";
  return {
    ok: false,
    error: {
      code: officeCode,
      message: error instanceof Error ? error.message.slice(0, 500) : "Excel 操作失败。",
    },
  };
}
