# @particulator/cli

`particulator studio`: the local save server behind the Particulator dev
studio. The studio runs inside your app on localhost; this server lets it load
and save `effect.json` and write dropped images into your repo, so what you
commit is exactly what production reads.

Dev-only. Binds to `127.0.0.1` by default and only accepts writes from
localhost origins.

## CLI

```sh
particulator studio --effect src/effect.json --assets public/particulator --public public
```

| Option     | Default               | Meaning                                         |
| ---------- | --------------------- | ----------------------------------------------- |
| `--effect` | `effect.json`         | effect file to load/save                        |
| `--assets` | `public/particulator` | where dropped images go (must be inside public) |
| `--public` | `public`              | static root; asset `src` paths are relative to it |
| `--port`   | `4747`                |                                                 |
| `--host`   | `127.0.0.1`           |                                                 |

Then in your app:

```ts
if (import.meta.env.DEV)
  import("@particulator/studio").then(({ mountStudio, saveServer }) =>
    mountStudio(stage, { storage: saveServer("http://localhost:4747") }));
```

## Vite plugin

No separate process: the same protocol is served same-origin at
`/__particulator` by the Vite dev server.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { particulatorStudio } from "@particulator/cli/vite";

export default defineConfig({
  plugins: [particulatorStudio({ effect: "src/effect.json", assets: "public/particulator" })],
});
```

```ts
saveServer("/__particulator")
```

Paths resolve against the Vite root; `publicDir` defaults to Vite's.

## Programmatic

```ts
import { createStudioHandler, startStudioServer } from "@particulator/cli";

const server = await startStudioServer({ effect, assets, publicDir, port: 4747 });
// or mount createStudioHandler({ effect, assets, publicDir, base: "/__particulator" })
// as (req, res, next) middleware in any Node/Connect/Express server.
```

## Protocol (v1)

Relative to `http://localhost:4747` or `/__particulator`.

| Request                         | Response |
| ------------------------------- | -------- |
| `GET /health`                   | `200 { ok: true, effect, assets, publicDir, version: 1 }` (absolute paths) |
| `GET /effect`                   | `200` effect JSON, or `404 { error }` if the file doesn't exist |
| `PUT /effect` (JSON, ≤ 5 MB)    | `204`. Must be an object with a `scenes` array (else `400`). Written 2-space indented with a trailing newline, atomically |
| `POST /assets?name=<file>` (raw bytes, ≤ 50 MB) | `200 { src }`, `src` relative to publicDir (e.g. `particulator/dog.png`) |
| anything else                   | `404 { error }` |

Errors are JSON `{ error }`. Oversize bodies get `413`.

**Assets.** The name is reduced to a basename of `[a-zA-Z0-9._-]` with a
lower-cased extension; allowed: `png jpg jpeg webp gif avif svg bin` (`.bin`
for precomputed dot clouds), otherwise `400`. Uploading identical bytes under
an existing name reuses the file; different bytes get `-1`, `-2`, … suffixes.
If the assets dir isn't inside publicDir the upload fails with `500`, since
the result couldn't be served.

**CORS.** Origins on `localhost`, `127.0.0.1` or `[::1]` (any port, http or
https) are reflected in `Access-Control-Allow-Origin`; preflight allows
`GET, PUT, POST, OPTIONS` and `content-type`. Other origins get no CORS
headers, and any non-GET request carrying a foreign `Origin` is refused with
`403`.
