const MAX_PREVIEW_ROWS = 30;
const MAX_PREVIEW_COLUMNS = 12;
const MAX_IMAGE_DATA_URL_LENGTH = 384_000;

function stringValue(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeAddress(value) {
  const raw = stringValue(value);
  if (!raw) return null;
  const separator = raw.lastIndexOf("!");
  return (separator === -1 ? raw : raw.slice(separator + 1)).replaceAll("$", "").trim() || null;
}

function worksheetFromTarget(value) {
  const raw = stringValue(value);
  if (!raw) return null;
  const separator = raw.lastIndexOf("!");
  return separator === -1 ? null : raw.slice(0, separator).replace(/^'|'$/g, "") || null;
}

function targetFromCall({ call, arguments: args = {}, output = {} }) {
  const name = call?.name;
  const target = stringValue(output?.target);
  const address = normalizeAddress(
    args.address ?? args.sourceAddress ?? output?.target ?? output?.workbook?.selection?.address,
  );
  const worksheet = stringValue(
    output?.worksheet ?? args.worksheet ?? args.currentName ?? output?.workbook?.activeWorksheet ?? worksheetFromTarget(target),
  );

  if (name === "create_chart" && stringValue(output?.chart)) {
    return { kind: "chart", worksheet, chart: output.chart, address };
  }
  if (address) return { kind: "range", worksheet, address };
  if (name === "add_worksheet" || name === "rename_worksheet") {
    return { kind: "range", worksheet: worksheet ?? stringValue(args.name) ?? stringValue(args.newName), address: "A1:F12" };
  }
  return null;
}

function parseTopLeft(address) {
  const match = /^([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/i.exec(address ?? "");
  if (!match) return { column: 1, row: 1 };
  return {
    column: [...match[1].toUpperCase()].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0),
    row: Number(match[2]),
  };
}

function columnLabel(index) {
  let value = index;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function matrix(value) {
  return Array.isArray(value) && value.length > 0 && value.every((row) => Array.isArray(row))
    ? value
    : null;
}

function displayValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function imageDataUrl(value) {
  const image = stringValue(value);
  if (!image) return null;
  const dataUrl = image.startsWith("data:image/") ? image : `data:image/png;base64,${image}`;
  return dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH ? dataUrl : null;
}

export function historyPreviewTarget(details) {
  return targetFromCall(details);
}

export function historyPreviewFallback({ call, tool, arguments: args = {}, output = {} }) {
  const target = targetFromCall({ call, arguments: args, output });
  const label = tool?.label ?? call?.name ?? "操作";
  if (output?.ok === false) {
    return {
      kind: "summary",
      worksheet: target?.worksheet ?? null,
      address: target?.address ?? null,
      message: output?.error?.message ?? "该步骤未修改工作簿。",
      label,
    };
  }

  const values = matrix(output?.values) ?? matrix(args.values);
  const formulas = matrix(output?.formulas) ?? matrix(args.formulas);
  const data = values ?? formulas;

  if (!data) {
    return {
      kind: "summary",
      worksheet: target?.worksheet ?? null,
      address: target?.address ?? null,
      message: "该步骤没有可显示的单元格快照。",
      label,
    };
  }

  const origin = parseTopLeft(target?.address);
  const rowCount = Math.min(data.length, MAX_PREVIEW_ROWS);
  const columnCount = Math.min(
    Math.max(0, ...data.slice(0, rowCount).map((row) => row.length)),
    MAX_PREVIEW_COLUMNS,
  );
  const rows = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const value = data[rowIndex]?.[columnIndex];
      const formula = formulas?.[rowIndex]?.[columnIndex];
      cells.push({
        text: displayValue(value),
        formula: typeof formula === "string" ? formula : null,
      });
    }
    rows.push({ row: origin.row + rowIndex, cells });
  }

  return {
    kind: "grid",
    worksheet: target?.worksheet ?? null,
    address: target?.address ?? null,
    label,
    columns: Array.from({ length: columnCount }, (_, index) => columnLabel(origin.column + index)),
    rows,
    truncated: data.length > rowCount || data.some((row) => row.length > columnCount),
  };
}

async function captureRangeImage(target) {
  return globalThis.Excel.run(async (context) => {
    const worksheet = target.worksheet
      ? context.workbook.worksheets.getItem(target.worksheet)
      : context.workbook.worksheets.getActiveWorksheet();
    const range = worksheet.getRange(target.address);
    worksheet.load("name");
    range.load("rowIndex,columnIndex,rowCount,columnCount,address");
    await context.sync();

    const previewRange = range.rowCount > MAX_PREVIEW_ROWS || range.columnCount > MAX_PREVIEW_COLUMNS
      ? worksheet.getRangeByIndexes(
        range.rowIndex,
        range.columnIndex,
        Math.min(range.rowCount, MAX_PREVIEW_ROWS),
        Math.min(range.columnCount, MAX_PREVIEW_COLUMNS),
      )
      : range;
    previewRange.load("address");
    const image = previewRange.getImage();
    await context.sync();
    const dataUrl = imageDataUrl(image.value);
    if (!dataUrl) throw new Error("Excel 未返回有效的范围图像。");
    return {
      kind: "image",
      worksheet: worksheet.name,
      address: previewRange.address,
      dataUrl,
      truncated: previewRange !== range,
    };
  });
}

async function captureChartImage(target) {
  return globalThis.Excel.run(async (context) => {
    const worksheet = target.worksheet
      ? context.workbook.worksheets.getItem(target.worksheet)
      : context.workbook.worksheets.getActiveWorksheet();
    const chart = worksheet.charts.getItem(target.chart);
    worksheet.load("name");
    chart.load("name");
    const image = chart.getImage();
    await context.sync();
    const dataUrl = imageDataUrl(image.value);
    if (!dataUrl) throw new Error("Excel 未返回有效的图表图像。");
    return {
      kind: "image",
      worksheet: worksheet.name,
      address: target.address ?? chart.name,
      dataUrl,
      truncated: false,
    };
  });
}

export async function captureOfficeHistoryPreview(details) {
  const fallback = historyPreviewFallback(details);
  const target = historyPreviewTarget(details);
  if (details.output?.ok === false || !target || !globalThis.Excel?.run) return fallback;

  try {
    return target.kind === "chart"
      ? await captureChartImage(target)
      : await captureRangeImage(target);
  } catch {
    return fallback;
  }
}
