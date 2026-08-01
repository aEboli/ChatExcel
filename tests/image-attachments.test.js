import assert from "node:assert/strict";
import test from "node:test";
import { dataUrlByteLength, formatAttachmentSize } from "../src/taskpane/image-attachments.js";

test("准确计算图片 data URL 的字节数", () => {
  const data = Buffer.from("annotated-image");
  const dataUrl = `data:image/png;base64,${data.toString("base64")}`;

  assert.equal(dataUrlByteLength(dataUrl), data.byteLength);
  assert.equal(formatAttachmentSize(1536), "2 KB");
});
