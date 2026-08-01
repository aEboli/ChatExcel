import assert from "node:assert/strict";
import test from "node:test";
import { parseRegistryExcelPath } from "../scripts/sideload.mjs";

test("从 App Paths 注册表输出解析 Microsoft Excel 路径", () => {
  const output = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\excel.exe
    (Default)    REG_SZ    C:\\Program Files\\Microsoft Office\\Root\\Office16\\EXCEL.EXE
`;
  assert.equal(
    parseRegistryExcelPath(output),
    "C:\\Program Files\\Microsoft Office\\Root\\Office16\\EXCEL.EXE",
  );
});

test("无默认路径时返回 null", () => {
  assert.equal(parseRegistryExcelPath("ERROR: The system was unable to find the key"), null);
});
