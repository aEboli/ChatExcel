export const MAX_READ_CELLS = 2_000;
export const MAX_WRITE_CELLS = 5_000;

export class ToolValidationError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "ToolValidationError";
    this.code = code;
    this.path = path;
  }
}
const nullableWorksheet = {
  type: ["string", "null"],
  minLength: 1,
  maxLength: 31,
  description: "工作表名称；为 null 时使用活动工作表。",
};

const rangeAddress = {
  type: "string",
  minLength: 2,
  maxLength: 32,
  description: "不含工作表名称的 A1 单元格或矩形范围，例如 A1:D20。",
};

const scalarValue = { type: ["string", "number", "boolean", "null"] };
const matrix = (itemSchema, maxItems = 200) => ({
  type: "array",
  minItems: 1,
  maxItems,
  items: {
    type: "array",
    minItems: 1,
    maxItems: 200,
    items: itemSchema,
  },
});

function objectSchema(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const EXCEL_TOOLS = Object.freeze([
  {
    name: "get_workbook_info",
    label: "读取工作簿信息",
    mode: "read",
    description: "读取当前工作簿的工作表列表、活动工作表和当前选区地址。",
    parameters: objectSchema({}),
  },
  {
    name: "get_selection",
    label: "读取当前选区",
    mode: "read",
    description: `读取当前选区的地址、值、公式和数字格式；最多 ${MAX_READ_CELLS} 个单元格。`,
    parameters: objectSchema({}),
  },
  {
    name: "read_range",
    label: "读取指定范围",
    mode: "read",
    description: `读取指定矩形范围的值、公式和数字格式；最多 ${MAX_READ_CELLS} 个单元格。`,
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
    }),
  },
  {
    name: "write_values",
    label: "写入值",
    mode: "modify",
    description: "把二维值数组一次写入尺寸完全相同的目标范围。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
      values: matrix(scalarValue),
    }),
  },
  {
    name: "write_formulas",
    label: "写入公式",
    mode: "modify",
    description: "把二维 A1 公式数组一次写入尺寸完全相同的目标范围。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
      formulas: matrix({ type: "string", maxLength: 8_192 }),
    }),
  },
  {
    name: "format_range",
    label: "设置范围格式",
    mode: "modify",
    description: "设置范围的填充色、字体、对齐和换行；不修改值或公式。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
      fillColor: { type: ["string", "null"], description: "#RRGGBB 或 null。" },
      fontColor: { type: ["string", "null"], description: "#RRGGBB 或 null。" },
      bold: { type: ["boolean", "null"] },
      italic: { type: ["boolean", "null"] },
      fontSize: { type: ["number", "null"], minimum: 6, maximum: 72 },
      horizontalAlignment: {
        type: ["string", "null"],
        enum: ["Left", "Center", "Right", "General", null],
      },
      verticalAlignment: {
        type: ["string", "null"],
        enum: ["Top", "Center", "Bottom", null],
      },
      wrapText: { type: ["boolean", "null"] },
    }),
  },
  {
    name: "set_number_format",
    label: "设置数字格式",
    mode: "modify",
    description: "给目标范围的所有单元格设置同一个 Excel 数字格式代码。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
      formatCode: { type: "string", minLength: 1, maxLength: 128 },
    }),
  },
  {
    name: "autofit_range",
    label: "自动调整行列",
    mode: "modify",
    description: "自动调整目标范围涉及的列宽和/或行高。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
      columns: { type: "boolean" },
      rows: { type: "boolean" },
    }),
  },
  {
    name: "clear_range",
    label: "清除范围",
    mode: "modify",
    description: "清除目标范围的全部内容、仅内容或仅格式。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
      applyTo: { type: "string", enum: ["All", "Contents", "Formats"] },
    }),
  },
  {
    name: "add_worksheet",
    label: "添加工作表",
    mode: "modify",
    description: "添加一个具有指定名称的工作表。",
    parameters: objectSchema({
      name: { type: "string", minLength: 1, maxLength: 31 },
    }),
  },
  {
    name: "rename_worksheet",
    label: "重命名工作表",
    mode: "modify",
    description: "把一个现有工作表重命名。",
    parameters: objectSchema({
      currentName: { type: "string", minLength: 1, maxLength: 31 },
      newName: { type: "string", minLength: 1, maxLength: 31 },
    }),
  },
  {
    name: "create_table",
    label: "创建表格",
    mode: "modify",
    description: "从目标数据范围创建原生 Excel 表格。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
      hasHeaders: { type: "boolean" },
      name: { type: ["string", "null"], minLength: 1, maxLength: 255 },
      style: { type: ["string", "null"], minLength: 1, maxLength: 64 },
    }),
  },
  {
    name: "create_chart",
    label: "创建图表",
    mode: "modify",
    description: "从数据范围创建原生 Excel 图表，并可设置标题和放置范围。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      sourceAddress: rangeAddress,
      chartType: {
        type: "string",
        enum: [
          "ColumnClustered",
          "BarClustered",
          "Line",
          "Pie",
          "Doughnut",
          "Area",
          "XYScatter",
        ],
      },
      seriesBy: { type: "string", enum: ["Auto", "Rows", "Columns"] },
      title: { type: ["string", "null"], maxLength: 255 },
      positionAddress: { type: ["string", "null"], maxLength: 32 },
    }),
  },
  {
    name: "sort_range",
    label: "排序范围",
    mode: "modify",
    description: "按目标范围内从 1 开始的相对列号，对整块范围按行排序。",
    parameters: objectSchema({
      worksheet: nullableWorksheet,
      address: rangeAddress,
      keyColumn: { type: "integer", minimum: 1, maximum: 16_384 },
      direction: { type: "string", enum: ["Ascending", "Descending"] },
      hasHeaders: { type: "boolean" },
    }),
  },
]);

const toolsByName = new Map(EXCEL_TOOLS.map((tool) => [tool.name, tool]));

function valueMatchesType(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}

function validateSchema(value, schema, path) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => valueMatchesType(value, type))) {
    throw new ToolValidationError("TOOL_ARGUMENT_TYPE", `${path} 的类型不正确。`, path);
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new ToolValidationError("TOOL_ARGUMENT_ENUM", `${path} 不是允许的值。`, path);
  }

  if (value === null) {
    return;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ToolValidationError("TOOL_ARGUMENT_LENGTH", `${path} 太短。`, path);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new ToolValidationError("TOOL_ARGUMENT_LENGTH", `${path} 太长。`, path);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new ToolValidationError("TOOL_ARGUMENT_PATTERN", `${path} 格式不正确。`, path);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new ToolValidationError("TOOL_ARGUMENT_RANGE", `${path} 小于允许值。`, path);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new ToolValidationError("TOOL_ARGUMENT_RANGE", `${path} 大于允许值。`, path);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new ToolValidationError("TOOL_ARGUMENT_ITEMS", `${path} 项数不足。`, path);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new ToolValidationError("TOOL_ARGUMENT_ITEMS", `${path} 项数过多。`, path);
    }
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        throw new ToolValidationError(
          "TOOL_ARGUMENT_REQUIRED",
          `${path}.${required} 是必填参数。`,
          `${path}.${required}`,
        );
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) {
          throw new ToolValidationError(
            "TOOL_ARGUMENT_UNKNOWN",
            `${path}.${key} 不是允许的参数。`,
            `${path}.${key}`,
          );
        }
        continue;
      }
      validateSchema(item, properties[key], `${path}.${key}`);
    }
  }
}

function validateWorksheetName(name, path) {
  if (name === null) {
    return;
  }
  if (/[\\/?*:[\]]/.test(name) || name.startsWith("'") || name.endsWith("'")) {
    throw new ToolValidationError("WORKSHEET_NAME_INVALID", `${path} 不是有效的工作表名称。`, path);
  }
}

function validateAddress(address, path) {
  if (!/^\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?$/i.test(address)) {
    throw new ToolValidationError("RANGE_ADDRESS_INVALID", `${path} 必须是矩形 A1 范围。`, path);
  }
}

function validateMatrix(values, path) {
  const columns = values[0].length;
  if (values.some((row) => row.length !== columns)) {
    throw new ToolValidationError("MATRIX_NOT_RECTANGULAR", `${path} 必须是规则二维数组。`, path);
  }
  if (values.length * columns > MAX_WRITE_CELLS) {
    throw new ToolValidationError(
      "WRITE_RANGE_TOO_LARGE",
      `${path} 超过 ${MAX_WRITE_CELLS} 个单元格限制。`,
      path,
    );
  }
}

function validateSemanticArguments(name, args) {
  for (const key of ["worksheet", "currentName", "newName", "name"]) {
    if (Object.hasOwn(args, key) && (key !== "name" || name === "add_worksheet")) {
      validateWorksheetName(args[key], `$.${key}`);
    }
  }

  for (const key of ["address", "sourceAddress", "positionAddress"]) {
    if (typeof args[key] === "string") {
      validateAddress(args[key], `$.${key}`);
    }
  }

  if (Object.hasOwn(args, "values")) {
    validateMatrix(args.values, "$.values");
  }
  if (Object.hasOwn(args, "formulas")) {
    validateMatrix(args.formulas, "$.formulas");
  }

  for (const key of ["fillColor", "fontColor"]) {
    if (args[key] !== undefined && args[key] !== null && !/^#[0-9a-f]{6}$/i.test(args[key])) {
      throw new ToolValidationError("COLOR_INVALID", `$.${key} 必须是 #RRGGBB。`, `$.${key}`);
    }
  }

  if (name === "autofit_range" && !args.columns && !args.rows) {
    throw new ToolValidationError(
      "AUTOFIT_TARGET_MISSING",
      "自动调整至少需要选择列宽或行高。",
      "$",
    );
  }

  if (name === "create_table") {
    if (args.name !== null && !/^[A-Za-z_\\][A-Za-z0-9_.]*$/.test(args.name)) {
      throw new ToolValidationError("TABLE_NAME_INVALID", "$.name 不是有效的表格名称。", "$.name");
    }
    if (args.style !== null && !/^TableStyle(?:Light|Medium|Dark)\d{1,2}$/.test(args.style)) {
      throw new ToolValidationError("TABLE_STYLE_INVALID", "$.style 不是受支持的表格样式。", "$.style");
    }
  }
}

export function getToolDefinition(name) {
  return toolsByName.get(name) ?? null;
}

export function isModificationTool(name) {
  return getToolDefinition(name)?.mode === "modify";
}

export function parseAndValidateToolArguments(name, rawArguments) {
  const tool = getToolDefinition(name);
  if (!tool) {
    throw new ToolValidationError("TOOL_UNKNOWN", `未知 Excel 工具：${name}`);
  }

  let args = rawArguments;
  if (typeof rawArguments === "string") {
    try {
      args = JSON.parse(rawArguments);
    } catch (error) {
      throw new ToolValidationError("TOOL_ARGUMENT_JSON", "工具参数不是有效 JSON。", "$", {
        cause: error,
      });
    }
  }

  validateSchema(args, tool.parameters, "$");
  validateSemanticArguments(name, args);
  return args;
}

export function getResponsesToolDefinitions() {
  return EXCEL_TOOLS.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  }));
}
