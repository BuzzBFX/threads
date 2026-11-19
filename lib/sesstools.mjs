// The tool tag and the open background jobs of one transcript, names only:
//   tool  = the newest tool call of the session's own turns: {k: 'tool'|'skill'|'helper'|'mcp', name}
//   skill = the newest skill it called ('' when none)
//   bg    = background jobs launched in the last BG_MAX_MS whose notification has not come yet
//   bgw   = the newest of those that are commands (not helpers): {tool, prog?, script?, since}, names and a time only
//   did   = what it did so far: {calls: [{k, name, n}], scripts: [name], files, errors}, names and counts only
// A notification can land in the next session of the same folder, so the folder's notifications count too; the cap
// keeps an orphan job from reading as running for ever.
import path from 'node:path';
import { ls, statSafe } from './util.mjs';
import { createTail } from './tail.mjs';
import * as source from './sources/index.mjs';

export const BG_MAX_MS = 3 * 3600000;
const tail = createTail();
const states = new Map(); // file -> state

export const fresh = (side = false) => ({ side, tool: null, skill: '', launch: new Map(), uses: new Map(), closed: new Set(), calls: new Map(), scripts: new Map(), files: new Set(), errors: 0 });
/** A state's counts -> {calls: [{k, name, n}], scripts: [name], files, errors}; the most called first. */
export function didOf(S) {
  const calls = [...S.calls].map(([key, n]) => { const [k, name] = key.split('\n'); return { k, name, n }; }).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const scripts = [...S.scripts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  return { calls, scripts, files: S.files.size, errors: S.errors || 0 };
}
const NO_DID = () => ({ calls: [], scripts: [], files: 0, errors: 0 });

async function stateOf(file, st, side = false) {
  const s = st || (await statSafe(file));
  if (!s) return null;
  let S = states.get(file);
  if (!S) { S = fresh(side); states.set(file, S); }
  await tail.read(file, s, (line) => source.feedLine(S, line), () => { const n = fresh(side); Object.assign(S, n); });
  if (states.size > 400) { const k = states.keys().next().value; states.delete(k); tail.forget(k); }
  return S;
}

export const BGW_MAX = 4;
/** One transcript -> {tool, skill, bg, bgw, did}. closed: more tool-use ids known to be over. side: a helper's own file. */
export async function sessionTools(file, st = null, now = Date.now(), { closed = null, side = false } = {}) {
  const S = await stateOf(file, st, side);
  if (!S) return { tool: null, skill: '', bg: 0, bgw: [], did: NO_DID() };
  let bg = 0;
  const bgw = [];
  for (const [id, L] of S.launch) {
    if (S.closed.has(id) || (closed && closed.has(id)) || !L || !L.t || now - L.t >= BG_MAX_MS) continue;
    bg++;
    if (L.k !== 'helper') bgw.push({ tool: L.tool, ...(L.prog ? { prog: L.prog } : {}), ...(L.script ? { script: L.script } : {}), since: L.t });
  }
  bgw.sort((a, b) => b.since - a.since);
  return { tool: S.tool ? { k: S.tool.k, name: S.tool.name } : null, skill: S.skill, bg, bgw: bgw.slice(0, BGW_MAX), did: didOf(S) };
}

/** The tool-use ids closed by a notification in any transcript of a folder written in the last BG_MAX_MS. */
export async function folderClosed(dir, now = Date.now()) {
  const out = new Set();
  for (const e of await ls(dir)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const f = path.join(dir, e.name);
    const st = await statSafe(f);
    if (!st || now - st.mtimeMs > BG_MAX_MS) continue;
    const S = await stateOf(f, st);
    if (S) for (const id of S.closed) out.add(id);
  }
  return out;
}

