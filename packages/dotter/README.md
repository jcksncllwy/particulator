# @particulator/dotter

Image → dot cloud. Stipples an image into `count` dots whose density follows
image darkness. The output is deterministic and seeded, so the same image,
options and seed give the same dots. Runs in Node/bun, browsers and workers.

```ts
import { stipple, stippleUrl, loadPixels, decodeNgaiV1 } from "@particulator/dotter";

// Browser: decode + stipple in a Web Worker (falls back to the main thread).
const cloud = await stippleUrl("/img/dog.png", { count: 30000, seed: 1, edges: 0.2 });

// Anywhere you already have RGBA pixels (ImageData or similar):
const cloud2 = stipple({ width, height, data }, { count: 20000, invert: true });

// Legacy christopherngai.com .bin files:
const legacy = decodeNgaiV1(await (await fetch("/dots/bear.bin")).arrayBuffer());
```

`DotCloud` is `{ width, height, count, data, colors? }`. `data` holds 4 floats
per dot: `x, y` (source-image pixels, y down), `size` (radius in source
pixels) and `opacity` (0..1). `colors`, when requested, holds 3 sRGB bytes per
dot.

## Options

| Option | Default | Meaning |
|---|---|---|
| `count` | `30000` | Dots to place. Fewer come back if the image is (nearly) blank; `cloud.count` is the real number. |
| `seed` | `1` | Seed for every random choice. |
| `invert` | `false` | `false`: dark = dense. `true`: bright = dense. |
| `contrast` | `1` | Contrast around 0.5, applied to density before gamma. |
| `gamma` | `1` | Density exponent. `>1` thins midtones, `<1` fills them. |
| `threshold` | `0.02` | Densities below this are empty. |
| `edges` | `0` | 0..1 blend of a Sobel edge map into density. |
| `alpha` | `"mask"` | `"mask"`: transparent pixels get no dots. `"ignore"`: RGB only. |
| `sizeMin`, `sizeMax` | `0.4`, `1.2` | Dot radius range, in source pixels. |
| `sizeBy` | `"density"` | `"density"` maps local density into the range. `"uniform"` uses `sizeMax`. |
| `opacityBy` | `"density"` | `"density"` maps local density into `[opacityMin, 1]`. `"uniform"` uses 1. |
| `opacityMin` | `0.35` | Lower opacity bound for `opacityBy: "density"`. |
| `colors` | `false` | Store per-dot sampled colour. |
| `maxResolution` | `1024` | Longest side the image is downscaled to before sampling. |

`DEFAULTS` exports these values.

## How it works

1. The image is downscaled to `maxResolution` with a box filter.
2. Density per pixel is computed from Rec.709 luma, then invert, contrast,
   gamma, edge blend, alpha mask and threshold are applied.
3. An R2 low-discrepancy walk, with a seeded Cranley-Patterson offset, runs
   over the non-empty bounding box. Each point is accepted with probability
   `density / maxDensity` (bilinear sample, seeded hash) until `count` dots
   are placed or an iteration cap is reached.
4. Three Jacobi repulsion iterations then space the dots out. The
   interaction radius is 1.5× the local target spacing, and the smaller
   spacing of each pair is used, so dense areas don't leak into sparse ones.
   Dots never move onto empty ground. This removes clumps from the random
   thinning and the R2 lattice in solid areas, and keeps density.
5. Size, opacity and colour come from the dot's final position.

## Browser helpers

- `loadPixels(url | Blob, maxResolution = 1024)` uses `createImageBitmap` and
  `OffscreenCanvas`, falling back to a DOM canvas, or to `<img>` for SVG on
  the main thread. Its pixels are already downscaled, so
  `stipple(await loadPixels(u))` gives coordinates in the downscaled space.
- `stippleUrl(url | Blob, opts)` gives coordinates in the original image's
  space. It runs `./worker.ts` as a module worker
  (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`,
  which Vite and Next bundle). The worker is shared, and results come back
  as transferred buffers. If the worker fails, the call runs on the current
  thread.
