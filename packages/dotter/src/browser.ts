import { stippleUrlHere, type WorkerRequest, type WorkerResponse } from "./decode";
import type { DotCloud, DotterOptions } from "./types";

export { loadPixels, decodeImage, stippleUrlHere, type DecodedImage } from "./decode";

/**
 * Load and stipple an image. Runs in a module Web Worker when possible (the
 * page stays responsive), falling back to the current thread. Dots are in
 * the original image's pixel space.
 */
export async function stippleUrl(url: string | Blob, opts: DotterOptions = {}): Promise<DotCloud> {
  const worker = getWorker();
  if (worker) {
    try {
      return await worker.run(typeof url === "string" ? absolute(url) : url, opts);
    } catch {
      // Worker unavailable or failed; a genuinely bad image fails again below
      // with a useful error.
    }
  }
  return stippleUrlHere(url, opts);
}

/** Workers resolve relative URLs against the worker script, so pin them to the page. */
function absolute(url: string): string {
  const g = globalThis as { document?: { baseURI?: string }; location?: { href?: string } };
  const base = g.document?.baseURI ?? g.location?.href;
  try {
    return base ? new URL(url, base).href : url;
  } catch {
    return url;
  }
}

// --- worker client ----------------------------------------------------------


type Client = { run(url: string | Blob, opts: DotterOptions): Promise<DotCloud> };

let client: Client | null | undefined;

function getWorker(): Client | null {
  if (client !== undefined) return client;
  client = null;
  if (typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  const pending = new Map<number, { resolve(c: DotCloud): void; reject(e: Error): void }>();
  let nextId = 1;
  const failAll = (msg: string) => {
    client = null; // later calls go straight to the main thread
    worker.terminate();
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
  };
  worker.addEventListener("message", (ev: MessageEvent<WorkerResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.cloud) p.resolve(ev.data.cloud);
    else p.reject(new Error(ev.data.error ?? "dotter worker: unknown error"));
  });
  worker.addEventListener("error", (ev) => {
    ev.preventDefault();
    failAll(`dotter worker failed: ${ev.message || "load error"}`);
  });
  worker.addEventListener("messageerror", () => failAll("dotter worker: message error"));
  client = {
    run(url, opts) {
      return new Promise<DotCloud>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const req: WorkerRequest = { id, url, opts };
        worker.postMessage(req);
      });
    },
  };
  return client;
}
