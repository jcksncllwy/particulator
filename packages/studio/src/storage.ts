// Where the studio's saves go. Each host plugs one in:
//  - saveServer: the dev studio talking to `particulator studio` (or the Vite plugin)
//  - fileSystemAccess: pick effect.json once, then save in place (Chromium)
//  - download: last resort, downloads effect.json

import type { EffectInput } from "particulator";

export type StorageAdapter = {
  /** Shown in the studio's top bar, e.g. "effect.json via save server". */
  label: string;
  save: (effect: EffectInput) => Promise<void>;
  /** Store a dropped image (or .bin) next to the project's assets; returns the `src` to use in the effect. */
  putAsset?: (file: File) => Promise<string>;
};

const json = (effect: EffectInput) => JSON.stringify(effect, null, 2) + "\n";

/** The save server's protocol (see @particulator/cli): GET/PUT /effect, POST /assets?name=. */
export function saveServer(base = "/__particulator"): StorageAdapter {
  const url = (p: string) => base.replace(/\/$/, "") + p;
  return {
    label: `effect.json via ${base.startsWith("/") ? "dev server" : base.replace(/^https?:\/\//, "")}`,
    save: async (effect) => {
      const res = await fetch(url("/effect"), { method: "PUT", headers: { "content-type": "application/json" }, body: json(effect) });
      if (!res.ok) throw new Error(`save failed: ${res.status} ${await res.text().catch(() => "")}`);
    },
    putAsset: async (file) => {
      const res = await fetch(url(`/assets?name=${encodeURIComponent(file.name)}`), {
        method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file,
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => "")}`);
      return ((await res.json()) as { src: string }).src;
    },
  };
}

/** Is a save server answering at `base`? */
export async function hasSaveServer(base = "/__particulator"): Promise<boolean> {
  try {
    const res = await fetch(base.replace(/\/$/, "") + "/health", { cache: "no-store" });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

type FileHandle = { createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }> };
type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle>;

/** File System Access API: pick effect.json on first save, then write it in place. */
export function fileSystemAccess(): StorageAdapter {
  let handle: FileHandle | null = null;
  return {
    label: "effect.json (pick a file on save)",
    save: async (effect) => {
      const pick = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      if (!pick) throw new Error("This browser can't save files directly; use download instead.");
      handle ??= await pick({ suggestedName: "effect.json", types: [{ description: "Particulator effect", accept: { "application/json": [".json"] } }] });
      const w = await handle.createWritable();
      await w.write(json(effect));
      await w.close();
    },
  };
}

/** Downloads effect.json on every save. */
export function download(): StorageAdapter {
  return {
    label: "download effect.json",
    save: async (effect) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json(effect)], { type: "application/json" }));
      a.download = "effect.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };
}

/** The save server if one answers at `base`, else File System Access where supported, else download. */
export async function autoStorage(base = "/__particulator"): Promise<StorageAdapter> {
  if (await hasSaveServer(base)) return saveServer(base);
  if ("showSaveFilePicker" in window) return fileSystemAccess();
  return download();
}
