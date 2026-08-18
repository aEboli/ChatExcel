export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 1_500_000;
export const MAX_SOURCE_BYTES = 12_000_000;
export const MAX_IMAGE_EDGE = 1_600;

const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export class AttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

function normalizedImageType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  return SUPPORTED_TYPES.has(type) ? type : null;
}

function base64ByteLength(value) {
  const base64 = String(value ?? "").replace(/\s+/g, "");
  if (base64 === "" || !BASE64_PATTERN.test(base64) || base64.length % 4 === 1) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

export function dataUrlByteLength(dataUrl) {
  if (typeof dataUrl !== "string") return 0;
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0 || !/^[^,;]+(?:;[^,;]+)*;base64$/i.test(dataUrl.slice(0, commaIndex))) {
    return 0;
  }
  return base64ByteLength(dataUrl.slice(commaIndex + 1));
}

function dataUrlMimeType(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,/i.exec(dataUrl);
  return match ? match[1].toLowerCase() : null;
}

function addEventListener(target, type, listener) {
  if (typeof target?.addEventListener === "function") {
    target.addEventListener(type, listener, { once: true });
    return;
  }
  target[`on${type}`] = listener;
}

function readFileAsDataUrl(file, FileReaderCtor = globalThis.FileReader) {
  if (typeof FileReaderCtor !== "function") {
    return Promise.reject(new AttachmentError("IMAGE_READ_UNAVAILABLE", "当前任务窗格无法读取图片。"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (callback) => (event) => {
      if (settled) return;
      settled = true;
      callback(event);
    };
    const reader = new FileReaderCtor();
    addEventListener(reader, "load", complete((event) => {
      const result = event?.target?.result ?? reader.result;
      if (typeof result !== "string" || dataUrlMimeType(result) === null) {
        reject(new AttachmentError("IMAGE_READ_FAILED", "无法读取所选图片。"));
        return;
      }
      resolve(result);
    }));
    addEventListener(reader, "error", complete(() => {
      reject(new AttachmentError("IMAGE_READ_FAILED", "无法读取所选图片。"));
    }));
    addEventListener(reader, "abort", complete(() => {
      reject(new AttachmentError("IMAGE_READ_FAILED", "读取图片已取消。"));
    }));
    try {
      reader.readAsDataURL(file);
    } catch {
      if (!settled) {
        settled = true;
        reject(new AttachmentError("IMAGE_READ_FAILED", "无法读取所选图片。"));
      }
    }
  });
}

function loadImage(dataUrl, ImageCtor = globalThis.Image) {
  if (typeof ImageCtor !== "function") {
    return Promise.reject(new AttachmentError("IMAGE_DECODE_UNAVAILABLE", "当前任务窗格无法解码图片。"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (callback) => (event) => {
      if (settled) return;
      settled = true;
      callback(event);
    };
    let image;
    try {
      image = new ImageCtor();
    } catch {
      reject(new AttachmentError("IMAGE_DECODE_UNAVAILABLE", "当前任务窗格无法解码图片。"));
      return;
    }
    addEventListener(image, "load", complete(() => {
      const width = Number(image.naturalWidth ?? image.width);
      const height = Number(image.naturalHeight ?? image.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        reject(new AttachmentError("IMAGE_DECODE_FAILED", "所选文件不是有效图片。"));
        return;
      }
      resolve({ image, width, height });
    }));
    addEventListener(image, "error", complete(() => {
      reject(new AttachmentError("IMAGE_DECODE_FAILED", "所选文件不是有效图片。"));
    }));
    try {
      image.src = dataUrl;
    } catch {
      if (!settled) {
        settled = true;
        reject(new AttachmentError("IMAGE_DECODE_FAILED", "所选文件不是有效图片。"));
      }
    }
  });
}

function renderCompressed(image, width, height, quality, documentRef = globalThis.document) {
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw new AttachmentError("IMAGE_PROCESSING_UNAVAILABLE", "当前任务窗格无法处理图片。");
  }
  const canvas = documentRef.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  let context;
  try {
    context = canvas.getContext("2d", { alpha: false });
  } catch {
    context = null;
  }
  if (!context) {
    throw new AttachmentError("IMAGE_PROCESSING_UNAVAILABLE", "当前任务窗格无法处理图片。");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let dataUrl;
  try {
    dataUrl = canvas.toDataURL("image/webp", quality);
  } catch {
    throw new AttachmentError("IMAGE_COMPRESSION_FAILED", "图片压缩失败。");
  }
  if (dataUrlMimeType(dataUrl) === null || dataUrlByteLength(dataUrl) === 0) {
    throw new AttachmentError("IMAGE_COMPRESSION_FAILED", "图片压缩失败。");
  }
  return dataUrl;
}

function attachmentId() {
  return globalThis.crypto?.randomUUID?.() ?? `image_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function attachmentName(file) {
  const name = typeof file?.name === "string" ? file.name.trim() : "";
  return name.slice(0, 160) || "图片";
}

export async function prepareImageFile(
  file,
  { FileReaderCtor = globalThis.FileReader, ImageCtor = globalThis.Image, documentRef = globalThis.document } = {},
) {
  const mimeType = normalizedImageType(file?.type);
  if (!mimeType) {
    throw new AttachmentError("IMAGE_TYPE_UNSUPPORTED", "只支持 PNG、JPEG 或 WebP 图片。");
  }
  if (!Number.isFinite(file?.size) || file.size <= 0 || file.size > MAX_SOURCE_BYTES) {
    throw new AttachmentError("IMAGE_SOURCE_TOO_LARGE", "单张原图不能超过 12 MB。");
  }

  const sourceDataUrl = await readFileAsDataUrl(file, FileReaderCtor);
  const sourceMimeType = dataUrlMimeType(sourceDataUrl);
  if (sourceMimeType !== mimeType || dataUrlByteLength(sourceDataUrl) === 0) {
    throw new AttachmentError("IMAGE_READ_FAILED", "无法读取所选图片。");
  }
  const { image, width, height } = await loadImage(sourceDataUrl, ImageCtor);
  const initialScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  const sourceByteLength = dataUrlByteLength(sourceDataUrl);
  if (initialScale === 1 && sourceByteLength <= MAX_ATTACHMENT_BYTES) {
    return {
      id: attachmentId(),
      name: attachmentName(file),
      mimeType,
      dataUrl: sourceDataUrl,
      byteLength: sourceByteLength,
      width,
      height,
    };
  }

  let scale = initialScale;
  let quality = 0.9;
  let dataUrl = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    dataUrl = renderCompressed(image, width * scale, height * scale, quality, documentRef);
    if (dataUrlByteLength(dataUrl) <= MAX_ATTACHMENT_BYTES) break;
    scale *= 0.82;
    quality = Math.max(0.68, quality - 0.04);
  }
  const byteLength = dataUrlByteLength(dataUrl);
  if (byteLength === 0 || byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError("IMAGE_COMPRESSION_FAILED", "图片压缩后仍超过 1.5 MB。");
  }
  return {
    id: attachmentId(),
    name: attachmentName(file),
    mimeType: dataUrlMimeType(dataUrl),
    dataUrl,
    byteLength,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function clipboardFileSignature(file) {
  const size = Number.isFinite(file?.size) ? file.size : null;
  const name = typeof file?.name === "string" ? file.name : "";
  const lastModified = Number.isFinite(file?.lastModified) ? file.lastModified : null;
  if (size === null && name === "" && lastModified === null) return null;
  return [String(file?.type ?? "").trim().toLowerCase(), size ?? "", name, lastModified ?? ""].join("\u0000");
}

export function clipboardImageFiles(clipboardData) {
  const result = [];
  const seenObjects = new Set();
  const seenSignatures = new Set();
  const add = (file) => {
    if (!file || typeof file !== "object" || !normalizedImageType(file.type)) return;
    const signature = clipboardFileSignature(file);
    if (seenObjects.has(file) || (signature !== null && seenSignatures.has(signature))) return;
    seenObjects.add(file);
    if (signature !== null) seenSignatures.add(signature);
    result.push(file);
  };

  const files = clipboardData?.files;
  if (files && typeof files.length === "number") {
    for (let index = 0; index < files.length; index += 1) add(files[index]);
  }
  const items = clipboardData?.items;
  if (items && typeof items.length === "number") {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.kind !== "file" || typeof item.getAsFile !== "function") continue;
      try {
        add(item.getAsFile());
      } catch {
        // A malformed clipboard item must not block text paste or other images.
      }
    }
  }
  return result;
}

export const getClipboardImageFiles = clipboardImageFiles;

export function transferHasFiles(transferData) {
  if (Number(transferData?.files?.length) > 0) return true;
  const types = transferData?.types;
  if (!types) return false;
  if (typeof types.contains === "function" && types.contains("Files")) return true;
  const length = Number(types.length);
  if (!Number.isSafeInteger(length) || length <= 0) return false;
  for (let index = 0; index < length; index += 1) {
    if (String(types[index] ?? "").toLowerCase() === "files") return true;
  }
  return false;
}

export function formatAttachmentSize(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return "0 KB";
  return `${Math.max(1, Math.round(byteLength / 1024))} KB`;
}
