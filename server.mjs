#!/usr/bin/env node
// Threads: a local page of your Claude Code sessions. Listens on 127.0.0.1 only, reads local files, sends nothing.
// Every /api/* answer holds numbers and names only: counts, times, state, model and effort words, tool / skill /
// helper / MCP server / hook / plugin / command names, script file names, frontmatter description lines, project
// labels and the display names set for them in config.json, a session's own --task label, a helper's own short label and its job's name
// (each cleaned, 48 characters at most), a job's outcome line and "needs you" reason (the lead's own words, 80 at most),
// whether a job has an output with its label and type word (never its path) and hashed ids. AGENTS.md has the full list.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE, readConfig, setProjectName } from './lib/config.mjs';
import { createUsageCache, loadPrices } from './lib/usage.mjs';
import { collect, buildBrain } from './lib/brain.mjs';
import { createDetailsReader, spendOf } from './lib/details.mjs';
import { createUsageReader } from './lib/toolusage.mjs';
import { listTools } from './lib/tools.mjs';
import { readTeam, modelsFor, setTeam, lastChanges, EFFORTS } from './lib/team.mjs';
import { markSeen, markPark, markHandled, pruneLive } from './lib/states.mjs';
import { readOutputs, openOutput, systemOpener } from './lib/outputs.mjs';
import * as source from './lib/sources/index.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
const PORTS = Array.from({ length: 11 }, (_, i) => 4848 + i);
const log = (msg) => console.log(`[threads] ${msg}`);
const logErr = (msg) => console.error(`[threads] ${msg}`);

const args = parseArgs(process.argv.slice(2));
if (args.error) { console.error(`[threads] ${args.error}\n${USAGE}`); process.exit(2); }
if (args.help) { console.log(USAGE); process.exit(0); }
if (args.version) { console.log(VERSION); process.exit(0); }

const CONFIG = path.resolve(args.configFile || path.join(ROOT, 'config.json'));
const P = source.locate({ claudeDir: args.claudeDir || undefined, extraDirs: readConfig(CONFIG).claudeDirs });
const DATA = path.resolve(args.dataDir || path.join(ROOT, 'data'));
const CATALOG = path.resolve(args.catalogFile || path.join(ROOT, 'tools-catalog.json'));
const READ_ONLY = args.readOnly;
const PRICES = loadPrices();
const cache = createUsageCache();
const details = createDetailsReader({ P, cache, prices: PRICES });
const toolUse = createUsageReader(P.projectsDir);
const TOKEN = crypto.randomBytes(24).toString('base64url');
const TOKEN_BUF = Buffer.from(TOKEN);
let PORT = 0;

// ---------------------------------------------------------------- http helpers
const CSP = ["default-src 'self'", "img-src 'self' data:", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "font-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "frame-src 'none'"].join('; ');

function commonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const fail = (res, status, error) => sendJson(res, status, { ok: false, error });
function tokenOk(req) {
  const got = req.headers['x-threads-token'];
  if (typeof got !== 'string') return false;
  const buf = Buffer.from(got);
  return buf.length === TOKEN_BUF.length && crypto.timingSafeEqual(buf, TOKEN_BUF);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error('body too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

let indexCache = { mtimeMs: 0, html: '' };
async function serveIndex(res, head) {
  const file = path.join(PUBLIC, 'index.html');
  const st = await fsp.stat(file);
  if (st.mtimeMs !== indexCache.mtimeMs) indexCache = { mtimeMs: st.mtimeMs, html: await fsp.readFile(file, 'utf8') };
  const html = indexCache.html.replace(/__THREADS_TOKEN__/g, TOKEN);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(head ? undefined : html);
}
async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return fail(res, 400, 'bad path'); }
  if (rel.includes('\0')) return fail(res, 400, 'bad path');
  if (rel === '/' || rel.toLowerCase() === '/index.html') return serveIndex(res, req.method === 'HEAD');
  const file = path.resolve(PUBLIC, '.' + rel.replace(/\\/g, '/'));
  if (!file.startsWith(PUBLIC + path.sep)) return fail(res, 404, 'not found');
  const ext = path.extname(file).toLowerCase();
  if (path.basename(file).startsWith('.') || !TYPES[ext]) return fail(res, 404, 'not found');
  let st;
  try { st = await fsp.stat(file); } catch { return fail(res, 404, 'not found'); }
  if (!st.isFile()) return fail(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': TYPES[ext], 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------- data
// one collect() result is shared for 2 seconds
let shared = null, sharedAt = 0, sharedRun = null;
function collected() {
  if (shared && Date.now() - sharedAt < 2000) return Promise.resolve(shared);
  if (!sharedRun) {
    sharedRun = (async () => {
      const team = await readTeam(P.agentsDir);
      const r = await collect({ P, cache, prices: PRICES, team, now: Date.now() });
      shared = { ...r, team };
      sharedAt = Date.now();
      return shared;
    })().finally(() => { sharedRun = null; });
  }
  return sharedRun;
}
async function brainNow() {
  const c = await collected();
  const d = details.current();
  const cfg = readConfig(CONFIG);
  const keys = new Map(); // j-id -> "<session>\n<job>", kept on the server
  const B = await buildBrain(c.sess, { dataDir: DATA, total: c.total, team: c.team, spend: d ? spendOf(d) : null, pricesAsOf: (PRICES && PRICES.as_of) || '', names: cfg.projectNames, groups: cfg.jobGroups, keys, now: Date.now() });
  const onTree = new Set(B.jobs.map((j) => j.id));
  for (const id of keys.keys()) if (!onTree.has(id)) keys.delete(id);
  return { c, B, keys };
}
const OPENER = systemOpener();

const GET_ROUTES = {
  '/api/brain': async () => (await brainNow()).B,
  '/api/details': async () => details.current() || { ok: true, pending: true },
  '/api/tools': async () => listTools({ P, catalogFile: CATALOG, usageOf: (m) => toolUse(m), now: Date.now() }),
  '/api/team': async () => {
    const helpers = await readTeam(P.agentsDir);
    return { ok: true, helpers, changes: await lastChanges(path.join(DATA, 'team-changes.jsonl')), models: modelsFor(helpers), efforts: EFFORTS };
  },
};
const POST_ROUTES = {
  '/api/team': (body) => setTeam(body, { agentsDir: P.agentsDir, logFile: path.join(DATA, 'team-changes.jsonl') }),
  '/api/seen': (body) => markSeen(path.join(DATA, 'seen.jsonl'), body),
  '/api/park': (body) => markPark(path.join(DATA, 'parked.jsonl'), body),
  '/api/name': async (body) => setProjectName(CONFIG, body, new Set((await brainNow()).B.projects.map((p) => p.base))),
};
// one job's actions: POST /api/jobs/<j-id>/open {output?: n} opens an output the lead registered; .../handled clears "needs you"
const JOBS = '/api/jobs';
const JOB_ROUTE = /^\/api\/jobs\/(j-[a-f0-9]{16})\/(open|handled)$/;
const JOB_ACTIONS = {
  open: async (id, body) => openOutput({ jobKey: (await brainNow()).keys.get(id), outputs: await readOutputs(path.join(DATA, 'outputs.jsonl')), body, opener: OPENER }),
  handled: async (id, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return { status: 400, body: { ok: false, error: 'expected {}' } };
    const { B, keys } = await brainNow();
    const j = B.jobs.find((x) => x.id === id);
    if (!j || !j.needs) return { status: 404, body: { ok: false, error: 'this job does not need you' } };
    return markHandled(path.join(DATA, 'needs.jsonl'), keys.get(id));
  },
};

async function handle(req, res) {
  commonHeaders(res);
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return fail(res, 403, 'forbidden host');
  const origin = req.headers.origin;
  const own = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  if (origin && !own.includes(String(origin).toLowerCase())) return fail(res, 403, 'forbidden origin');
  const url = new URL(req.url || '/', `http://${host}`);
  const p = url.pathname;

  if (p === '/api/ping') {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return sendJson(res, 200, { app: 'threads', version: VERSION });
  }
  if (p.startsWith('/api/')) {
    if (!tokenOk(req)) return fail(res, 401, 'missing or wrong X-Threads-Token: reload the page');
    const jm = p.startsWith(`${JOBS}/`) ? JOB_ROUTE.exec(p) : null;
    const get = GET_ROUTES[p], post = POST_ROUTES[p] || (jm ? (body) => JOB_ACTIONS[jm[2]](jm[1], body) : null);
    if (!get && !post) return fail(res, 404, 'unknown endpoint');
    if (req.method === 'GET' && get) {
      try { return sendJson(res, 200, await get()); } catch (e) { logErr(`${p} failed: ${e && (e.code || e.name) || 'error'}`); return fail(res, 500, 'internal error'); }
    }
    if (req.method === 'POST' && post) {
      if (!origin) return fail(res, 403, 'missing Origin');
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('application/json')) return fail(res, 415, 'expected application/json');
      let body;
      try { body = JSON.parse(await readBody(req, 1024)); } catch (e) {
        if (e.status === 413) res.setHeader('Connection', 'close');
        return fail(res, e.status || 400, e.status ? e.message : 'invalid JSON');
      }
      if (READ_ONLY) return fail(res, 403, 'started read-only: nothing is written');
      try { const r = await post(body); return sendJson(res, r.status, r.body); } catch (e) { logErr(`${p} failed: ${e && (e.code || e.name) || 'error'}`); return fail(res, 500, 'internal error'); }
    }
    return fail(res, 405, 'method not allowed');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
  return serveStatic(req, res, p);
}

function listen(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => handle(req, res).catch((e) => {
      if (!res.headersSent) fail(res, 500, 'internal error'); else res.destroy();
      logErr(`request failed: ${e && (e.code || e.name) || 'error'}`);
    }));
    srv.once('error', (e) => resolve({ error: e }));
    srv.listen(port, '127.0.0.1', () => resolve({ srv }));
  });
}

function openBrowser(url) {
  const [cmd, argv] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd, argv, { shell: false, detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }); c.on('error', () => {}); c.unref(); } catch { /* open it by hand */ }
}

async function main() {
  let srv = null;
  for (const port of args.port ? [args.port] : PORTS) {
    const r = await listen(port);
    if (r.srv) { srv = r.srv; PORT = port; break; }
    if (args.port && r.error && r.error.code === 'EADDRINUSE') { logErr(`port ${port} is in use`); process.exit(1); }
    if (r.error && r.error.code !== 'EADDRINUSE' && r.error.code !== 'EACCES') { logErr(`server error: ${r.error.code || 'unknown'}`); process.exit(1); }
  }
  if (!srv) { logErr(args.port ? `port ${args.port} is not available` : 'no free port in 4848-4858'); process.exit(1); }
  const url = `http://127.0.0.1:${PORT}/`;
  log(url);
  if (!READ_ONLY) pruneLive(path.join(DATA, 'live')).catch(() => {});
  details.current(); // the first read starts now, so the Details tab is ready sooner
  if (args.open) openBrowser(url);
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
