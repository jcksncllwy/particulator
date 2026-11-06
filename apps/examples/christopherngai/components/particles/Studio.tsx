"use client";

import { useEffect } from "react";
import type { Stage } from "particulator";

/**
 * Dev only: mounts the particulator studio over the page. Saves go to the
 * save server (`bun run studio`, port 4747), which writes effect.json and
 * uploads to public/particulator. Without it, saves fall back to the File
 * System Access API or a download.
 */
export function Studio({ stage }: { stage: Stage }) {
  useEffect(() => {
    let unmount: (() => void) | undefined;
    let dead = false;
    void (async () => {
      const { mountStudio, autoStorage } = await import("@particulator/studio");
      const storage = await autoStorage("http://127.0.0.1:4747");
      if (dead) return;
      const studio = await mountStudio(stage, { storage });
      if (dead) return studio.unmount();
      unmount = studio.unmount;
      (window as unknown as { studio: typeof studio }).studio = studio;
    })();
    return () => { dead = true; unmount?.(); };
  }, [stage]);
  return null;
}
