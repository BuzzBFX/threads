// Test helpers: temp folders, a free port, and the server in a child process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still in use */ } } });

/** A fresh folder under the OS temp dir, removed when the process ends. */
export function tmpDir() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-')));
  made.push(d);
  return d;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function request(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Starts node server.mjs on a free port with the given folders. The config and catalog paths always point inside a
 * temp folder, so a developer's own files never enter a test.
 */
export async function startServer({ claudeDir, dataDir, args = [], catalogText = null, configText = null, env = {} }) {
  const port = await freePort();
  const own = tmpDir();
  const catalogFile = path.join(own, 'tools-catalog.json');
  if (catalogText != null) fs.writeFileSync(catalogFile, catalogText);
  const configFile = path.join(own, 'config.json');
  if (configText != null) fs.writeFileSync(configFile, configText);
  const child = spawn(process.execPath, [path.join(REPO, 'server.mjs'), '--port', String(port), '--claude', claudeDir, '--data', dataDir,
    '--catalog', catalogFile, '--config', configFile, ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CONFIG_DIR: '', THREADS_TEST_OPENER: '', ...env } });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the server did not start: ${err.slice(0, 300)}`)), 15000);
    const check = () => { if (out.includes(`http://127.0.0.1:${port}/`)) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`the server exited with ${code}: ${err.slice(0, 300)}`)); });
    check();
  });
  const page = await request(port, 'GET', '/');
  const m = /<meta name="threads-token" content="([^"]+)">/.exec(page.text);
  const token = m ? m[1] : '';
  const origin = `http://127.0.0.1:${port}`;
  return {
    port, token, origin,
    get: (p, headers = {}) => request(port, 'GET', p, { headers: { 'X-Threads-Token': token, ...headers } }),
    post: (p, body, headers = {}) => request(port, 'POST', p, { headers: { 'X-Threads-Token': token, Origin: origin, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    raw: (method, p, opts) => request(port, method, p, opts),
    configFile,
    output: () => out + err,
    stop: () => new Promise((resolve) => { if (child.exitCode != null) return resolve(); child.once('exit', resolve); child.kill(); }),
  };
}

/** Polls fn until it answers truthy (or the time runs out). */
export async function until(fn, ms = 15000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}
