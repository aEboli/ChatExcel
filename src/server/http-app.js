import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { toPublicConfig } from "./config.js";
import { loadSystemConfig } from "./system-config.js";
import { APP_NAME, APP_VERSION, SERVICE_ORIGIN, SERVICE_PORT } from "../shared/app-info.js";
import { createLegacyWorkbookBridge } from "./legacy-workbook-bridge.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, "..", "..");
const defaultAllowedHosts = new Set([`localhost:${SERVICE_PORT}`, `127.0.0.1:${SERVICE_PORT}`]);
const defaultAllowedOrigins = new Set([SERVICE_ORIGIN, `https://127.0.0.1:${SERVICE_PORT}`]);

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' https://appsforoffice.microsoft.com",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const recoveryNotices = new Set([
  "model_request_interrupted",
  "tool_execution_interrupted",
]);

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizedHeader(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function errorBody(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function wantsEventStream(req) {
  return req.get("accept")?.toLowerCase().includes("text/event-stream") === true;
}

function streamError(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
  const message = error?.expose === true && error instanceof Error
    ? error.message
    : statusCode >= 500
      ? "本地服务处理请求失败。"
      : error instanceof Error
        ? error.message
        : "请求失败。";
  return {
    statusCode,
    body: errorBody(code, message, {
      ...(error?.recoverableSession === true ? { recoverableSession: true } : {}),
    }),
  };
}

function writeStreamEvent(res, event, payload) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

async function sendSessionResponse(req, res, operation, { statusCode = 200, onDisconnect } = {}) {
  if (!wantsEventStream(req)) {
    const result = await operation();
    res.status(statusCode).json({ ok: true, ...result });
    return;
  }

  res.status(200).set({
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const handleClose = () => {
    if (!res.writableEnded) onDisconnect?.();
  };
  res.once("close", handleClose);
  try {
    const result = await operation((event) => writeStreamEvent(res, "delta", event));
    writeStreamEvent(res, "result", result);
    writeStreamEvent(res, "done", { ok: true });
  } catch (error) {
    writeStreamEvent(res, "error", streamError(error).body);
  } finally {
    res.off("close", handleClose);
    if (!res.writableEnded) res.end();
  }
}

function requireJson(req, _res, next) {
  if (!req.is(["application/json", "application/*+json"])) {
    next(new HttpError(415, "CONTENT_TYPE_REQUIRED", "此接口只接受 JSON 请求。"));
    return;
  }
  next();
}

function noStore(_req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

function requireAllowedOrigin(allowedOrigins, { allowMissing = false } = {}) {
  return (req, _res, next) => {
    const origin = req.get("origin");
    if (!origin && allowMissing) {
      next();
      return;
    }

    if (!origin || !allowedOrigins.has(origin)) {
      next(new HttpError(403, "ORIGIN_FORBIDDEN", "请求来源不受本地加载项信任。"));
      return;
    }
    next();
  };
}

function requireSessionManager(sessionManager) {
  if (!sessionManager) {
    throw new HttpError(503, "AGENT_UNAVAILABLE", "Agent 会话服务尚未就绪。" );
  }
  return sessionManager;
}

function suspendOrCancelSession(sessionManager, sessionId) {
  const action = typeof sessionManager.suspend === "function"
    ? sessionManager.suspend
    : sessionManager.cancel;
  if (typeof action === "function") {
    void Promise.resolve()
      .then(() => action.call(sessionManager, sessionId))
      .catch(() => {});
  }
}

function recoveryPresentationMessages(presentation) {
  if (!Array.isArray(presentation?.messages)) return [];
  return presentation.messages.flatMap((message) => {
    if (
      (message?.role !== "user" && message?.role !== "assistant") ||
      typeof message.text !== "string"
    ) {
      return [];
    }
    return [{ role: message.role, text: message.text }];
  });
}

function publicRecoveryPayload(restored) {
  if (!restored || typeof restored.sessionId !== "string") {
    const status = restored?.recovery?.status;
    return {
      status: status === "expired" || status === "unavailable" ? status : "missing",
    };
  }
  const notice = recoveryNotices.has(restored.recovery?.notice)
    ? restored.recovery.notice
    : null;
  return {
    status: "available",
    sessionId: restored.sessionId,
    presentationMessages: recoveryPresentationMessages(restored.presentation),
    interrupted: notice !== null,
    notice,
  };
}

function requireRuntimeConfigStore(runtimeConfigStore) {
  if (!runtimeConfigStore) {
    throw new HttpError(503, "SETTINGS_UNAVAILABLE", "运行时配置服务尚未就绪。" );
  }
  return runtimeConfigStore;
}

export function createApp({
  configLoader = loadSystemConfig,
  runtimeConfigStore,
  sessionManager,
  legacyWorkbookBridge = createLegacyWorkbookBridge(),
  allowedHosts = defaultAllowedHosts,
  allowedOrigins = defaultAllowedOrigins,
  taskpaneDirectory = resolve(projectRoot, "src", "taskpane"),
  sharedDirectory = resolve(projectRoot, "src", "shared"),
  assetsDirectory = resolve(projectRoot, "assets"),
} = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const host = normalizedHeader(req.get("host"));
    if (!allowedHosts.has(host)) {
      res.status(421).json(errorBody("HOST_FORBIDDEN", "请求 Host 不受本地服务信任。"));
      return;
    }

    res.set({
      "Content-Security-Policy": contentSecurityPolicy,
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      service: APP_NAME,
      version: APP_VERSION,
      capabilities: ["office-addin", "native-xls"],
    });
  });

  app.get(
    "/api/config",
    requireAllowedOrigin(allowedOrigins, { allowMissing: true }),
    async (_req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        const state = runtimeConfigStore
          ? await runtimeConfigStore.getPublicState()
          : { source: "system", config: toPublicConfig(await configLoader()), models: [] };
        res.json({ ok: true, ...state });
      } catch (error) {
        res.json(
          errorBody(
            typeof error?.code === "string" ? error.code : "CONFIG_INVALID",
            error instanceof Error ? error.message : "Codex 配置不可用。",
          ),
        );
      }
    },
  );

  const settingsJson = express.json({ limit: "64kb", strict: true });
  const agentJson = express.json({ limit: "8mb", strict: true });
  const toolResultsJson = express.json({ limit: "512kb", strict: true });
  const legacyJson = express.json({ limit: "512kb", strict: true });

  app.post(
    "/api/settings",
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    settingsJson,
    async (req, res) => {
      const store = requireRuntimeConfigStore(runtimeConfigStore);
      const state = await store.update(req.body);
      res.json({ ok: true, ...state });
    },
  );

  app.post(
    "/api/settings/approval-mode",
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    settingsJson,
    async (req, res) => {
      const store = requireRuntimeConfigStore(runtimeConfigStore);
      const state = await store.updateApprovalMode(req.body?.approvalMode);
      res.json({ ok: true, ...state });
    },
  );

  app.post(
    "/api/models",
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    settingsJson,
    async (req, res) => {
      const store = requireRuntimeConfigStore(runtimeConfigStore);
      const result = await store.discoverModels(req.body);
      res.json({ ok: true, ...result });
    },
  );

  app.post(
    "/api/provider-connectivity",
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    settingsJson,
    async (_req, res) => {
      const store = requireRuntimeConfigStore(runtimeConfigStore);
      const connectivity = await store.probeCurrentProvider();
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, connectivity });
    },
  );

  app.post(
    "/api/sessions",
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    agentJson,
    async (req, res) => {
      const manager = requireSessionManager(sessionManager);
      const sessionId = req.body?.sessionId ?? randomUUID();
      await sendSessionResponse(
        req,
        res,
        (onEvent) => manager.start(
          req.body?.message,
          sessionId,
          {
            attachments: req.body?.attachments,
            model: req.body?.model,
            reasoningEffort: req.body?.reasoningEffort,
            workbookBinding: req.body?.workbookBinding,
          },
          { onEvent },
        ),
        { statusCode: 201, onDisconnect: () => suspendOrCancelSession(manager, sessionId) },
      );
    },
  );

  app.post(
    "/api/sessions/:sessionId/messages",
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    agentJson,
    async (req, res) => {
      const manager = requireSessionManager(sessionManager);
      await sendSessionResponse(
        req,
        res,
        (onEvent) => manager.addMessage(
          req.params.sessionId,
          req.body?.message,
          {
            attachments: req.body?.attachments,
            model: req.body?.model,
            reasoningEffort: req.body?.reasoningEffort,
            workbookBinding: req.body?.workbookBinding,
          },
          { onEvent },
        ),
        { onDisconnect: () => suspendOrCancelSession(manager, req.params.sessionId) },
      );
    },
  );

  app.post(
    "/api/sessions/:sessionId/tool-results",
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    toolResultsJson,
    async (req, res) => {
      const manager = requireSessionManager(sessionManager);
      await sendSessionResponse(
        req,
        res,
        (onEvent) => manager.submitToolResults(
          req.params.sessionId,
          req.body?.results,
          { onEvent },
        ),
        { onDisconnect: () => suspendOrCancelSession(manager, req.params.sessionId) },
      );
    },
  );

  app.post(
    "/api/conversation-recovery/restore",
    noStore,
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    settingsJson,
    async (req, res) => {
      const manager = requireSessionManager(sessionManager);
      const restored = await manager.restore(req.body?.workbookBinding);
      res.json({ ok: true, recovery: publicRecoveryPayload(restored) });
    },
  );

  app.post(
    "/api/conversation-recovery/touch",
    noStore,
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    settingsJson,
    async (req, res) => {
      const manager = requireSessionManager(sessionManager);
      const touched = await manager.touchRecovery(req.body?.sessionId, req.body?.workbookBinding);
      const status = typeof touched === "object" && touched !== null
        ? touched.status
        : touched ? "touched" : "missing";
      res.json({
        ok: true,
        active: {
          status: ["touched", "expired", "unavailable"].includes(status) ? status : "missing",
        },
      });
    },
  );

  app.delete(
    "/api/conversation-recovery/:sessionId",
    noStore,
    requireAllowedOrigin(allowedOrigins),
    async (req, res) => {
      const manager = requireSessionManager(sessionManager);
      await manager.clearRecoverySession(req.params.sessionId);
      res.status(204).end();
    },
  );

  app.delete(
    "/api/sessions/:sessionId",
    requireAllowedOrigin(allowedOrigins),
    async (req, res) => {
      const manager = requireSessionManager(sessionManager);
      res.set("Cache-Control", "no-store");
      await manager.cancel(req.params.sessionId);
      res.status(204).end();
    },
  );

  app.post(
    "/api/legacy/:sessionId",
    requireAllowedOrigin(allowedOrigins),
    requireJson,
    legacyJson,
    async (req, res) => {
      const result = await legacyWorkbookBridge.request(req.params.sessionId, req.body);
      if (result?.ok === false) {
        res.status(422).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.use("/api", (_req, res) => {
    res.status(404).json(errorBody("API_NOT_FOUND", "本地服务不存在此 API。"));
  });

  const staticOptions = {
    fallthrough: false,
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders(res) {
      res.set("Cache-Control", "no-store");
    },
  };
  app.use("/assets", express.static(assetsDirectory, staticOptions));
  app.use("/shared", express.static(sharedDirectory, staticOptions));
  app.use(express.static(taskpaneDirectory, { ...staticOptions, fallthrough: true }));
  app.get("/", (_req, res) => res.redirect(302, "/taskpane.html"));

  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.status(404).type("text/plain").send("Not found");
  });

  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") {
      res.status(413).json(errorBody("REQUEST_TOO_LARGE", "JSON 请求体超过当前接口限制。"));
      return;
    }

    if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
      res.status(400).json(errorBody("JSON_INVALID", "JSON 请求体无法解析。"));
      return;
    }

    if (error instanceof HttpError) {
      res.status(error.statusCode).json(errorBody(error.code, error.message));
      return;
    }

    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
    const message =
      error?.expose === true && error instanceof Error
        ? error.message
        : statusCode >= 500
          ? "本地服务处理请求失败。"
          : error instanceof Error
            ? error.message
            : "请求失败。";
    res.status(statusCode).json(errorBody(code, message, {
      ...(error?.recoverableSession === true ? { recoverableSession: true } : {}),
    }));
  });

  return app;
}
