function emit(onEvent, event) {
  if (typeof onEvent !== "function") return;
  onEvent(event);
}

function safeJson(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseSseFrame(lines) {
  let event = "message";
  const data = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

async function* readSseFrames(body, signal) {
  if (!body || typeof body.getReader !== "function") {
    throw new Error("上游事件流缺少可读取的响应体。" );
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frameLines = [];

  const flushFrame = () => {
    const frame = parseSseFrame(frameLines);
    frameLines = [];
    return frame;
  };

  try {
    while (true) {
      signal?.throwIfAborted?.();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.replace(/\r$/, "") === "") {
          const frame = flushFrame();
          if (frame) yield frame;
        } else {
          frameLines.push(line);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") frameLines.push(buffer);
    const frame = flushFrame();
    if (frame) yield frame;
  } finally {
    reader.releaseLock?.();
  }
}

function normalizeCallKey(value, fallback) {
  return typeof value === "string" && value !== "" ? value : String(value ?? fallback);
}

function createResponsesAccumulator(onEvent) {
  let completedResponse = null;
  let text = "";
  let usage;
  const calls = new Map();
  const callOrder = [];
  const itemToCall = new Map();

  const upsertCall = (raw = {}, key = null) => {
    const itemKey = raw.id ?? key;
    const callKey = normalizeCallKey(
      raw.call_id ?? raw.id ?? raw.item_id ?? key,
      `responses-call-${callOrder.length + 1}`,
    );
    const mappedKey = itemToCall.get(String(itemKey));
    const resolvedKey = mappedKey ?? callKey;
    if (!calls.has(resolvedKey)) {
      calls.set(resolvedKey, { id: "", name: "", call_id: callKey, arguments: "" });
      callOrder.push(resolvedKey);
    }
    const call = calls.get(resolvedKey);
    if (typeof raw.id === "string" && raw.id !== "") call.id = raw.id;
    if (typeof raw.name === "string" && raw.name !== "") call.name = raw.name;
    if (typeof raw.call_id === "string" && raw.call_id !== "") call.call_id = raw.call_id;
    if (typeof raw.arguments === "string") call.arguments = raw.arguments;
    if (itemKey !== null && itemKey !== undefined) itemToCall.set(String(itemKey), resolvedKey);
    if (raw.call_id) itemToCall.set(String(raw.call_id), resolvedKey);
    return call;
  };

  return {
    push(event, payload) {
      if (!payload || typeof payload !== "object") return;
      const response = payload.response ?? payload;
      if (response?.usage) usage = response.usage;
      if (event === "response.output_text.delta" && typeof payload.delta === "string") {
        text += payload.delta;
        emit(onEvent, { type: "text_delta", text: payload.delta });
      } else if (event === "response.output_item.added" && payload.item?.type === "function_call") {
        upsertCall(payload.item, payload.item.id);
      } else if (event === "response.output_item.done" && payload.item?.type === "function_call") {
        const call = upsertCall(payload.item, payload.item.id);
        if (typeof payload.item.arguments === "string") call.arguments = payload.item.arguments;
      } else if (event === "response.function_call_arguments.delta" && typeof payload.delta === "string") {
        upsertCall({ item_id: payload.item_id }, payload.item_id ?? payload.output_index).arguments += payload.delta;
      } else if (event === "response.completed") {
        completedResponse = response;
      }
    },
    finish() {
      if (completedResponse && Array.isArray(completedResponse.output)) return completedResponse;
      const output = [];
      if (text !== "") {
        output.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const key of callOrder) {
        const call = calls.get(key);
        if (call?.name) {
          const normalizedCall = {
            type: "function_call",
            name: call.name,
            call_id: call.call_id,
            arguments: call.arguments,
            ...(call.id ? { id: call.id } : {}),
          };
          output.push(normalizedCall);
        }
      }
      return { output, output_text: text, ...(usage ? { usage } : {}) };
    },
  };
}

function createChatAccumulator(onEvent) {
  let text = "";
  let usage;
  const calls = new Map();
  const callOrder = [];
  return {
    push(_event, payload) {
      if (!payload || typeof payload !== "object") return;
      if (payload.usage) usage = payload.usage;
      for (const choice of payload.choices ?? []) {
        const delta = choice?.delta;
        if (typeof delta?.content === "string") {
          text += delta.content;
          emit(onEvent, { type: "text_delta", text: delta.content });
        }
        for (const toolCall of delta?.tool_calls ?? []) {
          const index = Number.isInteger(toolCall?.index) ? toolCall.index : callOrder.length;
          const key = String(index);
          if (!calls.has(key)) {
            calls.set(key, { id: "", type: "function", function: { name: "", arguments: "" } });
            callOrder.push(key);
          }
          const call = calls.get(key);
          if (typeof toolCall.id === "string" && toolCall.id !== "") call.id = toolCall.id;
          if (typeof toolCall.function?.name === "string") call.function.name += toolCall.function.name;
          if (typeof toolCall.function?.arguments === "string") call.function.arguments += toolCall.function.arguments;
        }
      }
    },
    finish() {
      const toolCalls = callOrder
        .map((key) => calls.get(key))
        .filter((call) => call?.id && call.function?.name)
        .map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments || "{}",
          },
        }));
      return {
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: text,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        }],
        ...(usage ? { usage } : {}),
      };
    },
  };
}

function createAnthropicAccumulator(onEvent) {
  const blocks = new Map();
  let usage = {};
  return {
    push(event, payload) {
      if (!payload || typeof payload !== "object") return;
      if (event === "message_start" && payload.message?.usage) usage = { ...usage, ...payload.message.usage };
      if (event === "message_delta" && payload.usage) usage = { ...usage, ...payload.usage };
      if (event === "content_block_start") {
        const index = Number.isInteger(payload.index) ? payload.index : blocks.size;
        const block = payload.content_block ?? {};
        blocks.set(index, {
          type: block.type ?? "text",
          text: typeof block.text === "string" ? block.text : "",
          thinking: typeof block.thinking === "string" ? block.thinking : "",
          id: block.id ?? "",
          name: block.name ?? "",
          input: block.input && typeof block.input === "object" ? block.input : {},
          inputJson: "",
        });
      } else if (event === "content_block_delta") {
        const index = Number.isInteger(payload.index) ? payload.index : blocks.size;
        const block = blocks.get(index) ?? {
          type: payload.delta?.type === "input_json_delta" ? "tool_use" : "text",
          text: "",
          thinking: "",
          id: "",
          name: "",
          input: {},
          inputJson: "",
        };
        const delta = payload.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text += delta.text;
          emit(onEvent, { type: "text_delta", text: delta.text });
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking += delta.thinking;
          emit(onEvent, { type: "reasoning_delta", text: delta.thinking });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          block.inputJson += delta.partial_json;
        }
        blocks.set(index, block);
      }
    },
    finish() {
      const content = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, block]) => {
          if (block.type === "tool_use") {
            let input = block.input;
            const parsed = safeJson(block.inputJson);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
            return { type: "tool_use", id: block.id, name: block.name, input };
          }
          if (block.type === "thinking") {
            return { type: "thinking", thinking: block.thinking };
          }
          return { type: "text", text: block.text };
        });
      return {
        type: "message",
        content,
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
      };
    },
  };
}

function createGeminiAccumulator(onEvent) {
  let text = "";
  let thinking = "";
  let usageMetadata;
  const calls = new Map();
  const callOrder = [];
  return {
    push(_event, payload) {
      if (!payload || typeof payload !== "object") return;
      if (payload.usageMetadata) usageMetadata = payload.usageMetadata;
      for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
        if (typeof part?.text === "string") {
          if (part.thought === true) {
            thinking += part.text;
            emit(onEvent, { type: "reasoning_delta", text: part.text });
          } else {
            text += part.text;
            emit(onEvent, { type: "text_delta", text: part.text });
          }
        }
        const functionCall = part?.functionCall;
        if (functionCall && typeof functionCall.name === "string") {
          const key = normalizeCallKey(functionCall.id, `gemini-call-${callOrder.length + 1}`);
          if (!calls.has(key)) {
            calls.set(key, {
              id: functionCall.id ?? key,
              name: functionCall.name,
              args: {},
            });
            callOrder.push(key);
          }
          const call = calls.get(key);
          call.name = functionCall.name;
          if (functionCall.args && typeof functionCall.args === "object") {
            Object.assign(call.args, functionCall.args);
          }
        }
      }
    },
    finish() {
      const parts = [];
      if (thinking !== "") parts.push({ text: thinking, thought: true });
      if (text !== "") parts.push({ text });
      for (const key of callOrder) {
        const call = calls.get(key);
        if (call?.name) parts.push({ functionCall: { id: call.id, name: call.name, args: call.args } });
      }
      return {
        candidates: [{ content: { role: "model", parts } }],
        ...(usageMetadata ? { usageMetadata } : {}),
      };
    },
  };
}

function createAccumulator(protocol, onEvent) {
  if (protocol === "openai-responses") return createResponsesAccumulator(onEvent);
  if (protocol === "openai-chat-completions") return createChatAccumulator(onEvent);
  if (protocol === "anthropic-messages") return createAnthropicAccumulator(onEvent);
  return createGeminiAccumulator(onEvent);
}

export async function readProviderResponse(response, { protocol, onEvent, signal } = {}) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    return response.json();
  }

  const accumulator = createAccumulator(protocol, onEvent);
  for await (const frame of readSseFrames(response.body, signal)) {
    if (frame.data === "[DONE]") continue;
    const payload = safeJson(frame.data);
    if (payload === null) {
      throw new Error("上游事件流包含无效 JSON。" );
    }
    if (frame.event === "error") {
      const message = typeof payload.error?.message === "string"
        ? payload.error.message
        : "模型提供方返回了流式错误。";
      const error = new Error(message);
      error.code = "PROVIDER_STREAM_ERROR";
      throw error;
    }
    accumulator.push(frame.event, payload);
  }
  return accumulator.finish();
}

export function streamingEndpoint(protocol, endpoint) {
  if (protocol !== "google-gemini") return endpoint;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }
  url.pathname = url.pathname.replace(/:generateContent$/i, ":streamGenerateContent");
  url.searchParams.set("alt", "sse");
  return url.toString();
}
