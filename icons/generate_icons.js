// Run once with: node generate_icons.js
// Requires Node.js 18+ (built-in Canvas via OffscreenCanvas is not available in Node;
// this script uses the `canvas` npm package if available, or falls back to a minimal PNG writer).

const fs = require('fs');
const path = require('path');

// Minimal PNG encoder — no dependencies required
function createPNG(width, height, pixelFn) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const i = (y * width + x) * 4;
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
    }
  }

  // Build raw PNG data
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type);
    const crcBuf = Buffer.concat([typeB, data]);
    const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, typeB, data, crcVal]);
  }

  const deflate = require('zlib').deflateSync;

  // Build IDAT raw bytes (filter type 0 per row)
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    rawRows.push(0); // filter type
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rawRows.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflate(Buffer.from(rawRows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function dist(x, y, cx, cy) {
  return Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function drawIcon(size) {
  const s = size;
  const cx = s / 2, cy = s / 2, r = s / 2 - 1;

  return createPNG(s, s, (x, y) => {
    const d = dist(x + 0.5, y + 0.5, cx, cy);

    // Outside circle → transparent
    if (d > r) return [0, 0, 0, 0];

    // Anti-alias edge
    const alpha = d > r - 1 ? Math.round((r - d) * 255) : 255;

    // Crown region (top 30%)
    const crownBottom = s * 0.38;
    const inCrown =
      y < crownBottom &&
      d < r &&
      (
        inTriangle(x, y, s*0.22, s*0.32, s*0.30, s*0.14, s*0.38, s*0.32) ||
        inTriangle(x, y, s*0.38, s*0.32, s*0.50, s*0.20, s*0.62, s*0.32) ||
        inTriangle(x, y, s*0.62, s*0.32, s*0.70, s*0.14, s*0.78, s*0.32) ||
        (x >= s*0.22 && x <= s*0.78 && y >= s*0.30 && y <= s*0.38)
      );

    if (size >= 48 && inCrown) return [255, 215, 0, alpha]; // gold crown

    // Play triangle
    const inPlay = inTriangle(
      x + 0.5, y + 0.5,
      s * 0.38, s * 0.28,
      s * 0.38, s * 0.78,
      s * 0.80, s * 0.53
    );
    if (inPlay) return [255, 255, 255, alpha]; // white play button

    // Red circle background
    return [220, 20, 20, alpha];
  });
}

[16, 48, 128].forEach((size) => {
  const png = drawIcon(size);
  const out = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`Generated ${out} (${png.length} bytes)`);
});
