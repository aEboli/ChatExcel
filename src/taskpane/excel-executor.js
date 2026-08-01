import {
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
    const metadata = await loadRangeMetadata(context, range, worksheet);
    const matrix = args[property];
    assertMatrixMatchesRange(matrix, metadata.rowCount, metadata.columnCount);
    range[property] = matrix;
    await context.sync();

    return {
      ok: true,
      target: metadata.address,
      worksheet: metadata.worksheet,
      rowCount: metadata.rowCount,
      columnCount: metadata.columnCount,
    };
  });
}

async function formatRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const metadata = await loadRangeMetadata(context, range, worksheet);

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

    return { ok: true, target: metadata.address, worksheet: metadata.worksheet };
  });
}

async function setNumberFormat(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const metadata = await loadRangeMetadata(context, range, worksheet);
    range.numberFormat = Array.from({ length: metadata.rowCount }, () =>
      Array(metadata.columnCount).fill(args.formatCode),
    );
    await context.sync();
    return { ok: true, target: metadata.address, worksheet: metadata.worksheet };
  });
}

async function autofitRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const metadata = await loadRangeMetadata(context, range, worksheet);
    if (args.columns) range.format.autofitColumns();
    if (args.rows) range.format.autofitRows();
    await context.sync();
    return { ok: true, target: metadata.address, worksheet: metadata.worksheet };
  });
}

async function clearRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const metadata = await loadRangeMetadata(context, range, worksheet);
    range.clear(args.applyTo);
    await context.sync();
    return { ok: true, target: metadata.address, worksheet: metadata.worksheet };
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
    const metadata = await loadRangeMetadata(context, range, worksheet);
    const table = worksheet.tables.add(range, args.hasHeaders);
    if (args.name !== null) table.name = args.name;
    if (args.style !== null) table.style = args.style;
    table.load("name,style");
    await context.sync();
    return {
      ok: true,
      target: metadata.address,
      worksheet: metadata.worksheet,
      table: table.name,
      style: table.style,
    };
  });
}

async function createChart(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const sourceRange = worksheet.getRange(args.sourceAddress);
    const metadata = await loadRangeMetadata(context, sourceRange, worksheet);
    const chart = worksheet.charts.add(args.chartType, sourceRange, args.seriesBy);

    if (args.title !== null) {
      chart.title.visible = true;
      chart.title.text = args.title;
    }
    if (args.positionAddress !== null) {
      const [startCell, endCell] = args.positionAddress.split(":");
      chart.setPosition(startCell, endCell ?? null);
    }
    chart.load("name");
    await context.sync();
    return {
      ok: true,
      target: metadata.address,
      worksheet: metadata.worksheet,
      chart: chart.name,
      chartType: args.chartType,
    };
  });
}

async function sortRange(args) {
  return Excel.run(async (context) => {
    const worksheet = getWorksheet(context.workbook, args.worksheet);
    const range = worksheet.getRange(args.address);
    const metadata = await loadRangeMetadata(context, range, worksheet);
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
    return {
      ok: true,
      target: metadata.address,
      worksheet: metadata.worksheet,
      keyColumn: args.keyColumn,
      direction: args.direction,
    };
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
