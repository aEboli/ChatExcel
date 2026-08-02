import assert from "node:assert/strict";
import test from "node:test";
import {
  EXCEL_TOOLS,
  ToolValidationError,
  getResponsesToolDefinitions,
  isModificationTool,
  parseAndValidateToolArguments,
} from "../src/shared/excel-tools.js";

const modificationTools = new Set([
  "write_values",
  "write_formulas",
  "format_range",
  "set_number_format",
  "autofit_range",
  "clear_range",
  "add_worksheet",
  "rename_worksheet",
  "create_table",
  "create_chart",
  "sort_range",
]);

test("共享工具名称唯一且 Schema 可序列化", () => {
  const names = EXCEL_TOOLS.map((tool) => tool.name);
  const responseDefinitions = getResponsesToolDefinitions();

  assert.equal(EXCEL_TOOLS.length, 14);
  assert.equal(new Set(names).size, names.length);
  assert.doesNotThrow(() => JSON.stringify(responseDefinitions));
  assert.equal(responseDefinitions.every((tool) => tool.strict === true), true);
  assert.equal(responseDefinitions.every((tool) => tool.parameters.additionalProperties === false), true);
});
test("所有修改型工具完整分类", () => {
  const actual = new Set(
    EXCEL_TOOLS.filter((tool) => isModificationTool(tool.name)).map((tool) => tool.name),
  );

  assert.deepEqual(actual, modificationTools);
  assert.equal(EXCEL_TOOLS.every((tool) => ["read", "modify"].includes(tool.mode)), true);
});

test("解析并验证合法工具参数", () => {
  const args = parseAndValidateToolArguments(
    "write_values",
    JSON.stringify({ worksheet: "结果", address: "A1:B2", values: [["名称", "数量"], ["A", 2]] }),
  );

  assert.equal(args.address, "A1:B2");
  assert.equal(args.values[1][1], 2);
});

test("接受单元格、矩形、整列、整行和绝对 A1 范围", () => {
  for (const address of ["A1", "A1:D20", "$A$1:$D$20", "N:R", "$N:$R", "1:3", "$1:$3"]) {
    const args = parseAndValidateToolArguments("autofit_range", {
      worksheet: null,
      address,
      columns: true,
      rows: false,
    });
    assert.equal(args.address, address);
  }
});

test("拒绝工作表限定符、联合范围、外部引用和公式地址", () => {
  for (const address of ["Sheet1!A1:B2", "A1:B2,D1:E2", "[Book.xlsx]Sheet1!A1", "=A1:B2"]) {
    assert.throws(
      () => parseAndValidateToolArguments("read_range", { worksheet: null, address }),
      (error) => error instanceof ToolValidationError && error.code === "RANGE_ADDRESS_INVALID",
    );
  }
});

test("拒绝未知工具、未知参数和无效 JSON", () => {
  assert.throws(
    () => parseAndValidateToolArguments("not_registered", {}),
    (error) => error instanceof ToolValidationError && error.code === "TOOL_UNKNOWN",
  );
  assert.throws(
    () => parseAndValidateToolArguments("get_workbook_info", { unexpected: true }),
    (error) => error instanceof ToolValidationError && error.code === "TOOL_ARGUMENT_UNKNOWN",
  );
  assert.throws(
    () => parseAndValidateToolArguments("read_range", "{") ,
    (error) => error instanceof ToolValidationError && error.code === "TOOL_ARGUMENT_JSON",
  );
});

test("拒绝不规则二维数组和无效颜色", () => {
  assert.throws(
    () =>
      parseAndValidateToolArguments("write_values", {
        worksheet: null,
        address: "A1:B2",
        values: [[1, 2], [3]],
      }),
    (error) => error instanceof ToolValidationError && error.code === "MATRIX_NOT_RECTANGULAR",
  );
  assert.throws(
    () =>
      parseAndValidateToolArguments("format_range", {
        worksheet: null,
        address: "A1",
        fillColor: "green",
        fontColor: null,
        bold: null,
        italic: null,
        fontSize: null,
        horizontalAlignment: null,
        verticalAlignment: null,
        wrapText: null,
      }),
    (error) => error instanceof ToolValidationError && error.code === "COLOR_INVALID",
  );
});
