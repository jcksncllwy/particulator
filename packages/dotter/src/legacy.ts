import type { DotCloud } from "./types";

/**
 * Decode the christopherngai.com `.bin` dot format (v1, 6 bytes per dot).
 *
 * Header (little-endian): u16 width, u16 height, u32 count.
 * Per dot: u16 x (x / 65535 * width), u16 y (y / 65535 * height),
 * u8 size (/ 255 * 2, source pixels), u8 opacity (/ 255).
 */
export function decodeNgaiV1(buf: ArrayBuffer): DotCloud {
  const view = new DataView(buf);
  if (buf.byteLength < 8) throw new Error("decodeNgaiV1: buffer shorter than header");
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  const count = view.getUint32(4, true);
  if (buf.byteLength < 8 + count * 6) {
    throw new Error(`decodeNgaiV1: expected ${8 + count * 6} bytes, got ${buf.byteLength}`);
  }
  const data = new Float32Array(count * 4);
  for (let i = 0, o = 8, k = 0; i < count; i++, o += 6, k += 4) {
    data[k] = (view.getUint16(o, true) / 65535) * width;
    data[k + 1] = (view.getUint16(o + 2, true) / 65535) * height;
    data[k + 2] = (view.getUint8(o + 4) / 255) * 2;
    data[k + 3] = view.getUint8(o + 5) / 255;
  }
  return { width, height, count, data };
}
