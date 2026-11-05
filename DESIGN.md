# Particulator: design

A browser tool for building particle animation effects for websites: images
dissolve into dots, and the dots fly between images as the page scrolls or the
visitor interacts. Particulator is open source and lives at
`jacksoncallaway.com/tools/particulator`.

It started as the WebGPU particle engine built for christopherngai.com
(`jcksncllwy/christopherngai-site`). The sim exists. This project is mostly the
editor around it, plus a small runtime that designers can drop into a site.

## Who it's for

| Audience | Wants | Gets |
|---|---|---|
| Graphic designers | Make the effect without code | The editor, with presets and an export to paste into a site |
| Web designers (Webflow, Framer, Squarespace) | Drop it into a page builder | A one-line embed: `<script>` + `<particle-stage>` |
| Web devs | Control and integration | An npm package with a typed config, a JS API and a React component |

The look is **2D and graphic**: ink on paper, stipple, halftone, motion
streaks. There is no 3D camera and no node graph.

## Core concepts

- **Stage:** one fixed full-viewport canvas, behind or in front of the page.
  Particles can fly anywhere on it, including between page elements.
- **Scene:** an image turned into a dot cloud, plus a placement on the page.
- **Timeline:** an ordered list of scenes, and what advances between them.
- **Motion:** how particles get from one scene to the next and how they behave
  at rest.
- **Look:** how particles are drawn.

The whole project is described by one versioned JSON document, `project.json`.
The editor writes it, the runtime reads it, and devs can hand-edit it.

## Architecture

```
image ──► Dotter ──► dot cloud (local space, .bin)
                            │
project.json ──► Runtime ───┼──► Placement ──► Timeline ──► Sim (compute) ──► Render
                            │     (per-scene     (scroll/     (force stack)     (style,
                            │      transform)     time/API)                      post)
Editor = Runtime + UI that edits project.json live
```

### Packages (bun workspaces)

```
packages/
  core/        runtime: WebGPU engine, Canvas 2D fallback, drivers, config schema
  dotter/      image → dot cloud (runs in a worker; shared by editor + CLI)
  embed/       <particle-stage> web component, single-file build for <script> use
  react/       <ParticleStage> wrapper
apps/
  editor/      the tool (Vite + React), deployed to /tools/particulator
  examples/    christopherngai.com rebuilt as example #1, plus small demos
```

`core` is framework-agnostic ESM and has no dependencies. The editor imports
`core` directly, so the preview is the real runtime, never an imitation.

## The pieces

### 1. Dotter: image → dot cloud

Chris's dot clouds were made offline. For designers the conversion has to be
live, and tweaking it is half the creative work.

- **Sampling:** weighted blue-noise stippling driven by brightness (fast,
  deterministic, seeded), with an optional weighted-Voronoi relaxation pass
  for the "hand-stippled" look.
- **Controls:** dot count, size range, size mapping (by brightness or uniform),
  contrast/gamma, threshold, invert, edge emphasis (a Sobel weight added to
  the density), background removal (alpha or chroma-key), crop.
- **Colour:** each dot stores its sampled colour. The look decides whether to
  use it.
- **Output:** dots in **normalized local space** (0..1, aspect stored),
  `{x, y, size, opacity, rgb}`, packed binary. This extends the current
  6-byte format with colour.
- **Inputs:** PNG/JPG/WebP and SVG. Text, through a font, comes later.
- Runs in a Web Worker so the editor stays responsive while sliders move. The
  CLI uses the same code.

### 2. Placement

Each scene has a transform: anchor (x, y), size, fit (contain/cover), rotation
and opacity. Dot clouds stay in local space on the GPU, and the transform is
applied in the shader. **Resizing and scrolling never rebuild per-particle
data.** The current engine rebuilds every target on the CPU when the window
resizes.

There are two anchoring modes:

- **Viewport:** fractions of the viewport, with breakpoints (desktop / tablet /
  mobile). This is what Chris's site does and what designers will mostly use.
- **Element:** follows a DOM element (`anchor: "#hero-art"`). The runtime reads
  `getBoundingClientRect()` once per frame for anchored scenes, which costs one
  uniform update. This lets a designer put an empty div in their page builder
  and say "form the image here."

### 3. Timeline and triggers

Every driver reduces to the `(from, to, t)` the engines already use.

- **Scroll sections:** each scene is tied to a page section or element. This is
  the default.
- **Scroll continuous:** progress maps linearly to scroll position.
- **In view:** a scene forms when its element scrolls into view.
- **Time:** loop or ping-pong, with a hold time per scene.
- **Hover/click:** on an element.
- **API:** `stage.goTo("bear")`, `stage.progress = 2.4`.

**Scrubbable vs simulated motion.** This decision runs through the editor and
the drivers. Kinematic motion, where position is a pure function of `t`
(lerp, curves, noise offsets), can be scrubbed and reversed with scroll.
Simulated motion (steering, flocking, physarum) is stateful. It plays out over
time once triggered and can't be scrubbed backwards. Each motion preset
declares which kind it is. The editor's timeline scrubs kinematic presets and
"plays" simulated ones.

### 4. Motion

There's no node graph. Designers pick a **preset** and adjust a few **macro
sliders**. An **Advanced** drawer exposes the raw parameters, like today's
tuning panel.

| Preset | Kind | Built from |
|---|---|---|
| Ease (Chris's original) | kinematic | per-particle eased lerp + idle drift |
| Steer (physarum veins) | simulated | homing + sensor turn on noise field + arrive spring |
| Flow | kinematic | lerp displaced along curl noise, envelope peaks mid-flight |
| Scatter / Gather | kinematic | burst outward along a seeded direction, then home |
| Pour | simulated | gravity + homing, particles "fall" into the next shape |
| Flock | simulated | boids-lite (needs a spatial hash, phase 3) |

The macro sliders are shared across presets where they make sense: **energy**
(speed), **chaos** (field influence), **cohesion** (how bundled the strands
are), **stagger** (departure spread) and **settle** (landing softness).

Internally each preset is a fixed set of WGSL force modules with feature flags
and uniforms in one big shader. That's enough flexibility for presets without
building shader codegen.

**Assignment** (which particle goes to which dot in the next scene) changes
the look more than any force does, so it's a per-transition setting:

- **Shuffle:** random. Chaotic, swirly.
- **Sweep:** both clouds sorted along a Hilbert curve. A coherent morph, with
  each region flowing to the corresponding region.
- **Nearest:** approximate optimal transport (sorted projections). Shortest
  travel, the "melts into" look.

Assignments are precomputed when the project loads, and stored as a
permutation buffer per transition.

**Mismatched counts:** one particle pool sized to the largest scene. Extras in
a smaller scene either fade out to hidden targets (the current behaviour) or
double up on dots.

**Mouse:** repel, attract or swirl, with a radius and a strength. Repel is
what Chris's site uses.

**Fixed timestep.** The current sim is frame-locked, so it runs twice as fast
on 120 Hz displays. The runtime steps the sim at a fixed 60 Hz and
interpolates rendering between steps.

### 5. Look

Graphic first:

- **Shape:** dot, square, streak (speed-stretched, tapered), line segment, or
  glyph (characters from a string, ASCII/halftone style).
- **Colour:** single ink, two-tone gradient by brightness, palette, or the
  source image's colours.
- **Size:** from the dot cloud × a global scale, with a minimum size in device
  pixels.
- **Blend:** normal, multiply (ink on paper), screen (light on dark).
- **Trails:** a feedback buffer with fade (the TouchDesigner Feedback TOP move).
  Phase 3.
- **Theme-aware:** the ink can follow `prefers-color-scheme` or a class on
  `<html>`, as Chris's site does.

### 6. Rendering and performance

- **WebGPU** is the main path (Chrome, Edge, Safari 26+, Firefox 141+ on
  Windows).
- **Canvas 2D fallback** at a capped count (≤30k), with streaks and dots only.
  WebGL2 only if real users need it.
- **Quality tiers:** particle count and DPR cap adapt to the device and to a
  measured frame budget during the first second.
- Pause when the stage is off-screen or the tab is hidden.
- `prefers-reduced-motion` renders the resting scene, with no flights.
- The perf HUD from the christopherngai.com work is carried into the editor.

## The editor

A static single-page app. There is **no backend** in v1: projects live in
IndexedDB and export as files.

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Project ▾   Desktop | Tablet | Mobile    ▶ Preview   Export  │
├───────────┬──────────────────────────────────────┬───────────┤
│ Scenes    │                                      │ Inspector │
│  1 icarus │          Artboard (live stage)       │  Dotter   │
│  2 dog    │   drag/scale/rotate scenes, guides,  │  Placement│
│  3 dinner │   page-section bands for scroll mode │  Look     │
│  + add    │                                      │  Motion   │
├───────────┴──────────────────────────────────────┴───────────┤
│ Timeline: [icarus]──flow──[dog]──steer──[dinner]──…   ◀ ▶ ⏯ │
└──────────────────────────────────────────────────────────────┘
```

- **Artboard:** the real runtime rendering at the chosen breakpoint size.
  Scenes have handles for drag, scale and rotate. In scroll mode, horizontal
  bands show the page sections.
- **Scenes list:** drop images in. The dot cloud regenerates live as you
  change the Dotter settings.
- **Timeline:** scenes as blocks, transitions as the links between them. Click
  a link to set its preset, assignment and duration. Kinematic transitions
  scrub, and simulated ones play.
- **Inspector:** tabs for Dotter, Placement, Look and Motion. Each has an
  "Advanced" drawer.
- **Preview:** a fake scrolling page with N sections, or a **live site** (see
  below).

### Previewing on a real site

Designers need to see the effect on their own page, but a cross-origin page in
an iframe can't be inspected. Instead, the embed script has an edit mode: once
the snippet is installed, visiting `yoursite.com/?particulator=edit` loads the
editor UI as an overlay on the real page. Element anchoring can then be done
by clicking elements. Changes still save by export, since there's no backend.
This is a phase 2 feature, but it shapes the embed's design from day one.

### Export

1. **Embed snippet** (designers, page builders):
   ```html
   <script type="module" src="https://cdn.jsdelivr.net/npm/particulator/embed.js"></script>
   <particle-stage src="/particulator/my-effect.particulator"></particle-stage>
   ```
   A `.particulator` file is one binary bundle (config + dot clouds) for the
   designer to upload next to their site. Small projects can inline it as
   base64 in the snippet, so it's a single paste.
2. **npm** (devs): `npm i particulator`, then `createStage(canvas, project)`, or
   `<ParticleStage project={...} />` from `particulator/react`.
3. **Preset link:** motion and look settings (no images) compressed into the
   URL hash, so people can share a style. Full projects with images are shared
   as `.particulator` files.

## Phases

**Phase 1: runtime extraction.** Done when christopherngai.com is rebuilt on
the package with no visible change.
- `core` from the current WebGPU engine, with local-space clouds, viewport
  placement with breakpoints, a fixed timestep, scroll-section/time/API
  drivers, and Ease + Steer presets with dot/square/streak shapes.
- `dotter` with blue-noise stippling and the basic controls.
- The project schema (zod) and the `.particulator` bundle format.
- The Canvas 2D fallback, carried over.

**Phase 2: editor v1.** Done when a designer can go from three PNGs to a
pasted embed on a Webflow page without help.
- Artboard, scenes list, inspector, timeline, preview page, export (snippet,
  bundle, npm config), IndexedDB projects, perf HUD.
- Element anchoring and the in-view trigger.
- Flow and Scatter/Gather presets, and the Sweep/Nearest assignments.

**Phase 3: depth.**
- The live-site edit overlay.
- Trails/feedback, glyph shape, palette/image colour, blend modes.
- Pour and Flock, plus a true physarum trail field.
- SVG and text sources, and video-frame sources.

## Open questions

- **Licence:** MIT for everything, or MIT for the runtime with the editor
  source-available?
- **Hosting the runtime:** jsDelivr from npm (free, standard) vs serving
  `embed.js` from jacksoncallaway.com.
- **Default particle budget per tier:** decide after benchmarking on a
  mid-range Android and an older iPhone.
- **Image rights in examples:** Chris's images need his OK before
  christopherngai.com ships as a public example. Otherwise use our own art.
- **Analytics/telemetry:** none in v1.
