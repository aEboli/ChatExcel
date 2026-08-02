import net from "node:net";
import { parseAndValidateToolArguments } from "../shared/excel-tools.js";

export const LEGACY_SESSION_PATTERN = /^[0-9a-f]{48}$/;
export const LEGACY_MAX_MESSAGE_BYTES = 512 * 1024;
const LEGACY_PIPE_PREFIX = "ChatExcel-Legacy-";
const LEGACY_ACTIONS = new Set(["state", "undo", "execute"]);

export class LegacyBridgeError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message, options);
    this.name = "LegacyBridgeError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

export function validateLegacySessionId(value) {
  if (typeof value !== "string" || !LEGACY_SESSION_PATTERN.test(value)) {
    throw new LegacyBridgeError(400, "LEGACY_SESSION_INVALID", "原生 XLS 会话标识无效。");
  }
  return value;
}

export function normalizeLegacyRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LegacyBridgeError(400, "LEGACY_REQUEST_INVALID", "原生 XLS 请求必须是 JSON 对象。");
  }
  if (!LEGACY_ACTIONS.has(body.action)) {
    throw new LegacyBridgeError(400, "LEGACY_ACTION_INVALID", "原生 XLS 操作不受支持。");
  }
  if (body.action === "execute") {
    if (typeof body.name !== "string") {
      throw new LegacyBridgeError(400, "LEGACY_TOOL_INVALID", "原生 XLS 工具名称无效。");
    }
    return {
      action: "execute",
      name: body.name,
      arguments: parseAndValidateToolArguments(body.name, body.arguments),
    };
  }
  return { action: body.action };
}

export function legacyPipePath(sessionId) {
  return `\\\\.\\pipe\\${LEGACY_PIPE_PREFIX}${validateLegacySessionId(sessionId)}`;
}

export function encodeLegacyMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length === 0 || body.length > LEGACY_MAX_MESSAGE_BYTES) {
    throw new LegacyBridgeError(413, "LEGACY_REQUEST_TOO_LARGE", "原生 XLS 请求超过尺寸限制。");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function createLegacyWorkbookBridge({ connect = net.createConnection, timeoutMs = 8_000 } = {}) {
  return {
    async request(sessionId, body) {
      if (process.platform !== "win32") {
        throw new LegacyBridgeError(501, "LEGACY_PLATFORM_UNSUPPORTED", "原生 XLS 引擎只支持 Windows。");
      }
      const pipePath = legacyPipePath(sessionId);
      const message = encodeLegacyMessage(normalizeLegacyRequest(body));
      return new Promise((resolve, reject) => {
        let settled = false;
        let expectedLength = null;
        let buffered = Buffer.alloc(0);
        const socket = connect(pipePath);
        const timer = setTimeout(() => {
          finish(new LegacyBridgeError(504, "LEGACY_BRIDGE_TIMEOUT", "Excel 原生引擎响应超时。"));
          socket.destroy();
        }, timeoutMs);

        function finish(error, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        }

        socket.once("connect", () => socket.write(message));
        socket.on("data", (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          if (expectedLength === null && buffered.length >= 4) {
            expectedLength = buffered.readInt32LE(0);
            buffered = buffered.subarray(4);
            if (expectedLength <= 0 || expectedLength > LEGACY_MAX_MESSAGE_BYTES) {
              finish(new LegacyBridgeError(502, "LEGACY_RESPONSE_INVALID", "Excel 原生引擎返回了无效消息尺寸。"));
              socket.destroy();
              return;
            }
          }
          if (expectedLength !== null && buffered.length >= expectedLength) {
            if (buffered.length !== expectedLength) {
              finish(new LegacyBridgeError(502, "LEGACY_RESPONSE_INVALID", "Excel 原生引擎返回了多余数据。"));
              socket.destroy();
              return;
            }
            try {
              const payload = JSON.parse(buffered.toString("utf8"));
              finish(null, payload);
            } catch (error) {
              finish(new LegacyBridgeError(502, "LEGACY_RESPONSE_INVALID", "Excel 原生引擎返回了无效 JSON。", { cause: error }));
            } finally {
              socket.end();
            }
          }
        });
        socket.once("error", (error) => {
          const unavailable = error?.code === "ENOENT" || error?.code === "ECONNREFUSED";
          finish(new LegacyBridgeError(
            unavailable ? 410 : 502,
            unavailable ? "LEGACY_SESSION_UNAVAILABLE" : "LEGACY_BRIDGE_ERROR",
            unavailable ? "原生 XLS 会话已关闭或不可用。" : "无法连接 Excel 原生引擎。",
            { cause: error },
          ));
        });
        socket.once("end", () => {
          if (!settled) finish(new LegacyBridgeError(502, "LEGACY_RESPONSE_INCOMPLETE", "Excel 原生引擎响应不完整。"));
        });
      });
    },
  };
}
