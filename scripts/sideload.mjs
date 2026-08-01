import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateSideloadFile,
  registerAddIn,
} from "office-addin-dev-settings";
import { OfficeAddinManifest, OfficeApp } from "office-addin-manifest";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(projectRoot, "manifest.xml");

export function parseRegistryExcelPath(output) {
  const match = String(output).match(/^\s*\(Default\)\s+REG_SZ\s+(.+?)\s*$/im);
  return match?.[1] ?? null;
}

function queryRegistryExcelPath(key) {
  try {
    const output = execFileSync("reg.exe", ["query", key, "/ve"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseRegistryExcelPath(output);
  } catch {
    return null;
  }
}

function findExcelExecutable() {
  const registryKeys = [
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\excel.exe",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\excel.exe",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\excel.exe",
  ];
  const candidates = registryKeys.map(queryRegistryExcelPath);
  for (const programFiles of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!programFiles) continue;
    candidates.push(path.join(programFiles, "Microsoft Office", "root", "Office16", "EXCEL.EXE"));
    candidates.push(path.join(programFiles, "Microsoft Office", "Office16", "EXCEL.EXE"));
  }

  const excelPath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!excelPath) {
    throw new Error("未找到 Microsoft Excel 桌面版。请先安装 Excel，再重新运行侧载命令。");
  }
  return excelPath;
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("当前侧载脚本只支持 Windows Microsoft Excel。");
  }

  await registerAddIn(manifestPath);
  const manifest = await OfficeAddinManifest.readManifestFile(manifestPath);
  const sideloadFile = await generateSideloadFile(OfficeApp.Excel, manifest);
  const excelPath = findExcelExecutable();
  const excel = spawn(excelPath, ["/x", sideloadFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  excel.unref();

  console.log(`已注册加载项并启动 Microsoft Excel：${sideloadFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
