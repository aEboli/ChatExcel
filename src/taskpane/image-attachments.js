export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 1_500_000;
export const MAX_SOURCE_BYTES = 12_000_000;
export const MAX_IMAGE_EDGE = 1_600;

const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class AttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

export function dataUrlByteLength(dataUrl) {
  if (typeof dataUrl !== "string") return 0;
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return 0;
  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener(
      "error",
      () => reject(new AttachmentError("IMAGE_READ_FAILED", "无法读取所选图片。")),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new AttachmentError("IMAGE_DECODE_FAILED", "所选文件不是有效图片。")),
      { once: true },
    );
    image.src = dataUrl;
  });
}

function renderCompressed(image, width, height, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new AttachmentError("IMAGE_PROCESSING_UNAVAILABLE", "当前任务窗格无法处理图片。" );
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", quality);
}

export async function prepareImageFile(file) {
  if (!file || !SUPPORTED_TYPES.has(file.type)) {
    throw new AttachmentError("IMAGE_TYPE_UNSUPPORTED", "只支持 PNG、JPEG 或 WebP 图片。" );
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_SOURCE_BYTES) {
    throw new AttachmentError("IMAGE_SOURCE_TOO_LARGE", "单张原图不能超过 12 MB。" );
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const initialScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  if (
    initialScale === 1 &&
    dataUrlByteLength(sourceDataUrl) <= MAX_ATTACHMENT_BYTES
  ) {
    return {
      id: globalThis.crypto?.randomUUID?.() ?? `image_${Date.now()}`,
      name: file.name || "图片",
      mimeType: file.type,
      dataUrl: sourceDataUrl,
      byteLength: dataUrlByteLength(sourceDataUrl),
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  }

  let scale = initialScale;
  let quality = 0.9;
  let dataUrl = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    dataUrl = renderCompressed(
      image,
      image.naturalWidth * scale,
      image.naturalHeight * scale,
      quality,
    );
    if (dataUrlByteLength(dataUrl) <= MAX_ATTACHMENT_BYTES) break;
    scale *= 0.82;
    quality = Math.max(0.68, quality - 0.04);
  }
  const byteLength = dataUrlByteLength(dataUrl);
  if (byteLength === 0 || byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError("IMAGE_COMPRESSION_FAILED", "图片压缩后仍超过 1.5 MB。" );
  }
  const resultWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const resultHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `image_${Date.now()}`,
    name: file.name || "图片",
    mimeType: "image/webp",
    dataUrl,
    byteLength,
    width: resultWidth,
    height: resultHeight,
  };
}

export function formatAttachmentSize(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return "0 KB";
  return `${Math.max(1, Math.round(byteLength / 1024))} KB`;
}
