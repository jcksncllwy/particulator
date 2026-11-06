import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface StudioHandlerOptions {
  /** Path to the effect JSON file the studio loads and saves. */
  effect: string;
  /** Directory dropped images are written into. Must be inside `publicDir`. */
  assets: string;
  /** The app's static root; asset `src` values are relative to it. */
  publicDir: string;
  /** Only handle URLs under this prefix (e.g. "/__particulator"); others go to `next()`. */
  base?: string;
}

export type StudioHandler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;

export const PROTOCOL_VERSION = 1;
export const EFFECT_LIMIT = 5 * 1024 * 1024;
export const ASSET_LIMIT = 50 * 1024 * 1024;
export const ASSET_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif", "svg", "bin"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// (No parameter properties: this file must run under Node's type stripping, which Vite uses to load configs.)
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createStudioHandler(opts: StudioHandlerOptions): StudioHandler {
  const effectPath = path.resolve(opts.effect);
  const assetsDir = path.resolve(opts.assets);
  const publicDir = path.resolve(opts.publicDir);
  const base = normalizeBase(opts.base);

  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = stripBase(url.pathname, base);
    if (route === null) {
      if (next) next();
      else sendJson(res, 404, { error: "Not found" });
      return;
    }

    const origin = req.headers.origin;
    const originAllowed = origin !== undefined && isLocalOrigin(origin);
    if (originAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else if (origin !== undefined && req.method !== "GET" && req.method !== "HEAD") {
      // Cross-site writes are refused outright; reads just get no CORS headers,
      // so the browser won't hand the response to the foreign page.
      drain(req);
      sendJson(res, 403, { error: `Origin not allowed: ${origin}` });
      return;
    }

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.statusCode = 204;
      res.end();
      return;
    }

    const ctx: Ctx = { req, res, url, effectPath, assetsDir, publicDir };
    route_(route, ctx).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 413) {
        // Don't keep the connection around for the rest of an oversized upload.
        res.setHeader("Connection", "close");
        res.once("finish", () => req.socket.destroy());
      }
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  };
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  effectPath: string;
  assetsDir: string;
  publicDir: string;
}

async function route_(route: string, ctx: Ctx): Promise<void> {
  const method = ctx.req.method;
  if (route === "/health" && method === "GET") return health(ctx);
  if (route === "/effect" && method === "GET") return getEffect(ctx);
  if (route === "/effect" && method === "PUT") return putEffect(ctx);
  if (route === "/assets" && method === "POST") return postAsset(ctx);
  drain(ctx.req);
  sendJson(ctx.res, 404, { error: "Not found" });
}

function health({ res, effectPath, assetsDir, publicDir }: Ctx): void {
  sendJson(res, 200, {
    ok: true,
    effect: effectPath,
    assets: assetsDir,
    publicDir,
    version: PROTOCOL_VERSION,
  });
}

async function getEffect({ res, effectPath }: Ctx): Promise<void> {
  let text: string;
  try {
    text = await readFile(effectPath, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) throw new HttpError(404, `Effect file not found: ${effectPath}`);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HttpError(500, `Effect file is not valid JSON (${effectPath}): ${(err as Error).message}`);
  }
  sendJson(res, 200, parsed);
}

async function putEffect({ req, res, effectPath }: Ctx): Promise<void> {
  const body = await readBody(req, EFFECT_LIMIT);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (err) {
    throw new HttpError(400, `Body is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.scenes)) {
    throw new HttpError(400, "Effect must be an object with a `scenes` array");
  }
  await writeAtomic(effectPath, JSON.stringify(parsed, null, 2) + "\n");
  res.statusCode = 204;
  res.end();
}

async function postAsset({ req, res, url, assetsDir, publicDir }: Ctx): Promise<void> {
  const rel = path.relative(publicDir, assetsDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    drain(req);
    throw new HttpError(500, `Assets dir (${assetsDir}) is not inside publicDir (${publicDir}); uploaded files would not be servable`);
  }

  const name = sanitizeAssetName(url.searchParams.get("name") ?? "");
  if (!name.ok) {
    drain(req);
    throw new HttpError(400, name.error);
  }

  const bytes = await readBody(req, ASSET_LIMIT);
  await mkdir(assetsDir, { recursive: true });
  const file = await writeDeduped(assetsDir, name.stem, name.ext, bytes);
  const src = path.relative(publicDir, file).split(path.sep).join("/");
  sendJson(res, 200, { src });
}

export type SanitizedName =
  | { ok: true; stem: string; ext: string; name: string }
  | { ok: false; error: string };

/** Reduce an uploaded filename to a safe basename: `[a-zA-Z0-9._-]`, lower-case allowed extension. */
export function sanitizeAssetName(raw: string): SanitizedName {
  const basename = raw.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot === -1) {
    return { ok: false, error: `Filename needs an extension (${ASSET_EXTENSIONS.join(", ")})` };
  }
  const ext = basename.slice(dot + 1).toLowerCase();
  if (!ASSET_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `Unsupported file type ".${ext}"; allowed: ${ASSET_EXTENSIONS.join(", ")}` };
  }
  const stem = basename
    .slice(0, dot)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "") // no hidden files, no ".." remnants
    .replace(/[.-]+$/, "");
  if (!stem) return { ok: false, error: "Filename is empty after sanitizing" };
  return { ok: true, stem, ext, name: `${stem}.${ext}` };
}

async function writeDeduped(dir: string, stem: string, ext: string, bytes: Buffer): Promise<string> {
  for (let i = 0; i < 10_000; i++) {
    const file = path.join(dir, i === 0 ? `${stem}.${ext}` : `${stem}-${i}.${ext}`);
    if (path.dirname(file) !== dir) throw new HttpError(400, "Invalid filename");
    try {
      await writeFile(file, bytes, { flag: "wx" });
      return file;
    } catch (err) {
      if (!isErrno(err, "EEXIST")) throw err;
    }
    const existing = await stat(file);
    if (existing.isFile() && existing.size === bytes.length && (await readFile(file)).equals(bytes)) {
      return file;
    }
  }
  throw new HttpError(500, "Could not find a free filename");
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    drain(req);
    return Promise.reject(new HttpError(413, `Body exceeds ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, `Body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function drain(req: IncomingMessage): void {
  req.resume();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  res.end(text);
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function normalizeBase(base: string | undefined): string {
  if (!base || base === "/") return "";
  return ("/" + base.replace(/^\/+|\/+$/g, "")).replace(/\/{2,}/g, "/");
}

/** Route path relative to `base`, or null when the URL is outside it. */
function stripBase(pathname: string, base: string): string | null {
  if (!base) return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(base + "/")) return pathname.slice(base.length);
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}
