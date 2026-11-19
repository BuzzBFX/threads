// A job's outputs: the files or local pages the lead session registered for a person to look at
// (hooks/status.mjs --job "<Job>" --output "<absolute path or http(s)://127.0.0.1 URL>" [--output-label "<label>"]).
// The target stays on the server, in <data>/outputs.jsonl; the page gets only that a job has an output, the lead's
// label and a type word from its extension. POST /api/jobs/<j-id>/open opens a registered target on this computer.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lp, one, statSafe } from './util.mjs';

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;
export const OUTPUTS_MAX = 8;
export const KINDS = ['html', 'video', 'image', 'pdf', 'folder', 'url', 'file'];
const EXT = {
  html: ['.html', '.htm'],
  video: ['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.heic', '.tif', '.tiff', '.bmp'],
  pdf: ['.pdf'],
};

/** An http(s) URL on 127.0.0.1 or localhost, with no user or password, as a string; else ''. */
export function localUrl(v) {
  if (typeof v !== 'string' || /[\u0000-\u001f\u007f\s]/.test(v)) return '';
  let u;
  try { u = new URL(v); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return '';
  if (u.username || u.password) return '';
  return u.href;
}
/** An absolute local path with no control characters, normalised; else ''. */
export function localPath(v) {
  if (typeof v !== 'string' || !v || /[\u0000-\u001f\u007f]/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return '';
  return path.isAbsolute(v) ? path.resolve(v) : '';
}
/** The type word of a target: url, folder, or one from its extension (html, video, image, pdf), else file. */
export function kindOf(target, isDir = false) {
  if (localUrl(target)) return 'url';
  if (isDir) return 'folder';
  const ext = path.extname(String(target)).toLowerCase();
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return k;
  return 'file';
}

/**
 * outputs.jsonl -> Map("<session>\n<job, lower case>" -> [{at, target, label}]), the newest first. A target registered
 * again moves to the front with its new label; {clear: true} empties the job's list. Lines whose target is neither an
 * absolute path nor a local URL are dropped. No other key of a line is read.
 */
export function parseOutputs(text) {
  const m = new Map();
  const lines = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o.session !== 'string' || !SESSION_ID.test(o.session) || typeof o.job !== 'string') continue;
    const at = typeof o.at === 'string' ? Date.parse(o.at) : NaN, job = one(o.job, 48).toLowerCase();
    if (!Number.isFinite(at) || !job) continue;
    const target = o.clear === true ? '' : localUrl(o.target) || localPath(o.target);
    if (o.clear !== true && !target) continue;
    lines.push({ at, key: `${o.session}\n${job}`, target, label: one(o.label, 48), clear: o.clear === true });
  }
  lines.sort((a, b) => a.at - b.at);
  for (const l of lines) {
    if (l.clear) { m.set(l.key, []); continue; }
    const list = (m.get(l.key) || []).filter((x) => x.target !== l.target);
    list.unshift({ at: l.at, target: l.target, label: l.label });
    m.set(l.key, list.slice(0, OUTPUTS_MAX));
  }
  for (const [k, v] of m) if (!v.length) m.delete(k);
  return m;
}
export async function readOutputs(file) {
  try { return parseOutputs(await fsp.readFile(lp(file), 'utf8')); } catch { return new Map(); }
}

/** Is a target there to open now? A local URL always is; a path must exist. -> {ok, kind} */
export async function targetNow(target) {
  if (localUrl(target)) return { ok: true, kind: 'url' };
  if (!localPath(target)) return { ok: false, kind: 'file' };
  const st = await statSafe(target);
  return st ? { ok: true, kind: kindOf(target, st.isDirectory()) } : { ok: false, kind: kindOf(target) };
}
/** A job's outputs for the page: [{label, kind}] for the targets there now (never the target itself). */
export async function outputsForPage(list) {
  const out = [];
  for (const x of list || []) {
    const t = await targetNow(x.target);
    if (t.ok) out.push({ label: x.label, kind: t.kind, target: x.target });
  }
  return out;
}

const WIN_UNSAFE = /["&|<>^%!]/;
/** The command that opens a target on this platform: open (macOS), start (Windows), xdg-open (else). -> [cmd, argv] or null */
export function openerFor(target, platform = process.platform) {
  if (platform === 'win32') return WIN_UNSAFE.test(target) ? null : ['cmd', ['/c', 'start', '""', target]];
  if (platform === 'darwin') return ['open', [target]];
  return ['xdg-open', [target]];
}
/** Runs the platform opener, detached. Tests set THREADS_TEST_OPENER to a file: the target is written there instead. */
export function systemOpener(env = process.env) {
  if (env.THREADS_TEST_OPENER) return (target) => { fs.appendFileSync(env.THREADS_TEST_OPENER, `${target}\n`, 'utf8'); return true; };
  return (target) => {
    const c = openerFor(target);
    if (!c) return false;
    try {
      const child = spawn(c[0], c[1], { shell: false, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch { return false; }
  };
}

const bad = (status, error) => ({ status, body: { ok: false, error } });
/**
 * POST /api/jobs/<j-id>/open with body {output?: n}: opens the job's n-th output (0 by default) as registered by the
 * lead. The target is looked up on the server; nothing in the body names a file. -> {status, body} (never the target)
 */
export async function openOutput({ jobKey, outputs, body, opener }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(400, 'expected {output}');
  const extra = Object.keys(body).find((k) => k !== 'output');
  if (extra) return bad(400, `unknown key ${one(extra, 20)}`);
  const n = body.output == null ? 0 : body.output;
  if (!Number.isInteger(n) || n < 0 || n >= OUTPUTS_MAX) return bad(400, 'output is a small number');
  if (!jobKey) return bad(404, 'no such job on the tree');
  const live = await outputsForPage(outputs.get(jobKey) || []);
  const x = live[n];
  if (!x) return bad(404, (outputs.get(jobKey) || []).length ? 'that output is gone: the file is not there any more' : 'this job has no output');
  if (!opener(x.target)) return bad(500, 'could not open it on this computer');
  return { status: 200, body: { ok: true, output: n, kind: x.kind, label: x.label } };
}
