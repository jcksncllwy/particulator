/** @jsxImportSource preact */
// The studio root: mounts in a shadow DOM over the page (styles can't leak
// either way), with panels around the edges and handles on the page.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Stage } from "particulator";
import { Overlay } from "./overlay";
import { Inspector, ScenesPanel, TimelineStrip, TopBar } from "./panels";
import { autoStorage, type StorageAdapter } from "./storage";
import { createStore, type Store } from "./store";
import { CSS } from "./styles";

export type StudioOptions = {
  /** Where saves go. Default: the save server at /__particulator if it answers, else File System Access, else download. */
  storage?: StorageAdapter;
  /** Start with the panels hidden (toggle with the ` key). */
  hidden?: boolean;
};

export type Studio = { store: Store; show: (v: boolean) => void; unmount: () => void };

function App({ store, initiallyHidden, onHiddenChange }: { store: Store; initiallyHidden: boolean; onHiddenChange: (fn: (v: boolean) => void) => void }) {
  const [, setN] = useState(0);
  const [hidden, setHidden] = useState(initiallyHidden);
  const [hover, setHover] = useState<DOMRect | null>(null);
  useEffect(() => store.subscribe(() => setN((n) => n + 1)), [store]);
  useEffect(() => onHiddenChange(setHidden), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const path = e.composedPath();
      const typing = path.some((t) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void store.save(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); void (e.shiftKey ? store.redo() : store.undo()); return; }
      if (e.key === "`") { e.preventDefault(); setHidden((h) => !h); }
    };
    // Scrolling the page hands the stage back to the driver.
    const endPreview = (e: Event) => { if ((e.target as Element | null)?.tagName !== "PARTICULATOR-STUDIO" && store.stage.preview !== null) { store.stage.preview = null; store.emit(); } };
    const beforeUnload = (e: BeforeUnloadEvent) => { if (store.dirty) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("wheel", endPreview, { passive: true });
    window.addEventListener("scroll", endPreview, { passive: true, capture: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("wheel", endPreview);
      window.removeEventListener("scroll", endPreview, { capture: true });
    };
  }, [store]);

  if (hidden) return <button class="reveal panel" onClick={() => setHidden(false)} title="Show the studio (`)">particulator{store.dirty ? " •" : ""}</button>;
  return (
    <>
      <Overlay store={store} hover={hover} />
      <TopBar store={store} onHide={() => setHidden(true)} />
      <ScenesPanel store={store} />
      <Inspector store={store} setHover={setHover} />
      <TimelineStrip store={store} />
    </>
  );
}

/** Mount the studio over the page for `stage`. Call from dev builds only. */
export async function mountStudio(stage: Stage, opts: StudioOptions = {}): Promise<Studio> {
  await stage.ready;
  const storage = opts.storage ?? (await autoStorage());
  const store = createStore(stage, storage);

  const host = document.createElement("particulator-studio");
  host.setAttribute("data-particulator-ignore", ""); // presses on the studio don't disrupt the particles
  host.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  const root = document.createElement("div");
  root.className = "root";
  shadow.append(style, root);
  document.body.appendChild(host);

  let setHidden: (v: boolean) => void = () => {};
  render(<App store={store} initiallyHidden={!!opts.hidden} onHiddenChange={(fn) => { setHidden = fn; }} />, root);
  return {
    store,
    show: (v) => setHidden(!v),
    unmount: () => { render(null, root); host.remove(); },
  };
}
