// The studio's styles, injected into its shadow root.

export const CSS = /* css */ `
:host { all: initial; }
.root {
  --bg: rgba(18, 18, 20, 0.92); --bg2: rgba(255, 255, 255, 0.06); --line: rgba(255, 255, 255, 0.12);
  --fg: #ececec; --dim: rgba(236, 236, 236, 0.55); --accent: #ff7a3d; --warn: #ffcf5a; --err: #ff6b6b;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg);
  position: fixed; inset: 0; pointer-events: none;
}
* { box-sizing: border-box; }
.panel { position: fixed; pointer-events: auto; background: var(--bg); backdrop-filter: blur(8px); border: 1px solid var(--line); }
button, .button { font: inherit; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; cursor: pointer; white-space: nowrap; }
button:hover:not(:disabled), .button:hover { border-color: rgba(255,255,255,0.35); }
button:disabled { opacity: 0.35; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #111; }
.dim { color: var(--dim); }
.grow { flex: 1; }
.hint { color: var(--dim); margin: 4px 0; }
.warn { color: var(--warn); margin: 4px 0; }
code { color: var(--fg); }
b { font-weight: 700; }

.top { top: 8px; left: 8px; right: 8px; height: 34px; border-radius: 8px; display: flex; align-items: center; gap: 8px; padding: 0 8px; }
.top .status { color: var(--dim); max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top .status.err { color: var(--err); white-space: normal; max-width: 48ch; }
.hud { font-variant-numeric: tabular-nums; }
.reveal { bottom: 12px; left: 12px; border-radius: 6px; padding: 4px 10px; background: var(--bg); }

.left { top: 50px; left: 8px; width: 200px; max-height: calc(100vh - 116px); border-radius: 8px; padding: 8px; overflow: auto; }
.left.drop { outline: 2px dashed var(--accent); }
.head { font-weight: 700; margin-bottom: 6px; }
button.head.fold { display: block; width: 100%; text-align: left; background: none; border: none; padding: 0; margin: 0; }
.left:has(> button.head.fold:only-child) .head { margin: 0; }
.tabs button.fold { margin-left: auto; }
.scenes { list-style: none; margin: 0; padding: 0; }
.scenes li { display: flex; gap: 6px; padding: 3px 5px; border-radius: 4px; cursor: pointer; }
.scenes li:hover { background: var(--bg2); }
.scenes li.sel { background: rgba(255, 122, 61, 0.22); }
.scenes .idx { color: var(--dim); width: 1.5em; text-align: right; }
.scenes .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }

.right { top: 50px; right: 8px; width: 320px; max-height: calc(100vh - 116px); border-radius: 8px; display: flex; flex-direction: column; }
.tabs { display: flex; gap: 2px; padding: 6px; border-bottom: 1px solid var(--line); }
.tabs button { border: none; background: none; color: var(--dim); }
.tabs button.on { color: var(--fg); background: var(--bg2); }
.body { overflow: auto; padding: 4px 8px 8px; }
.group { border-bottom: 1px solid var(--line); padding: 4px 0; }
.group > summary { cursor: pointer; font-weight: 700; padding: 3px 0; list-style: none; }
.group > summary::before { content: "▸ "; color: var(--dim); }
.group[open] > summary::before { content: "▾ "; }
.rows { display: flex; flex-direction: column; gap: 3px; padding: 2px 0 4px; }
.row { display: grid; grid-template-columns: 92px 1fr 62px; align-items: center; gap: 6px; }
.row > span:first-child { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row input[type=range] { width: 100%; accent-color: var(--accent); }
.row input.num { width: 100%; font: inherit; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 3px; padding: 1px 3px; text-align: right; }
.row span.num { color: var(--dim); }
.row input.text, .row select { width: 100%; font: inherit; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 3px; padding: 1px 4px; }
.row select option { background: #222; }
.row input[type=color] { width: 100%; height: 20px; padding: 0; border: 1px solid var(--line); background: none; }
.row input[type=checkbox] { justify-self: start; accent-color: var(--accent); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btns { display: flex; flex-wrap: wrap; gap: 4px; }
.btns.wide { grid-column: 1 / 4; }
.bps { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.bp { display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 10px; color: var(--dim); }
.bp.on { color: var(--fg); border-color: var(--accent); }
.bp .x { border: none; background: none; padding: 0 2px; color: var(--dim); }

.bottom { left: 8px; right: 8px; bottom: 8px; height: 40px; border-radius: 8px; display: flex; align-items: center; gap: 0; padding: 0 8px; overflow-x: auto; }
.block { position: relative; overflow: hidden; min-width: 90px; height: 26px; padding: 0 8px; text-align: left; }
.block .fill { position: absolute; inset: 0 auto 0 0; background: rgba(255, 122, 61, 0.35); pointer-events: none; }
.block .label { position: relative; }
.block.sel { border-color: var(--accent); }
.link { width: 18px; height: 1px; background: var(--line); flex: none; }

.overlay { position: fixed; inset: 0; pointer-events: none; }
.box { position: fixed; border: 1px dashed rgba(255, 122, 61, 0.45); pointer-events: auto; cursor: pointer; transform-origin: center; }
.box .tag { position: absolute; left: -1px; top: -18px; padding: 1px 5px; background: rgba(18,18,20,0.75); color: var(--fg); border-radius: 3px; white-space: nowrap; }
.box.selected { border: 1.5px solid var(--accent); cursor: move; }
.box.selected .tag { background: var(--accent); color: #111; }
.h { position: absolute; width: 12px; height: 12px; background: var(--accent); border: 2px solid #111; border-radius: 2px; }
.h.scale { right: -7px; bottom: -7px; cursor: nwse-resize; }
.h.rotate { left: 50%; top: -30px; margin-left: -6px; border-radius: 50%; cursor: grab; }
.h.rotate::after { content: ""; position: absolute; left: 3px; top: 10px; width: 1px; height: 12px; background: var(--accent); }
.bound { position: fixed; outline: 1px dotted rgba(120, 180, 255, 0.7); pointer-events: none; }
.pick { position: fixed; background: rgba(120, 180, 255, 0.18); outline: 2px solid rgba(120, 180, 255, 0.9); pointer-events: none; }
`;
