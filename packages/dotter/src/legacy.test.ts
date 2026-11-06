import { expect, test } from "bun:test";
import { decodeNgaiV1 } from "./legacy";

// Same arithmetic as decodeDots in the christopherngai.com site (scenes.ts).
function reference(buf: ArrayBuffer) {
  const view = new DataView(buf);
  const width = view.getUint16(0, true), height = view.getUint16(2, true), count = view.getUint32(4, true);
  const dots = [];
  for (let i = 0, o = 8; i < count; i++, o += 6)
    dots.push({
      x: (view.getUint16(o, true) / 65535) * width,
      y: (view.getUint16(o + 2, true) / 65535) * height,
      size: (view.getUint8(o + 4) / 255) * 2,
      opacity: view.getUint8(o + 5) / 255,
    });
  return { width, height, dots };
}

test("decodeNgaiV1 matches the reference decoder", () => {
  const raw: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [65535, 65535, 255, 255],
    [32768, 12345, 128, 77],
    [1, 65534, 3, 254],
  ];
  const buf = new ArrayBuffer(8 + raw.length * 6);
  const v = new DataView(buf);
  v.setUint16(0, 1600, true);
  v.setUint16(2, 900, true);
  v.setUint32(4, raw.length, true);
  raw.forEach(([x, y, s, o], i) => {
    const off = 8 + i * 6;
    v.setUint16(off, x, true);
    v.setUint16(off + 2, y, true);
    v.setUint8(off + 4, s);
    v.setUint8(off + 5, o);
  });

  const cloud = decodeNgaiV1(buf);
  const ref = reference(buf);
  expect(cloud.width).toBe(1600);
  expect(cloud.height).toBe(900);
  expect(cloud.count).toBe(raw.length);
  ref.dots.forEach((d, i) => {
    // Float32 storage: identical after rounding the reference to f32.
    expect(cloud.data[i * 4]).toBe(Math.fround(d.x));
    expect(cloud.data[i * 4 + 1]).toBe(Math.fround(d.y));
    expect(cloud.data[i * 4 + 2]).toBe(Math.fround(d.size));
    expect(cloud.data[i * 4 + 3]).toBe(Math.fround(d.opacity));
  });
  expect(cloud.data[4]).toBe(1600);
  expect(cloud.data[6]).toBe(2);
});

test("decodeNgaiV1 rejects truncated buffers", () => {
  const buf = new ArrayBuffer(8 + 5);
  new DataView(buf).setUint32(4, 1, true);
  expect(() => decodeNgaiV1(buf)).toThrow();
});
