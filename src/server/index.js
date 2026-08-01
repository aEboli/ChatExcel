import https from "node:https";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "./http-app.js";
import { createResponsesClient } from "./responses-client.js";
import { RuntimeConfigStore } from "./runtime-config.js";
import { SessionManager } from "./session-manager.js";
import { APP_NAME, SERVICE_HOST, SERVICE_ORIGIN, SERVICE_PORT } from "../shared/app-info.js";

async function main() {
  const certificateDirectory = join(homedir(), ".office-addin-dev-certs");
  let httpsOptions;
  try {
    httpsOptions = {
      ca: await readFile(join(certificateDirectory, "ca.crt")),
      cert: await readFile(join(certificateDirectory, "localhost.crt")),
      key: await readFile(join(certificateDirectory, "localhost.key")),
    };
  } catch (error) {
    throw new Error("无法读取 Office 本地开发证书，请先运行 npm run certs:install。", {
      cause: error,
    });
  }
  const runtimeConfigStore = new RuntimeConfigStore();
  const sessionManager = new SessionManager({
    maxStepsProvider: () => runtimeConfigStore.getMaxSteps(),
    responsesClient: createResponsesClient({
      configLoader: (options) => runtimeConfigStore.loadConfig(options),
    }),
  });
  const server = https.createServer(
    httpsOptions,
    createApp({ sessionManager, runtimeConfigStore }),
  );

  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(`端口 ${SERVICE_PORT} 已被占用；请先运行 npm run stop:local。`);
    } else {
      console.error(`${APP_NAME} 启动失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
    process.exitCode = 1;
  });

  server.listen(SERVICE_PORT, SERVICE_HOST, () => {
    console.log(`${APP_NAME} 已启动：${SERVICE_ORIGIN}`);
  });

  const shutdown = () => {
    sessionManager.dispose();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`${APP_NAME} 启动失败：${error instanceof Error ? error.message : "未知错误"}`);
  process.exitCode = 1;
});
