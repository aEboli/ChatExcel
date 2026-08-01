import { loadCodexConfig, toPublicConfig } from "../src/server/config.js";
import { createResponsesClient } from "../src/server/responses-client.js";
import {
  getResponsesToolDefinitions,
  parseAndValidateToolArguments,
} from "../src/shared/excel-tools.js";

const input = [
  {
    role: "user",
    content: [
      {
        type: "input_text",
        text: "这是协议兼容性检查。请先调用 get_workbook_info；收到结果后，仅简短确认检查完成。",
      },
    ],
  },
];

const configLoader = async () => ({
  ...(await loadCodexConfig()),
  reasoningEffort: "low",
  verbosity: "low",
});
const client = createResponsesClient({
  configLoader,
  timeoutMs: 180_000,
  toolDefinitions: getResponsesToolDefinitions().filter(
    (tool) => tool.name === "get_workbook_info",
  ),
});
const first = await client.create({ input });
const call = first.output.find((item) => item?.type === "function_call");

if (!call) {
  throw new Error("提供方未返回函数调用，无法验证工具结果续传。" );
}
if (call.name !== "get_workbook_info" || typeof call.call_id !== "string") {
  throw new Error("提供方返回的函数调用与兼容性检查不匹配。" );
}
parseAndValidateToolArguments(call.name, call.arguments);

input.push(
  ...first.output,
  {
    type: "function_call_output",
    call_id: call.call_id,
    output: JSON.stringify({
      ok: true,
      workbook: {
        worksheets: ["兼容性测试"],
        activeWorksheet: "兼容性测试",
        selection: "A1",
      },
    }),
  },
);

const second = await client.create({ input });
const finalText = second.output
  .filter((item) => item?.type === "message")
  .flatMap((item) => item.content ?? [])
  .filter((item) => item?.type === "output_text" && typeof item.text === "string")
  .map((item) => item.text)
  .join("\n")
  .trim();

if (!finalText) {
  throw new Error("续传工具结果后，提供方未返回最终文本。" );
}

const publicConfig = toPublicConfig(await loadCodexConfig());
console.log(
  JSON.stringify(
    {
      ok: true,
      provider: publicConfig.providerName,
      model: publicConfig.model,
      firstOutputTypes: first.output.map((item) => item?.type ?? "unknown"),
      tool: call.name,
      finalOutputTypes: second.output.map((item) => item?.type ?? "unknown"),
      finalTextLength: finalText.length,
    },
    null,
    2,
  ),
);
