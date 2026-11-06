# particulator

The runtime: a full-viewport particle stage that forms images out of dots and
flies them between images as the page scrolls, on a clock, or from code.
WebGPU first (compute-shader sim, instanced rendering), with a Canvas 2D
fallback.

```ts
import { createStage } from "particulator";

const stage = createStage({
  effect: {
    scenes: [
      { id: "sphere", source: { type: "image", src: "img/sphere.png" },
        placement: { mode: "element", selector: "[data-particulator=sphere]" } },
      { id: "star", source: { type: "image", src: "img/star.png" },
        placement: { mode: "viewport", x: 0.75, y: 0.5, height: 0.6 } },
    ],
    timeline: { driver: { type: "scroll", sections: "section" } },
  },
});
```

React:

```tsx
import { ParticleStage } from "particulator/react";

<ParticleStage effect={effect} progress={progress} onStage={setStage} />
```

## The effect document

Everything an effect is, as one serializable object (`effect.json`). Only
`scenes` is required; everything else has defaults (`DEFAULTS` in
`src/config.ts`).

| Key | What |
|---|---|
| `scenes[]` | `id`, `source` (`image` stippled at load, or precomputed `dots`), `placement`, `drift`, `overflow` |
| `placement` | `viewport` (x/y as viewport fractions, `height` as a fraction of viewport height, `breakpoints`) or `element` (`selector`, `fit` contain/cover, `scale`, x/y within the box) |
| `timeline.driver` | `api` (set from code), `scroll` (sections by selector), `time` (`hold`, `transition`, `loop` / `pingpong` / `once`) |
| `motion` | `preset`: `ease` or `steer`; `entrance`: `drop` or `none`; `steer` params |
| `field` | the steering noise field (texture params, `drift`, `live` 3D noise) |
| `look` | `ink` (colour, or `{ light, dark }` with `theme`: `class:dark` / `media`), `size`, streaks |
| `interaction.mouse` | `repel` / `attract` / `off`, radius, strength |
| `particles.count` | particle pool size (30k default) |

## Stage API

| | |
|---|---|
| `stage.ready` | resolves once scenes are loaded and the engine is running |
| `stage.progress = 1.5` | scroll-style progress (api driver) |
| `stage.goTo("star", { duration })` | fly straight to a scene (api driver) |
| `stage.update(patch)` | live-edit the effect; rebuilds only what changed (dots, field texture, particle pool) |
| `stage.setEngine("webgpu" \| "canvas2d")` | swap engines; particles carry over |
| `stage.showField` | debug overlay of the steering field |
| `stage.stats()` | fps, sim steps per frame, CPU and GPU timings |
| `stage.destroy()` | |

## How it runs

- **Fixed timestep.** The sim steps at 60 Hz regardless of display refresh
  (motion params are per step), and rendering interpolates between steps.
- **Local-space dots.** Each scene's dots are stored relative to the image
  (units of image height). Placement is a per-scene transform applied in the
  shader, so resizing, scrolling and element-anchored scenes cost a few
  uniforms per frame, not a rebuild.
- **Drivers return a transition** (`from`, `to`, `t`), not a fractional index,
  so loops can go last → first and `goTo` flies directly.
- **Engines** (`src/engines/`) implement `step()` and `render()`; the Stage owns
  the clock, timeline, placement, input and theme. Particle state is a packed
  `Float32Array` (18 floats per particle), which is what's handed across on
  `setEngine`.
