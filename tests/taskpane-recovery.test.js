import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [taskpaneHtml, taskpaneJs] = await Promise.all([
  readFile(new URL("../src/taskpane/taskpane.html", import.meta.url), "utf8"),
  readFile(new URL("../src/taskpane/taskpane.js", import.meta.url), "utf8"),
]);

test("任务窗格只通过恢复 API 读取展示消息并保持三十秒心跳", () => {
  assert.match(taskpaneJs, /restoreConversation: \(\{ workbookBinding \}\) => requestJson\("\/api\/conversation-recovery\/restore"/);
  assert.match(taskpaneJs, /touchConversation: \(\{ sessionId, workbookBinding \}\) => requestJson\("\/api\/conversation-recovery\/touch"/);
  assert.match(taskpaneJs, /clearConversation: \(\{ sessionId \}\) =>\s*requestJson\(`\/api\/conversation-recovery\/\$\{encodeURIComponent\(sessionId\)\}`/);
  assert.match(taskpaneJs, /const RECOVERY_HEARTBEAT_MS = 30_000;/);
  assert.match(taskpaneJs, /setInterval\(\(\) => void touchConversationRecovery\(\), RECOVERY_HEARTBEAT_MS\)/);
  assert.match(taskpaneJs, /recoveryPresentationMessages\(recovery\)[\s\S]*presentationMessages/);
  assert.doesNotMatch(taskpaneJs, /recovery\?\.snapshot|recovery\.snapshot/);
});

test("任务窗格恢复后明确不重放中断工作，并允许用户确认后清除", () => {
  assert.match(taskpaneHtml, /id="recovery-notice"/);
  assert.match(taskpaneHtml, /id="clear-recovery-button"/);
  assert.match(taskpaneJs, /不会自动重发模型请求或 Excel 修改/);
  assert.match(taskpaneJs, /async function clearRecoverySession\(\)/);
  assert.match(taskpaneJs, /await runner\.resetSession\(\);/);
  assert.match(taskpaneJs, /await api\.clearConversation\(\{ sessionId \}\);/);
  assert.match(taskpaneJs, /title: "清空恢复会话？"/);
});

test("恢复缓存不可用时保留当前会话并告知闪退风险", () => {
  const unavailableCase = taskpaneJs.match(/case "recovery_unavailable":([\s\S]*?)case "tool_pending":/);

  assert.ok(unavailableCase);
  assert.match(unavailableCase[1], /recoveryUnavailable = true;/);
  assert.match(
    unavailableCase[1],
    /本地恢复暂不可用，当前对话仍可继续但闪退后可能无法恢复。/,
  );
  assert.doesNotMatch(unavailableCase[1], /resetSession|sessionId\s*=\s*null/);
  assert.match(taskpaneJs, /currentRunOutcome === "success" && !recoveryUnavailable/);
  assert.match(taskpaneJs, /case "recovery_available":\s*recoveryUnavailable = false;/);
  assert.match(taskpaneJs, /active\?\.status === "unavailable"[\s\S]*?闪退后可能无法恢复/);
  assert.match(taskpaneJs, /active\?\.status === "touched"[\s\S]*?recoveryUnavailable = false;/);
});

test("工作簿标识准备完毕后才请求恢复，并把绑定交给会话请求", () => {
  assert.match(taskpaneJs, /await prepareWorkbookBinding\(\);\s*await restoreConversationRecovery\(\);/);
  assert.match(taskpaneJs, /workbookBinding: workbookBinding \?\? undefined/);
  assert.match(taskpaneJs, /workbookBindingFromDocumentUrl\(globalThis\.Office\?\.context\?\.document\?\.url\)/);
  assert.match(taskpaneJs, /return workbookBindingFromDocumentUrl\(globalThis\.Office\?\.context\?\.document\?\.url\);/);
  assert.doesNotMatch(taskpaneJs, /workbook-name:\$\{name\}/);
  assert.match(taskpaneJs, /recoveryDisabledForBinding = !workbookBinding && !previewMode;/);
  assert.match(taskpaneJs, /没有可验证的稳定标识，已关闭本地恢复/);
});
