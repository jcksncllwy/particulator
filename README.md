# Particulator

A browser tool for building particle animation effects for websites: images
dissolve into dots, and the dots fly between images as the page scrolls or the
visitor interacts. It's built for web designers, graphic designers and web
devs. It has a visual editor, a one-line embed for page builders, and an npm
package for developers.

Status: phase 1 (runtime) in progress. See [DESIGN.md](DESIGN.md).

| Package | What |
|---|---|
| [`packages/core`](packages/core) (`particulator`) | the runtime: WebGPU + Canvas 2D engines, effect schema, drivers, React wrapper |
| [`packages/dotter`](packages/dotter) (`@particulator/dotter`) | image → dot cloud stippling, runs in a worker |
| [`packages/studio`](packages/studio) (`@particulator/studio`) | the editor: mounts over your page in dev, edits the effect live, saves `effect.json` |
| [`packages/cli`](packages/cli) (`@particulator/cli`) | `particulator studio` save server, plus a Vite plugin |
| [`apps/examples/basic`](apps/examples/basic) | plain Vite page: images stippled at load, element-anchored scenes, scroll driver |
| [`apps/examples/christopherngai`](apps/examples/christopherngai) | christopherngai.com rebuilt on the package (Next.js) |

```bash
bun install
bun test
cd apps/examples/basic && bunx vite             # http://localhost:5173, studio included
cd apps/examples/christopherngai && bunx next dev   # http://localhost:3000
cd apps/examples/christopherngai && bun run studio  # its save server, alongside next dev
```

It grew out of the WebGPU particle engine built for
[christopherngai.com](https://github.com/jcksncllwy/christopherngai-site).

MIT licensed. See [LICENSE](LICENSE).
