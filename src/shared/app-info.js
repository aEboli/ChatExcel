import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageManifest = require("../../package.json");

export const APP_NAME = "ChatExcel";
export const APP_VERSION = packageManifest.version;
export const SERVICE_HOST = "127.0.0.1";
export const SERVICE_PORT = 3210;
export const SERVICE_ORIGIN = `https://${SERVICE_HOST}:${SERVICE_PORT}`;
