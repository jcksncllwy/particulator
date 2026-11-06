import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudioHandler, startStudioServer, type StudioServer } from "./index";
import { sanitizeAssetName } from "./handler";
import { particulatorStudio } from "./vite";

let root: string;
let server: StudioServer;
let base: string;

const effectFile = () => path.join(root, "effect.json");
const assetsDir = () => path.join(root, "public", "particulator");
const png = (seed: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed, seed + 1, seed + 2]);

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "particulator-cli-"));
  server = await startStudioServer({
    effect: effectFile(),
    assets: assetsDir(),
    publicDir: path.join(root, "public"),
    port: 0,
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const upload = (name: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`${base}/assets?name=${encodeURIComponent(name)}`, { method: "POST", body, headers });

describe("health", () => {
  test("reports resolved paths and version", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      effect: effectFile(),
      assets: assetsDir(),
      publicDir: path.join(root, "public"),
      version: 1,
    });
  });
});

describe("effect", () => {
  test("404 when missing, then PUT/GET round-trip with formatting", async () => {
    const missing = await fetch(`${base}/effect`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBeString();

    const effect = { scenes: [{ id: "dog", source: { type: "image", src: "particulator/dog.png" } }] };
    const put = await fetch(`${base}/effect`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(effect),
    });
    expect(put.status).toBe(204);

    const get = await fetch(`${base}/effect`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("application/json");
    expect(await get.json()).toEqual(effect);

    const text = await readFile(effectFile(), "utf8");
    expect(text).toBe(JSON.stringify(effect, null, 2) + "\n");
    expect(text).toContain('\n  "scenes": [');

    // No temp files left behind by the atomic write.
    expect((await readdir(root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("PUT validation", async () => {
    for (const body of ["not json", "[]", "null", '{"scenes":{}}', '{"timeline":{}}']) {
      const res = await fetch(`${base}/effect`, { method: "PUT", body });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeString();
    }
  });

  test("PUT over 5 MB is 413", async () => {
    const big = JSON.stringify({ scenes: [], pad: "x".repeat(5 * 1024 * 1024) });
    const res = await fetch(`${base}/effect`, { method: "PUT", body: big });
    expect(res.status).toBe(413);
  });
});

describe("assets", () => {
  test("upload, dedupe identical bytes, suffix different bytes", async () => {
    const first = await upload("Dog.PNG", png(1));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ src: "particulator/Dog.png" });
    expect(new Uint8Array(await readFile(path.join(assetsDir(), "Dog.png")))).toEqual(png(1));

    const same = await upload("Dog.png", png(1));
    expect(await same.json()).toEqual({ src: "particulator/Dog.png" });

    const different = await upload("Dog.png", png(2));
    expect(await different.json()).toEqual({ src: "particulator/Dog-1.png" });

    const third = await upload("Dog.png", png(3));
    expect(await third.json()).toEqual({ src: "particulator/Dog-2.png" });

    const againSecond = await upload("Dog.png", png(2));
    expect(await againSecond.json()).toEqual({ src: "particulator/Dog-1.png" });

    expect((await readdir(assetsDir())).sort()).toEqual(["Dog-1.png", "Dog-2.png", "Dog.png"]);
  });

  test("dot clouds (.bin) and other image types are accepted", async () => {
    for (const name of ["cloud.bin", "a.jpeg", "b.webp", "c.svg", "d.avif", "e.gif", "f.jpg"]) {
      const res = await upload(name, png(9));
      expect(res.status).toBe(200);
    }
  });

  test("bad extensions and empty names are rejected", async () => {
    for (const name of ["evil.html", "script.js", "noext", "", ".png", "../.png"]) {
      const res = await upload(name, png(4));
      expect(res.status).toBe(400);
    }
  });

  test("path traversal in name is reduced to a basename", async () => {
    const res = await upload("../../../etc/pw ned.png", png(5));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ src: "particulator/pw-ned.png" });

    const win = await upload("..\\..\\win.png", png(6));
    expect(await win.json()).toEqual({ src: "particulator/win.png" });

    const dots = await upload("....png", png(7));
    expect(dots.status).toBe(400);
  });

  test("sanitizeAssetName", () => {
    expect(sanitizeAssetName("My Photo (1).JPG")).toMatchObject({ ok: true, name: "My-Photo-1.jpg" });
    expect(sanitizeAssetName("a/b/..hidden.png")).toMatchObject({ ok: true, name: "hidden.png" });
    expect(sanitizeAssetName("x.tar.png")).toMatchObject({ ok: true, name: "x.tar.png" });
    expect(sanitizeAssetName("x.exe").ok).toBe(false);
  });

  test("assets dir outside publicDir is a 500 with a clear error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "particulator-cli-out-"));
    const s = await startStudioServer({
      effect: path.join(dir, "effect.json"),
      assets: path.join(dir, "assets"),
      publicDir: path.join(dir, "public"),
      port: 0,
    });
    try {
      const res = await fetch(`${s.url}/assets?name=a.png`, { method: "POST", body: png(1) });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain("not inside publicDir");
    } finally {
      await s.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("routing", () => {
  test("unknown routes and wrong methods are 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/effect`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${base}/assets`)).status).toBe(404);
  });
});

describe("CORS", () => {
  test("reflects local origins", async () => {
    for (const origin of ["http://localhost:5173", "https://127.0.0.1:3000", "http://[::1]:8080", "http://localhost"]) {
      const res = await fetch(`${base}/health`, { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toContain("Origin");
    }
  });

  test("no CORS headers for foreign origins; writes are 403", async () => {
    const get = await fetch(`${base}/health`, { headers: { origin: "https://evil.com" } });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBeNull();

    for (const origin of ["https://evil.com", "http://localhost.evil.com", "null", "file://"]) {
      const put = await fetch(`${base}/effect`, { method: "PUT", headers: { origin }, body: '{"scenes":[]}' });
      expect(put.status).toBe(403);
      expect(put.headers.get("access-control-allow-origin")).toBeNull();
    }
    const post = await upload("x.png", png(1), { origin: "https://evil.com" });
    expect(post.status).toBe(403);
    // The 403'd PUT must not have touched the file.
    expect(await readFile(effectFile(), "utf8")).toContain("dog");
  });

  test("OPTIONS preflight", async () => {
    const res = await fetch(`${base}/effect`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, PUT, POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");

    const evil = await fetch(`${base}/effect`, { method: "OPTIONS", headers: { origin: "https://evil.com" } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("middleware with base path", () => {
  let mw: Server;
  let url: string;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "particulator-cli-mw-"));
    await mkdir(path.join(dir, "public"), { recursive: true });
    await writeFile(path.join(dir, "effect.json"), '{"scenes":[1]}');
    const handler = createStudioHandler({
      effect: path.join(dir, "effect.json"),
      assets: path.join(dir, "public", "img"),
      publicDir: path.join(dir, "public"),
      base: "/__particulator/",
    });
    mw = createServer((req, res) =>
      handler(req, res, () => {
        res.statusCode = 200;
        res.end(`next:${req.url}`);
      }),
    );
    await new Promise<void>((r) => mw.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(mw.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    mw.closeAllConnections();
    await new Promise((r) => mw.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  test("handles URLs under base", async () => {
    const health = await fetch(`${url}/__particulator/health`);
    expect((await health.json()).ok).toBe(true);
    expect(await (await fetch(`${url}/__particulator/effect`)).json()).toEqual({ scenes: [1] });

    const up = await fetch(`${url}/__particulator/assets?name=dog.png`, { method: "POST", body: png(1) });
    expect(await up.json()).toEqual({ src: "img/dog.png" });

    expect((await fetch(`${url}/__particulator/nope`)).status).toBe(404);
  });

  test("passes everything else to next()", async () => {
    for (const p of ["/", "/effect", "/health", "/__particulatorx/health", "/src/main.ts?x=1"]) {
      const res = await fetch(url + p);
      expect(await res.text()).toBe(`next:${p}`);
    }
  });
});

describe("vite plugin", () => {
  test("mounts the handler at /__particulator against the Vite root", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "particulator-cli-vite-"));
    const plugin = particulatorStudio({ effect: "src/effect.json", assets: "public/img" });
    expect(plugin.apply).toBe("serve");

    let mounted: Parameters<Parameters<typeof plugin.configureServer>[0]["middlewares"]["use"]>[0] | undefined;
    plugin.configureServer({ config: { root: dir }, middlewares: { use: (fn) => (mounted = fn) } });
    expect(mounted).toBeFunction();

    const s = createServer((req, res) => mounted!(req, res, () => res.end("vite")));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    try {
      const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      expect(await (await fetch(`${u}/__particulator/health`)).json()).toMatchObject({
        effect: path.join(dir, "src", "effect.json"),
        assets: path.join(dir, "public", "img"),
        publicDir: path.join(dir, "public"),
      });
      expect(await (await fetch(`${u}/index.html`)).text()).toBe("vite");
    } finally {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
