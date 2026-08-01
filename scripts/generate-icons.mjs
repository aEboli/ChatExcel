import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, "..", "assets");
const sizes = [16, 32, 64, 80];

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function setPixel(pixels, size, x, y, color) {
  if (x < 0 || x >= size || y < 0 || y >= size) {
    return;
  }

  const offset = (y * size + x) * 4;
  pixels.set(color, offset);
}

function fillRect(pixels, size, left, top, width, height, color) {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      setPixel(pixels, size, x, y, color);
    }
  }
}

function makeIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const green = [16, 124, 65, 255];
  const darkGreen = [10, 94, 47, 255];
  const white = [255, 255, 255, 255];
  const mint = [184, 234, 204, 255];
  const accent = [255, 196, 61, 255];

  fillRect(pixels, size, 0, 0, size, size, green);
  fillRect(pixels, size, 0, Math.floor(size * 0.72), size, Math.ceil(size * 0.28), darkGreen);

  const margin = Math.max(2, Math.round(size * 0.18));
  const gridTop = Math.max(2, Math.round(size * 0.2));
  const gridWidth = size - margin * 2;
  const gridHeight = Math.max(6, Math.round(size * 0.5));
  const line = Math.max(1, Math.round(size / 24));

  fillRect(pixels, size, margin, gridTop, gridWidth, gridHeight, white);
  fillRect(
    pixels,
    size,
    margin + line,
    gridTop + line,
    gridWidth - line * 2,
    gridHeight - line * 2,
    green,
  );

  const dividerX = margin + Math.round(gridWidth * 0.45);
  const dividerY = gridTop + Math.round(gridHeight * 0.5);
  fillRect(pixels, size, dividerX, gridTop, line, gridHeight, white);
  fillRect(pixels, size, margin, dividerY, gridWidth, line, white);
  fillRect(
    pixels,
    size,
    margin + line,
    gridTop + line,
    dividerX - margin - line,
    dividerY - gridTop - line,
    mint,
  );

  const sparkle = Math.max(1, Math.round(size * 0.07));
  const centerX = size - margin;
  const centerY = margin;
  fillRect(pixels, size, centerX - sparkle * 2, centerY - sparkle / 2, sparkle * 4, sparkle, accent);
  fillRect(pixels, size, centerX - sparkle / 2, centerY - sparkle * 2, sparkle, sparkle * 4, accent);

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * stride + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await Promise.all(
  sizes.map((size) => writeFile(resolve(outputDirectory, `icon-${size}.png`), makeIcon(size))),
);

console.log(`已生成 ${sizes.length} 个 Excel 加载项图标。`);
