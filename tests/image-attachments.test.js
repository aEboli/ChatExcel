import assert from "node:assert/strict";
import test from "node:test";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_EDGE,
  MAX_SOURCE_BYTES,
  clipboardImageFiles,
  dataUrlByteLength,
  formatAttachmentSize,
  prepareImageFile,
} from "../src/taskpane/image-attachments.js";

function dataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function browserMocks({ width = 800, height = 600, compressedDataUrl = dataUrl("image/webp", "compressed") } = {}) {
  class FakeFileReader {
    addEventListener(type, listener) {
      this.listeners ??= {};
      this.listeners[type] = listener;
    }

    readAsDataURL(file) {
      queueMicrotask(() => this.listeners.load({ target: { result: file.dataUrl } }));
    }
  }

  class FakeImage {
    addEventListener(type, listener) {
      this.listeners ??= {};
      this.listeners[type] = listener;
    }

    set src(value) {
      this.source = value;
      this.naturalWidth = width;
      this.naturalHeight = height;
      queueMicrotask(() => this.listeners.load({ target: this }));
    }
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        fillStyle: "",
        fillRect() {},
        drawImage() {},
      };
    },
    toDataURL() {
      return compressedDataUrl;
    },
  };

  return {
    FileReaderCtor: FakeFileReader,
    ImageCtor: FakeImage,
    documentRef: { createElement: () => canvas },
    canvas,
  };
}

test("准确计算图片 data URL 的字节数和显示大小", () => {
  const data = Buffer.from("annotated-image");
  const dataUrlValue = dataUrl("image/png", data);

  assert.equal(dataUrlByteLength(dataUrlValue), data.byteLength);
  assert.equal(dataUrlByteLength("data:image/png;base64,%%%"), 0);
  assert.equal(dataUrlByteLength("data:image/png,plain-text"), 0);
  assert.equal(formatAttachmentSize(1536), "2 KB");
  assert.equal(formatAttachmentSize(0), "0 KB");
});

test("从剪贴板 files 和 items 读取图片并去重，只保留支持类型", () => {
  const png = { type: "image/png", size: 10, name: "mark.png", lastModified: 1 };
  const jpeg = { type: "image/jpeg", size: 20, name: "photo.jpg", lastModified: 2 };
  const unsupported = { type: "image/gif", size: 30, name: "ignore.gif" };
  const files = clipboardImageFiles({
    files: [png, unsupported],
    items: [
      { kind: "file", type: "image/png", getAsFile: () => ({ ...png }) },
      { kind: "file", type: "image/jpeg", getAsFile: () => jpeg },
      { kind: "file", type: "image/png", getAsFile: () => { throw new Error("clipboard unavailable"); } },
      { kind: "string", type: "text/plain", getAsFile: () => unsupported },
    ],
  });

  assert.deepEqual(files, [png, jpeg]);
});

test("小图片保留原始 data URL 并返回完整元数据", async () => {
  const sourceDataUrl = dataUrl("image/png", "small-image");
  const result = await prepareImageFile(
    { type: "image/png", size: 11, name: "标注.png", dataUrl: sourceDataUrl },
    browserMocks({ width: 800, height: 600 }),
  );

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.dataUrl, sourceDataUrl);
  assert.equal(result.byteLength, Buffer.byteLength("small-image"));
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.equal(result.name, "标注.png");
  assert.equal(typeof result.id, "string");
  assert.notEqual(result.id, "");
});

test("超大尺寸图片压缩到边长上限并返回 WebP 元数据", async () => {
  const result = await prepareImageFile(
    { type: "image/jpeg", size: 1_000, name: "large.jpg", dataUrl: dataUrl("image/jpeg", "source") },
    browserMocks({ width: 3_200, height: 1_600 }),
  );

  assert.equal(result.mimeType, "image/webp");
  assert.equal(result.dataUrl.startsWith("data:image/webp;base64,"), true);
  assert.equal(result.width, MAX_IMAGE_EDGE);
  assert.equal(result.height, MAX_IMAGE_EDGE / 2);
  assert.equal(result.byteLength <= MAX_ATTACHMENT_BYTES, true);
});

test("拒绝不支持格式、原图超限和无效 data URL", async () => {
  const acceptedAtSourceLimit = await prepareImageFile(
    {
      type: "image/png",
      size: MAX_SOURCE_BYTES,
      name: "at-limit.png",
      dataUrl: dataUrl("image/png", "source-at-limit"),
    },
    browserMocks(),
  );
  assert.equal(acceptedAtSourceLimit.byteLength, Buffer.byteLength("source-at-limit"));

  await assert.rejects(
    () => prepareImageFile({ type: "image/gif", size: 10, name: "bad.gif" }, browserMocks()),
    (error) => error instanceof AttachmentError && error.code === "IMAGE_TYPE_UNSUPPORTED",
  );
  await assert.rejects(
    () => prepareImageFile({ type: "image/png", size: MAX_SOURCE_BYTES + 1, name: "huge.png" }, browserMocks()),
    (error) => error instanceof AttachmentError && error.code === "IMAGE_SOURCE_TOO_LARGE",
  );
  await assert.rejects(
    () => prepareImageFile({ type: "image/png", size: 10, name: "broken.png", dataUrl: "data:image/png;base64,%%%" }, browserMocks()),
    (error) => error instanceof AttachmentError && error.code === "IMAGE_READ_FAILED",
  );
});
