/**
 * A dot cloud in source-image pixel space. This is the contract between the
 * dotter and the runtime (particulator core).
 *
 * `data` is packed, 4 floats per dot: x, y (pixels, 0..width / 0..height,
 * y down), size (radius in source pixels), opacity (0..1).
 * `colors`, when present, is 3 bytes per dot (sRGB).
 */
export type DotCloud = {
  width: number;
  height: number;
  count: number;
  data: Float32Array<ArrayBuffer>;
  colors?: Uint8Array<ArrayBuffer>;
};

/** Pixels to sample. Matches the shape of the DOM ImageData. */
export type PixelSource = {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA, 4 bytes per pixel
};

export type DotterOptions = {
  /** Number of dots to place. */
  count?: number; // default 30000
  /** Seed for every random choice; same image + options + seed = same dots. */
  seed?: number; // default 1
  /** Ink density from luminance: dark pixels get more dots unless inverted. */
  invert?: boolean; // default false (dark = dense)
  /** Gamma applied to density (>1 thins midtones, <1 fills them). */
  gamma?: number; // default 1
  /** Contrast around 0.5, applied before gamma. 1 = unchanged. */
  contrast?: number; // default 1
  /** Densities below this are treated as empty (0..1). */
  threshold?: number; // default 0.02
  /** 0..1 blend of a Sobel edge map into density. */
  edges?: number; // default 0
  /** How alpha is used: "mask" multiplies density by alpha; "ignore" uses RGB only. */
  alpha?: "mask" | "ignore"; // default "mask"
  /** Dot radius range, in pixels of the working image (after downscaling to maxResolution); reported scaled to the output size. */
  sizeMin?: number; // default 0.4
  sizeMax?: number; // default 1.2
  /** What drives size within the range: local density, or uniform (sizeMax). */
  sizeBy?: "density" | "uniform"; // default "density"
  /** What drives opacity: local density mapped into [opacityMin, 1], or constant 1. */
  opacityBy?: "density" | "uniform"; // default "density"
  opacityMin?: number; // default 0.35
  /** Store per-dot colour sampled from the image. */
  colors?: boolean; // default false
  /** Longest side the image is downscaled to before sampling (speed). */
  maxResolution?: number; // default 1024
};
