#!/usr/bin/env node
// A session's state for the Threads page, written by Claude Code's hooks or by hand. One file per session:
//   <data>/live/<session id>.json  {session, state, at, sticky?, task?}
// Hook mode reads the hook's JSON from stdin and keeps only session_id (and, for a notification, its type). The prompt
// is never read. The optional task label is the user's own words from --task, never text from a transcript.
//
//   node hooks/status.mjs --hook running|idle|awaiting          from the hooks (see hooks/README.md)
//   node hooks/status.mjs --state awaiting|waiting|running|idle by hand, inside a session
//   node hooks/status.mjs --task "<2-6 words>"                   a short label for the session (48 characters at most)
//   node hooks/status.mjs --job "<Job>" --outcome "<one line>"    what a job came to, in the lead's own words (80 characters
//                                                                at most), kept in <data>/outcomes.jsonl; "" takes it away
//   node hooks/status.mjs --job "<Job>" --needs "<reason>"        the job needs you: its card turns red with this reason
//                                                                (80 characters at most), kept in <data>/needs.jsonl
//   node hooks/status.mjs --job "<Job>" --needs-clear             it does not any more (the card's button does the same)
//   node hooks/status.mjs --job "<Job>" --output "<target>" [--output-label "<label>"]
//                                                                an output to look at: an absolute path that exists or an
//                                                                http(s)://127.0.0.1 or localhost URL, kept in
//                                                                <data>/outputs.jsonl and never sent to the page; the
//                                                                label is 48 characters at most. --output-clear empties it
//   node hooks/status.mjs --print-install                        the settings block for the three hooks
// Options: --session <id> (else CLAUDE_SESSION_ID, else this folder's newest transcript), --claude <dir>, --data <dir>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localUrl, localPath } from '../lib/outputs.mjs';

const STATES = ['awaiting', 'waiting', 'running', 'idle'];
const SID = /^[A-Za-z0-9-]{8,80}$/;
const ASKS = ['permission_prompt', 'elicitation_dialog'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const folderOf = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** The newest transcript of a working folder, as a session id, or ''. */
function newestSession(claudeDir, cwd) {
  const dir = path.join(claudeDir, 'projects', folderOf(cwd));
  let best = '', at = -1, names = [];
  try { names = fs.readdirSync(dir); } catch { return ''; }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const id = n.slice(0, -6);
    if (!SID.test(id)) continue;
    try { const m = fs.statSync(path.join(dir, n)).mtimeMs; if (m > at) { at = m; best = id; } } catch { /* gone */ }
  }
  return best;
}

function readLive(file) {
  try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

/** Merges one change {state?, sticky?, task?} into the session's live file (temp file + rename). -> {file, value} */
export function writeLive(dataDir, session, change = {}, now = Date.now()) {
  if (!SID.test(session || '')) throw new Error('no session id');
  const dir = path.join(dataDir, 'live');
  const file = path.join(dir, `${session}.json`);
  const prev = readLive(file);
  const prevAt = Date.parse(prev.at);
  const onlyTask = change.state == null && change.task != null && Number.isFinite(prevAt);
  const next = { session, state: STATES.includes(prev.state) ? prev.state : 'running', at: onlyTask ? prev.at : new Date(now).toISOString() };
  if (change.state != null) next.state = change.state;
  const sticky = change.sticky != null ? change.sticky === true : prev.sticky === true;
  if (sticky) next.sticky = true;
  const task = change.task != null ? clean(change.task, 48) : clean(prev.task, 48);
  if (task) next.task = task;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { file, value: next };
}

/** Appends one outcome line {at, session, job, outcome} to <data>/outcomes.jsonl. -> the line */
export function writeOutcome(dataDir, session, job, outcome, now = Date.now()) {
  if (!SID.test(session || '')) throw new Error('no session id');
  const line = { at: new Date(now).toISOString(), session, job: clean(job, 48), outcome: clean(outcome, 80) };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, 'outcomes.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  return line;
}

/** Appends one "needs you" line {at, session, job, needs} to <data>/needs.jsonl; an empty reason clears it. -> the line */
export function writeNeeds(dataDir, session, job, reason, now = Date.now()) {
  if (!SID.test(session || '')) throw new Error('no session id');
  const line = { at: new Date(now).toISOString(), session, job: clean(job, 48), needs: clean(reason, 80) };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, 'needs.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  return line;
}

/** A target the page may open: a local URL, or an absolute path that exists. -> the normalised target or '' */
export function outputTarget(v) {
  const u = localUrl(v);
  if (u) return u;
  const p = localPath(v);
  return p && fs.existsSync(p) ? p : '';
}
/** Appends one output line {at, session, job, target, label} (or {clear: true}) to <data>/outputs.jsonl. -> the line */
export function writeOutput(dataDir, session, job, target, label = '', now = Date.now()) {
  if (!SID.test(session || '')) throw new Error('no session id');
  const at = new Date(now).toISOString();
  const line = target == null ? { at, session, job: clean(job, 48), clear: true } : { at, session, job: clean(job, 48), target, label: clean(label, 48) };
  if (target != null && !outputTarget(target)) throw new Error('not an output target');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, 'outputs.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  return line;
}

/** The hook's stdin JSON -> {session, type} or null. Nothing else is kept. */
function hookInput(text) {
  let o = null;
  try { o = JSON.parse(String(text || '')); } catch { return null; }
  if (!o || typeof o !== 'object' || typeof o.session_id !== 'string' || !SID.test(o.session_id)) return null;
  return { session: o.session_id, type: typeof o.notification_type === 'string' ? o.notification_type : '' };
}

/** The settings block that runs this file from the three hooks. */
function installSnippet(scriptPath = fileURLToPath(import.meta.url)) {
  const p = path.resolve(scriptPath).replace(/\\/g, '/');
  const cmd = (state) => [{ hooks: [{ type: 'command', command: `node "${p}" --hook ${state}`, timeout: 5 }] }];
  return { hooks: { UserPromptSubmit: cmd('running'), Stop: cmd('idle'), Notification: cmd('awaiting') } };
}

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; }
const USAGE = 'usage: node hooks/status.mjs --state awaiting|waiting|running|idle [--task "<2-6 words>"] [--session <id>] [--claude <dir>] [--data <dir>]\n'
  + '       node hooks/status.mjs --job "<Job>" --outcome "<one line, 80 characters at most>" [--session <id>] [--data <dir>]\n'
  + '       node hooks/status.mjs --job "<Job>" --needs "<reason, 80 characters at most>" | --needs-clear\n'
  + '       node hooks/status.mjs --job "<Job>" --output "<absolute path or http(s)://127.0.0.1 URL>" [--output-label "<label>"] | --output-clear\n'
  + '       node hooks/status.mjs --hook running|idle|awaiting   (from the hooks)\n'
  + '       node hooks/status.mjs --print-install';

export async function main(argv = process.argv.slice(2), env = process.env, { stdin = null, out = console.log, err = console.error } = {}) {
  const dataDir = path.resolve(arg(argv, '--data') || env.THREADS_DATA || path.join(HERE, '..', 'data'));
  if (argv.includes('--print-install')) { out(JSON.stringify(installSnippet(), null, 2)); return 0; }
  const hook = arg(argv, '--hook');
  if (hook != null) {
    // a hook never fails the session: every problem ends quietly with 0
    try {
      if (!['running', 'idle', 'awaiting'].includes(hook)) return 0;
      const raw = stdin != null ? stdin : fs.readFileSync(0, 'utf8');
      const h = hookInput(raw);
      if (!h) return 0;
      const prev = readLive(path.join(dataDir, 'live', `${h.session}.json`));
      if (hook === 'running') writeLive(dataDir, h.session, { state: 'running', sticky: false });
      else if (hook === 'idle') { if (!(prev.sticky === true && (prev.state === 'awaiting' || prev.state === 'waiting'))) writeLive(dataDir, h.session, { state: 'idle', sticky: false }); }
      else if (ASKS.includes(h.type) && prev.sticky !== true) writeLive(dataDir, h.session, { state: 'awaiting', sticky: false });
    } catch { /* the session goes on */ }
    return 0;
  }
  const state = arg(argv, '--state'), task = arg(argv, '--task'), job = arg(argv, '--job');
  const val = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  const outcome = val('--outcome'), needs = val('--needs'), output = val('--output'), outputLabel = val('--output-label');
  const needsClear = argv.includes('--needs-clear'), outputClear = argv.includes('--output-clear');
  const jobPart = outcome != null || needs != null || needsClear || output != null || outputClear;
  if (state == null && task == null && job == null && !jobPart) { err(USAGE); return 2; }
  if (job == null && jobPart) { err('--outcome, --needs, --needs-clear, --output and --output-clear need --job "<Job>"'); return 2; }
  if (job != null && !jobPart) { err('--job "<Job>" needs --outcome, --needs, --needs-clear, --output or --output-clear'); return 2; }
  if (job != null && !clean(job, 48)) { err('the job name is empty'); return 2; }
  if (needs != null && needsClear) { err('--needs or --needs-clear, not both'); return 2; }
  if (outputLabel != null && output == null) { err('--output-label goes with --output'); return 2; }
  if (output != null && outputClear) { err('--output or --output-clear, not both'); return 2; }
  if (output != null && !outputTarget(output)) { err('the output is an absolute path that exists, or an http(s) URL on 127.0.0.1 or localhost'); return 2; }
  if (state != null && !STATES.includes(state)) { err('the state is awaiting, waiting, running or idle'); return 2; }
  if (task != null && !clean(task, 48)) { err('the task label is empty'); return 2; }
  const claude = arg(argv, '--claude') || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const session = arg(argv, '--session') || env.CLAUDE_SESSION_ID || newestSession(claude, process.cwd());
  if (!SID.test(session || '')) { err('no session id: pass --session, or run this inside a Claude Code session'); return 2; }
  const change = {};
  if (state != null) { change.state = state; change.sticky = state === 'awaiting' || state === 'waiting'; }
  if (task != null) change.task = task;
  if (state != null || task != null) writeLive(dataDir, session, change);
  const said = [];
  if (job != null && outcome != null) { writeOutcome(dataDir, session, job, outcome); said.push('outcome saved'); }
  if (job != null && (needs != null || needsClear)) { writeNeeds(dataDir, session, job, needsClear ? '' : needs); said.push(needsClear || !clean(needs, 80) ? 'needs cleared' : 'needs saved'); }
  if (job != null && output != null) { writeOutput(dataDir, session, job, outputTarget(output), outputLabel || ''); said.push('output saved'); }
  if (job != null && outputClear) { writeOutput(dataDir, session, job, null); said.push('outputs cleared'); }
  if (state != null || task != null) said.unshift('status saved');
  out(said.join(', '));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 0; });
}
