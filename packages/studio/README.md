# @particulator/studio

The particulator editor. It mounts over a page that's running a particulator
`Stage`, edits the effect live on the real page, and saves `effect.json` back
to your project. Dev builds only: production pages load just the runtime.

```ts
import { createStage } from "particulator";
import effect from "./effect.json";

const stage = createStage({ effect });

if (import.meta.env.DEV) {
  import("@particulator/studio").then(({ mountStudio }) => mountStudio(stage));
}
```

Saves go to the save server from `@particulator/cli`:

- **Vite:** add `particulatorStudio({ effect: "src/effect.json", assets: "public/particulator" })`
  from `@particulator/cli/vite` to your plugins. The studio finds it at `/__particulator`.
- **Anything else:** run `particulator studio --effect effect.json --assets public/particulator --public public`
  and mount with `mountStudio(stage, { storage: saveServer("http://localhost:4747") })`.
- **No server:** saves fall back to the File System Access API (pick `effect.json`
  once, then save in place), then to downloading the file.

## What's in it

| | |
|---|---|
| **Page** | Every scene's box on the page. Select one to drag it, scale it from the corner, or rotate it from the knob (shift snaps to 15°). |
| **Placement** | Viewport scenes edit the breakpoint in effect at the current window width, or the base values. Resize the window to edit another breakpoint, or add one at the current width. Element scenes edit their position and scale within the element. **Pick element** binds a scene to whatever you click, preferring `data-particulator` and ids, and warns when it had to use a fragile selector. |
| **Scenes** | Drop images to add scenes (uploaded to your assets folder), reorder, duplicate, remove. |
| **Inspector** | Scene (id, placement, dotter), Motion (flight, sensors, landing, resting, walls, crowd, cursor), Field, Look, Timeline. |
| **Timeline** | Scenes in order, with the live transition. Click one to go there (scrolls to its section with the scroll driver). |
| **Top bar** | fps and CPU/GPU timings, engine switch, undo/redo, save. |

Keys: `⌘S` save, `⌘Z` / `⇧⌘Z` undo/redo, `` ` `` hide/show the studio.

Saves are minimal: only what differs from the defaults is written, scenes first.
