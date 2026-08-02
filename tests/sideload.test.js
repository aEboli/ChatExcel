import assert from "node:assert/strict";
import test from "node:test";
import { parseRegistryExcelPath, parseSideloadArguments } from "../scripts/sideload.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("现代工作簿参数只接受单个受支持文件", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatexcel-sideload-"));
  const workbook = join(directory, "测试.xlsm");
  writeFileSync(workbook, "fixture");

  assert.equal(parseSideloadArguments([]).workbookPath, null);
  assert.equal(parseSideloadArguments(["--workbook", workbook]).workbookPath, workbook);
  assert.throws(() => parseSideloadArguments(["--workbook", join(directory, "missing.xlsx")]), /找不到/);
  assert.throws(() => parseSideloadArguments(["--workbook", workbook, "extra"]), /只接受/);
});

test("Office 侧载路径拒绝旧版 xls", () => {
  const directory = mkdtempSync(join(tmpdir(), "chatexcel-sideload-"));
  const workbook = join(directory, "旧版.xls");
  writeFileSync(workbook, "fixture");

  assert.throws(() => parseSideloadArguments(["--workbook", workbook]), /只支持/);
});
