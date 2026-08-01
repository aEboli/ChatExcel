function formatWorkbookSummary(workbook) {
  const parts = [];
  if (workbook.activeWorksheet) parts.push(`活动工作表 ${workbook.activeWorksheet}`);
  if (workbook.selection?.address) parts.push(`选区 ${workbook.selection.address}`);
  if (Array.isArray(workbook.worksheets)) {
    parts.push(`${workbook.worksheets.length} 张工作表`);
  }
  return parts;
}

export function summarizeToolOutput(output) {
  if (!output || typeof output !== "object") return "无结果摘要";
  if (output.ok === false) {
    return `失败：${output.error?.message ?? "Excel 操作失败"}`;
  }

  if (output.workbook && typeof output.workbook === "object") {
    return formatWorkbookSummary(output.workbook).join(" · ") || "读取完成";
  }

  const parts = [];
  if (output.target) parts.push(String(output.target));
  else if (output.worksheet) parts.push(String(output.worksheet));
  if (output.rowCount && output.columnCount) {
    parts.push(`${output.rowCount} x ${output.columnCount}`);
  }
  if (output.table) parts.push(`表格 ${output.table}`);
  if (output.chart) parts.push(`图表 ${output.chart}`);
  if (output.direction) {
    parts.push(output.direction === "Ascending" ? "升序" : "降序");
  }
  return parts.join(" · ") || "操作成功";
}
