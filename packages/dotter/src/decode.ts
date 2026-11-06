import { stippleInto } from "./stipple";
import type { DotCloud, DotterOptions, PixelSource } from "./types";

/** Decoded pixels plus the size of the image before downscaling. */
export type DecodedImage = { pixels: PixelSource; sourceWidth: number; sourceHeight: number };

/**
 * Decode an image (URL or Blob) into RGBA pixels, downscaled so the longest
 * side is at most `maxResolution`. Works on the main thread and in workers.
 * Note: dots from `stipple(await loadPixels(...))` are in the downscaled
 * pixel space; `stippleUrl` reports them in the original image's space.
 */
export async function loadPixels(url: string | Blob, maxResolution = 1024): Promise<PixelSource> {
  return (await decodeImage(url, maxResolution)).pixels;
}

export async function decodeImage(url: string | Blob, maxResolution = 1024): Promise<DecodedImage> {
  const blob = typeof url === "string" ? await fetchBlob(url) : url;
  const source = await toDrawable(blob);
  try {
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (!sourceWidth || !sourceHeight) throw new Error("dotter: image has no intrinsic size");
    const scale = Math.min(1, maxResolution / Math.max(sourceWidth, sourceHeight));
    const w = Math.max(1, Math.round(sourceWidth * scale));
    const h = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = context2d(w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source.image, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    return { pixels: { width: w, height: h, data }, sourceWidth, sourceHeight };
  } finally {
    source.close();
  }
}

/** `stippleUrl` on the current thread. Also what the worker runs. */
export async function stippleUrlHere(url: string | Blob, opts: DotterOptions = {}): Promise<DotCloud> {
  const img = await decodeImage(url, opts.maxResolution ?? 1024);
  return stippleInto(img.pixels, opts, img.sourceWidth, img.sourceHeight);
}


async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dotter: fetch ${url} failed (${res.status})`);
  return res.blob();
}

type Drawable = { image: CanvasImageSource; width: number; height: number; close(): void };

async function toDrawable(blob: Blob): Promise<Drawable> {
  try {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
    return { image: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch (err) {
    // Some browsers can't createImageBitmap an SVG blob; an <img> can (main thread only).
    if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") throw err;
    const src = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = src;
      await img.decode();
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      return { image: img, width, height, close: () => URL.revokeObjectURL(src) };
    } catch (e) {
      URL.revokeObjectURL(src);
      throw e;
    }
  }
}

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function context2d(w: number, h: number): Ctx2D {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  if (!ctx) throw new Error("dotter: 2D canvas context unavailable");
  return ctx;
}


// Messages between stippleUrl and the worker.
export type WorkerRequest = { id: number; url: string | Blob; opts: DotterOptions };
export type WorkerResponse = { id: number; cloud?: DotCloud; error?: string };
