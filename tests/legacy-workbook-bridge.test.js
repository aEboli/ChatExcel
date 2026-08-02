import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeLegacyMessage,
  legacyPipePath,
  normalizeLegacyRequest,
  validateLegacySessionId,
} from "../src/server/legacy-workbook-bridge.js";

const sessionId = "a".repeat(48);

test("原生会话只接受固定长度小写十六进制标识", () => {
  assert.equal(validateLegacySessionId(sessionId), sessionId);
  assert.match(legacyPipePath(sessionId), /ChatExcel-Legacy-/);
  assert.throws(() => validateLegacySessionId("A".repeat(48)), /无效/);
  assert.throws(() => validateLegacySessionId("a".repeat(47)), /无效/);
  assert.throws(() => validateLegacySessionId("../pipe"), /无效/);
});

test("原生 execute 请求复用 Excel 工具参数校验", () => {
  const request = normalizeLegacyRequest({
    action: "execute",
    name: "write_values",
    arguments: { worksheet: null, address: "A1:B1", values: [[1, 2]] },
  });

  assert.equal(request.action, "execute");
  assert.equal(request.name, "write_values");
  assert.deepEqual(request.arguments.values, [[1, 2]]);
  assert.throws(
    () => normalizeLegacyRequest({ action: "execute", name: "write_values", arguments: { address: "all" } }),
    /必填参数|类型不正确/,
  );
});

test("原生桥拒绝任意操作并使用长度前缀消息", () => {
  assert.throws(() => normalizeLegacyRequest({ action: "shell", command: "calc" }), /不受支持/);
  const encoded = encodeLegacyMessage({ action: "state" });
  assert.equal(encoded.readInt32LE(0), encoded.length - 4);
  assert.deepEqual(JSON.parse(encoded.subarray(4).toString("utf8")), { action: "state" });
});
