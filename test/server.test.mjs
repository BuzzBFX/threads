// The server in a child process, on synthetic homes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, startServer, until } from './helpers.mjs';
import { makeHome } from './fixtures.mjs';
import { nodeId } from '../lib/states.mjs';

const GETS = ['/api/ping', '/api/brain', '/api/details', '/api/tools', '/api/team'];

test('server: empty home', async () => {
  const h = makeHome(tmpDir(), Date.now(), { empty: true });
  const s = await startServer(h);
  try {
    const page = await s.raw('GET', '/');
    assert.equal(page.status, 200);
    assert.equal(s.token.length, 32);
    for (const p of GETS) assert.equal((await s.get(p)).status, 200, p);
    const B = (await s.get('/api/brain')).json;
    assert.equal(B.empty, true);
    assert.deepEqual(B.nodes, []);
    assert.deepEqual(B.counts, { run: 0, await: 0, wait: 0, idle: 0, done: 0, check: 0, look: 0 });
    const T = (await s.get('/api/tools')).json;
    for (const k of ['skills', 'helpers', 'mcp', 'hooks', 'commands', 'plugins', 'own']) assert.deepEqual(T[k], [], k);
    assert.deepEqual((await s.get('/api/team')).json.helpers, []);
    const D = await until(async () => { const d = (await s.get('/api/details')).json; return d.pending ? null : d; });
    assert.ok(D);
    assert.equal(D.days.length, 14);
    assert.ok(D.days.every((d) => Object.keys(d.models).length === 0));
  } finally { await s.stop(); }
});

test('server: full home', async () => {
  const h = makeHome(tmpDir(), Date.now());
  const s = await startServer(h);
  try {
    const B = (await s.get('/api/brain')).json;
    const st = (k) => { const n = B.nodes.find((x) => x.id === nodeId(h.ids[k])); return n ? n.st : null; };
    assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5'].map(st),
      ['run', 'idle', 'run', 'idle', null, null, 'await', 'run', 'idle', 'wait', null]);
    const a2 = nodeId(h.ids.A2);
    const r = await s.post('/api/seen', { id: a2, name: 'alpha session' });
    assert.equal(r.status, 200);
    let B2 = (await s.get('/api/brain')).json;
    assert.ok(!B2.nodes.some((n) => n.id === a2));
    assert.ok(B2.done.some((d) => d.id === a2));
    const a4 = nodeId(h.ids.A4);
    assert.equal((await s.post('/api/park', { id: a4, name: 'alpha later', until: '' })).status, 200);
    B2 = (await s.get('/api/brain')).json;
    assert.ok(!B2.nodes.some((n) => n.id === a4));
    assert.ok(B2.parked.some((p) => p.id === a4));
    assert.equal((await s.post('/api/park', { id: a4, unpark: true })).status, 200);
    B2 = (await s.get('/api/brain')).json;
    assert.ok(B2.nodes.some((n) => n.id === a4));
    const file = path.join(h.claudeDir, 'agents', 'reviewer.md');
    const before = fs.readFileSync(file, 'utf8').split('\r\n');
    const t = await s.post('/api/team', { helper: 'reviewer', model: 'opus' });
    assert.equal(t.status, 200);
    const after = fs.readFileSync(file, 'utf8').split('\r\n');
    assert.equal(before.filter((l, i) => l !== after[i]).length, 1);
    const ready = await until(async () => (await s.get('/api/tools')).json.usage === 'ready');
    assert.ok(ready, 'tools reach ready');
    const D = await until(async () => { const d = (await s.get('/api/details')).json; return d.pending ? null : d; });
    assert.ok(D, 'details stop pending');
  } finally { await s.stop(); }
});

test('server: guards', async () => {
  const h = makeHome(tmpDir(), Date.now());
  const s = await startServer(h);
  try {
    assert.equal((await s.raw('GET', '/api/brain')).status, 401);
    assert.equal((await s.get('/api/brain', { Host: 'evil.example:80' })).status, 403);
    assert.equal((await s.get('/api/brain', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await s.post('/api/seen', { id: 'x' }, { Origin: '' })).status, 403);
    assert.equal((await s.post('/api/seen', '{}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await s.post('/api/seen', JSON.stringify({ id: 'x'.repeat(2000) }))).status, 413);
    assert.equal((await s.post('/api/seen', '{bad')).status, 400);
    assert.equal((await s.post('/api/seen', { id: 's-0000000000000000', what: 1 })).status, 400);
    assert.equal((await s.post('/api/team', { helper: '../x', model: 'opus' })).status, 400);
    assert.equal((await s.get('/api/nope')).status, 404);
    assert.equal((await s.raw('PUT', '/')).status, 405);
    assert.equal((await s.raw('GET', '/../server.mjs')).status, 404);
    assert.equal((await s.raw('GET', '/%2e%2e/server.mjs')).status, 404);
    const hd = (await s.raw('GET', '/')).headers;
    assert.ok(hd['content-security-policy'] && hd['x-frame-options'] && hd['x-content-type-options']);
    assert.match(hd['content-security-policy'], /frame-src 'none'/);
  } finally { await s.stop(); }
  const ro = await startServer({ ...h, args: ['--read-only'] });
  try {
    assert.equal((await ro.post('/api/seen', { id: nodeId(h.ids.A2) })).status, 403);
    assert.equal((await ro.post('/api/name', { label: 'beta', name: 'Bob' })).status, 403);
    assert.ok(!fs.existsSync(ro.configFile), 'read-only writes no config');
  } finally { await ro.stop(); }
});

test('server: a job\'s outputs open through a stubbed opener; unknown ids, a gone file, a bad token and read-only are refused; Done, I\'ve handled it clears needs you', async () => {
  const root = tmpDir();
  const h = makeHome(root, Date.now(), { marks: true });
  const opened = path.join(tmpDir(), 'opened.txt');
  const s = await startServer({ ...h, env: { THREADS_TEST_OPENER: opened } });
  const log = () => { try { return fs.readFileSync(opened, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  try {
    const B = (await s.get('/api/brain')).json;
    const g = B.jobs.find((j) => j.job === 'Gallery'), builder = B.jobs.find((j) => j.job === 'builder');
    assert.equal(g.outputs.length, 3);
    const r = await s.post(`/api/jobs/${g.id}/open`, { output: 0 });
    assert.equal(r.status, 200); assert.equal(r.json.kind, 'html');
    assert.ok(!r.text.includes(root), 'the answer never holds the path');
    assert.equal((await s.post(`/api/jobs/${g.id}/open`, { output: 2 })).status, 200);
    assert.deepEqual(log(), [h.outputs.page, h.outputs.url]);
    // refused: an id not on the tree, a malformed id, a body that names a file, a bad or missing token, no Origin
    assert.equal((await s.post('/api/jobs/j-0000000000000000/open', {})).status, 404);
    assert.equal((await s.post('/api/jobs/../open', {})).status, 404);
    assert.equal((await s.post(`/api/jobs/${g.id}/open`, { output: 0, path: h.outputs.page })).status, 400);
    assert.equal((await s.post(`/api/jobs/${g.id}/open`, {}, { 'X-Threads-Token': 'x'.repeat(32) })).status, 401);
    assert.equal((await s.raw('POST', `/api/jobs/${g.id}/open`, { headers: { Origin: s.origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await s.post(`/api/jobs/${g.id}/open`, {}, { Origin: '' })).status, 403);
    assert.equal((await s.get(`/api/jobs/${g.id}/open`)).status, 405);
    // the file is gone: refused, and the page no longer lists it
    fs.rmSync(h.outputs.page);
    const gone = await s.post(`/api/jobs/${g.id}/open`, { output: 2 });
    assert.equal(gone.status, 404);
    assert.equal((await s.get('/api/brain')).json.jobs.find((j) => j.id === g.id).outputs.length, 2);
    assert.equal(log().length, 2, 'nothing more was opened');
    // Done, I've handled it
    assert.equal(builder.st, 'await');
    assert.equal((await s.post(`/api/jobs/${g.id}/handled`, {})).status, 404, 'a job that does not need you');
    assert.equal((await s.post(`/api/jobs/${builder.id}/handled`, { x: 1 })).status, 400);
    assert.equal((await s.post(`/api/jobs/${builder.id}/handled`, {})).status, 200);
    const after = (await s.get('/api/brain')).json.jobs.find((j) => j.id === builder.id);
    assert.equal(after.st, 'done'); assert.equal(after.needs, undefined);
  } finally { await s.stop(); }
  const h2 = makeHome(tmpDir(), Date.now(), { marks: true });
  const ro = await startServer({ ...h2, args: ['--read-only'], env: { THREADS_TEST_OPENER: opened } });
  try {
    const B = (await ro.get('/api/brain')).json;
    const g = B.jobs.find((j) => j.job === 'Gallery'), builder = B.jobs.find((j) => j.job === 'builder');
    assert.equal((await ro.post(`/api/jobs/${g.id}/open`, {})).status, 403);
    assert.equal((await ro.post(`/api/jobs/${builder.id}/handled`, {})).status, 403);
    assert.equal(log().length, 2, 'read-only opens nothing');
  } finally { await ro.stop(); }
});
