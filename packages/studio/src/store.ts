// The studio's editing model: wraps a Stage, applies edits to it live, and
// tracks selection, undo/redo, and whether there are unsaved changes.

import { resolveEffect, sparseEffect, type DeepPartial, type Effect, type EffectInput, type SceneConfig, type Stage } from "particulator";
import type { StorageAdapter } from "./storage";

type Patch = DeepPartial<Effect> & { scenes?: SceneConfig[] };
type Listener = () => void;

export type Store = ReturnType<typeof createStore>;

export function createStore(stage: Stage, storage: StorageAdapter) {
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());
  const snapshot = () => JSON.stringify(sparseEffect(stage.effect));

  let saved = snapshot();
  let undo: string[] = [];
  let redo: string[] = [];
  // Rapid edits to the same control (a slider drag) collapse into one undo step.
  let lastKey = "", lastAt = 0;

  const state = {
    selected: 0,
    status: "" as string,
    error: false,
    picking: false,
  };

  const set = (patch: Partial<typeof state>) => { Object.assign(state, patch); emit(); };

  async function apply(patch: Patch, key = "") {
    const now = performance.now();
    if (!(key && key === lastKey && now - lastAt < 800)) { undo.push(snapshot()); redo = []; if (undo.length > 200) undo.shift(); }
    lastKey = key; lastAt = now;
    await stage.update(patch);
    emit();
  }

  async function restore(json: string) {
    // Snapshots are sparse; resolve to the full effect so keys back at their defaults revert too.
    await stage.update(resolveEffect(JSON.parse(json) as EffectInput) as Patch);
    lastKey = "";
    emit();
  }

  return {
    stage,
    storage,
    state,
    subscribe: (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    get effect() { return stage.effect; },
    get dirty() { return snapshot() !== saved; },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; },
    /** Select scene i. A preview only lasts while its scene stays selected. */
    select: (i: number) => { if (stage.preview !== i) stage.preview = null; set({ selected: i }); },
    /** Whether the timeline driver can ever show scene i (the scroll driver needs a section for it). */
    reachable: (i: number) => {
      const d = stage.effect.timeline.driver;
      return d.type !== "scroll" || document.querySelectorAll(d.sections).length > i;
    },
    /**
     * Select scene i and show it: goTo for the api driver, scroll to its section for the scroll
     * driver. A scene the driver can't reach is previewed instead, until the page scrolls.
     */
    goTo: (i: number) => {
      set({ selected: i });
      const d = stage.effect.timeline.driver;
      const section = d.type === "scroll" ? document.querySelectorAll(d.sections)[i] : null;
      stage.preview = null;
      if (section) section.scrollIntoView({ behavior: "smooth" });
      else if (d.type === "scroll") stage.preview = i;
      else if (d.type === "api") stage.goTo(i);
    },
    setPicking: (v: boolean) => set({ picking: v }),
    flash: (status: string, error = false) => { set({ status, error }); setTimeout(() => { if (state.status === status) set({ status: "" }); }, 4000); },
    apply,
    /** Replace scene i (a function of the old one). */
    editScene: (i: number, fn: (s: SceneConfig) => SceneConfig, key = "") =>
      apply({ scenes: stage.effect.scenes.map((s, j) => (j === i ? fn(structuredClone(s)) : s)) }, key),
    undo: async () => { const s = undo.pop(); if (!s) return; redo.push(snapshot()); await restore(s); },
    redo: async () => { const s = redo.pop(); if (!s) return; undo.push(snapshot()); await restore(s); },
    save: async () => {
      try {
        const sparse = sparseEffect(stage.effect);
        await storage.save(sparse);
        saved = JSON.stringify(sparse);
        set({ status: "Saved", error: false });
        setTimeout(() => { if (state.status === "Saved") set({ status: "" }); }, 2000);
      } catch (e) {
        set({ status: e instanceof Error ? e.message : String(e), error: true });
      }
    },
    emit,
  };
}
