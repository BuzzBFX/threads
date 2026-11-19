// Nothing private may reach the page: every answer of the server on the full synthetic home is searched for the
// planted canaries, session ids, tool-use ids, folder paths and settings values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, startServer, until } from './helpers.mjs';
import { makeHome } from './fixtures.mjs';
import { nodeId } from '../lib/states.mjs';
import { startOfDay } from '../lib/util.mjs';

/**
 * The server reads the real clock, and the fixture writes up to 2 minutes before it. Near local midnight those writes
 * fall on yesterday and today's block is empty, so the test waits until 5 minutes past midnight first (it never waits
 * at any other time of day).
 */
function waitNearMidnight(now) {
  const sod = startOfDay(now), next = startOfDay(sod + 36 * 3600000);
  return now - sod < 5 * 60000 ? sod + 5 * 60000 - now : next - now < 2 * 60000 ? next + 5 * 60000 - now : 0;
}

test('leak: the wait is 0 by day and runs to 00:05 near midnight', () => {
  const sod = startOfDay(Date.now()), MIN = 60000;
  assert.equal(waitNearMidnight(sod + 12 * 60 * MIN), 0);
  assert.equal(waitNearMidnight(sod + MIN), 4 * MIN);
  const next = startOfDay(sod + 36 * 3600000);
  assert.equal(waitNearMidnight(next - MIN), 6 * MIN);
});

test('leak: no canary, id, path or settings value in any answer', async () => {
  const wait = waitNearMidnight(Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const root = tmpDir();
  const h = makeHome(root, Date.now(), { twin: true, many: 3, marks: true, bgdone: true });
  // a job group for a description no helper has never reaches the page, key or value
  const configText = JSON.stringify({ jobGroups: { 'Blender recreation, 6 variations': 'Mint video', 'not a helper CANARY_GROUPKEY': 'CANARY_GROUPJOB' }, other: 'CANARY_CONFIG' });
  const opened = path.join(tmpDir(), 'opened.txt');
  const s = await startServer({ ...h, env: { THREADS_TEST_OPENER: opened }, configText, catalogText: JSON.stringify({ items: [{ name: 'resize', line: 'Resizes', match: 'resize.mjs' }] }) });
  const texts = [];
  try {
    await until(async () => (await s.get('/api/tools')).json.usage === 'ready');
    await until(async () => !(await s.get('/api/details')).json.pending);
    for (const p of ['/api/ping', '/api/brain', '/api/details', '/api/tools', '/api/team', '/', '/app.js', '/styles.css']) texts.push([p, (await s.get(p)).text]);
    texts.push(['seen', (await s.post('/api/seen', { id: nodeId(h.ids.A2), name: 'alpha' })).text]);
    texts.push(['park', (await s.post('/api/park', { id: nodeId(h.ids.A4), until: '' })).text]);
    texts.push(['unpark', (await s.post('/api/park', { id: nodeId(h.ids.A4), unpark: true })).text]);
    const jobs = JSON.parse(texts.find(([w]) => w === '/api/brain')[1]).jobs;
    const gal = jobs.find((j) => j.job === 'Gallery'), needy = jobs.find((j) => j.needs);
    for (const n of [0, 1, 2, 3]) texts.push([`open ${n}`, (await s.post(`/api/jobs/${gal.id}/open`, { output: n })).text]);
    texts.push(['open bad', (await s.post(`/api/jobs/${gal.id}/open`, { path: h.outputs.page })).text]);
    texts.push(['brain needs', (await s.get('/api/brain')).text]);
    texts.push(['handled', (await s.post(`/api/jobs/${needy.id}/handled`, {})).text]);
    const doneJob = jobs.find((j) => j.st === 'done');
    texts.push(['job seen', (await s.post('/api/seen', { id: doneJob.id, name: doneJob.job })).text]);
    texts.push(['job park', (await s.post('/api/park', { id: jobs.find((j) => j.st === 'run').id, until: '' })).text]);
    texts.push(['name', (await s.post('/api/name', { label: 'beta', name: 'Bob' })).text]);
    texts.push(['bad name', (await s.post('/api/name', { label: 'nowhere', name: 'x' })).text]);
    texts.push(['team', (await s.post('/api/team', { helper: 'reviewer', effort: 'high' })).text]);
    texts.push(['bad', (await s.post('/api/team', { helper: 'nobody', effort: 'high' })).text]);
    texts.push(['brain after', (await s.get('/api/brain')).text]);
  } finally { await s.stop(); }
  texts.push(['output', s.output()]);
  const banned = [
    ...Object.values(h.CANARY), ...Object.values(h.ids), ...h.toolUseIds, ...h.folders, ...h.helperFiles,
    ...Object.values(h.outputs), 'f001.png',
    root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\'), 'mcpServers', 'CANARY',
  ];
  assert.ok(Object.keys(h.CANARY).length >= 15);
  for (const [where, text] of texts) for (const b of banned) assert.ok(!text.includes(b), `${where} holds a banned string (${b.slice(0, 12)}...)`);
  assert.ok(texts.find(([w]) => w === '/api/brain')[1].includes('tidy the test data'), 'the session label is allowed');
  // a job's own label (the meta description) is allowed; its other meta fields hold canaries and are searched above
  const B = JSON.parse(texts.find(([w]) => w === '/api/brain')[1]);
  for (const k of ['meta', 'metashape', 'metatooluse', 'metarequest', 'jobprompt', 'jobreply', 'bgpath', 'bgarg', 'bgresult']) assert.ok(h.CANARY[k], `the canary ${k} is planted`);
  assert.ok(B.jobs.some((j) => j.job === 'Mint video' && j.helpers[0].step === 'Blender recreation, 6 variations'), 'the job name from the config and the helper label are allowed');
  // a job: only these keys; its name, steps and outcome are short and clean; what it did is names and counts
  for (const k of ['didpath', 'didprompt', 'didcontent', 'didedit', 'didcwd', 'didarg', 'didcat', 'didskill', 'didmcp', 'diderror', 'didreply', 'outcomenote', 'outcomekey', 'outcomejob', 'outcomesession']) assert.ok(h.CANARY[k], `the canary ${k} is planted`);
  for (const k of ['outputpath', 'outputurl', 'outputnote', 'outputremote', 'outputremotelabel', 'outputrel', 'outputmissing', 'outputgonelabel', 'outputjob', 'needskey', 'needscleared', 'needssession']) assert.ok(h.CANARY[k], `the canary ${k} is planted`);
  // needs you: the lead's reason only; outputs: that there are some, each one's label and type word, never the target
  const JOB_KEYS = ['id', 'kind', 'parent', 'project', 'job', 'role', 'st', 'model', 'effort', 'tokens', 'usd', 'min', 'started', 'at', 'n', 'nDone', 'helpers', 'helperMore', 'did', 'outcome', 'needs', 'hasOutput', 'outputs', 'tool', 'skill', 'bg', 'bgw', 'back'];
  assert.equal(B.jobs.find((j) => j.job === 'builder').needs, 'Pick one of 3 colourways for the hero', 'the reason the lead wrote is allowed');
  assert.deepEqual(B.jobs.find((j) => j.job === 'Gallery').outputs.map((o) => o.label), ['Gallery: 6 pages', 'Frames', 'Preview server'], 'the labels the lead wrote are allowed');
  assert.equal(fs.readFileSync(opened, 'utf8').split('\n').filter(Boolean).length, 3, 'the three registered outputs were opened, through the stub');
  for (const n of B.nodes) if (n.needs != null) assert.ok(Number.isInteger(n.needs));
  for (const p of B.projects) if (p.needs != null) assert.ok(Number.isInteger(p.needs));
  assert.ok(B.nodes.every((n) => n.needsOnly === undefined));
  const HELPER_KEYS = ['role', 'step', 'st', 'model', 'effort', 'tokens', 'usd', 'min', 'calls', 'files', 'errors', 'tool', 'skill'];
  const NAME = /^[A-Za-z0-9_.: -]{1,24}$/, FILE = /^[\w.+-]{1,40}$/, clean = (v, n) => typeof v === 'string' && v.length <= n && !/[\u0000-\u001f\u007f]/.test(v);
  const gallery = B.jobs.find((j) => j.job === 'Gallery');
  assert.equal(gallery.outcome, '6 pages built, links checked', 'the outcome line the lead wrote is allowed');
  assert.deepEqual(gallery.did.scripts, ['build_pages.py']); assert.equal(gallery.did.files, 2); assert.equal(gallery.did.errors, 1);
  for (const j of B.jobs) {
    for (const k of Object.keys(j)) assert.ok(JOB_KEYS.includes(k), `job key ${k}`);
    assert.match(j.id, /^j-[a-f0-9]{16}$/); assert.match(j.parent, /^s-/); assert.ok(clean(j.job, 48) && j.job, 'a short, clean job name');
    if (j.outcome != null) assert.ok(clean(j.outcome, 80));
    if (j.needs != null) assert.ok(clean(j.needs, 80) && j.needs);
    if (j.hasOutput != null || j.outputs != null) {
      assert.equal(j.hasOutput, true); assert.ok(j.outputs.length >= 1 && j.outputs.length <= 8);
      for (const o of j.outputs) { assert.deepEqual(Object.keys(o).sort(), ['kind', 'label']); assert.ok(clean(o.label, 48)); assert.ok(['html', 'video', 'image', 'pdf', 'folder', 'url', 'file'].includes(o.kind)); }
    }
    for (const x of j.helpers) {
      for (const k of Object.keys(x)) assert.ok(HELPER_KEYS.includes(k), `helper key ${k}`);
      assert.ok(clean(x.step, 48)); assert.match(x.role, NAME);
      for (const k of ['calls', 'files', 'errors', 'tokens']) assert.ok(Number.isInteger(x[k]) && x[k] >= 0, k);
    }
    assert.deepEqual(Object.keys(j.did).sort(), ['calls', 'errors', 'files', 'scriptMore', 'scripts', 'total']);
    for (const c of j.did.calls) { assert.deepEqual(Object.keys(c).sort(), ['k', 'n', 'name']); assert.ok(['tool', 'skill', 'helper', 'mcp'].includes(c.k)); assert.match(c.name, NAME); assert.ok(Number.isInteger(c.n)); }
    for (const sname of j.did.scripts) assert.match(sname, FILE);
    for (const k of ['total', 'files', 'errors', 'scriptMore']) assert.ok(Number.isInteger(j.did[k]) && j.did[k] >= 0, k);
  }
  const after = JSON.parse(texts.find(([w]) => w === 'brain after')[1]);
  for (const x of after.done) { for (const k of Object.keys(x)) assert.ok(['id', 'name', 'at', 'outcome'].includes(k), `done key ${k}`); if (x.outcome != null) assert.ok(clean(x.outcome, 80)); }
  // background work: a tool name, a program and a script file name, and a time; never the command, a path or an argument
  const bgw = [...B.jobs, ...B.nodes].flatMap((n) => n.bgw || []);
  assert.ok(bgw.some((x) => x.prog === 'Blender' && x.script === 'render_steps.py'), 'the job shows its background render');
  for (const x of bgw) {
    for (const k of Object.keys(x)) assert.ok(['tool', 'prog', 'script', 'since'].includes(k), k);
    for (const k of ['tool', 'prog', 'script']) if (x[k] != null) assert.match(x[k], /^[A-Za-z0-9._+: -]{1,40}$/);
    assert.ok(Number.isFinite(x.since));
  }
  // the Timeline's `today` block: only hashed ids, project keys, numbers, role / state / model words
  const T = JSON.parse(texts.find(([w]) => w === '/api/brain')[1]).today;
  assert.ok(T.rows.length > 0, 'the today block is searched above');
  const num = (sp) => sp.every((x) => x.length === 2 && x.every(Number.isFinite));
  for (const r of T.rows) {
    assert.deepEqual(Object.keys(r).sort(), ['key', 'lanes']); assert.match(r.key, /^p-/);
    for (const l of r.lanes) {
      assert.deepEqual(Object.keys(l).sort(), ['helpers', 'id', 'spans']); assert.match(l.id, /^s-/); assert.ok(num(l.spans));
      for (const x of l.helpers) { assert.deepEqual(Object.keys(x).sort(), ['id', 'model', 'role', 'spans', 'st']); assert.match(x.id, /^j-/); assert.ok(num(x.spans)); }
    }
  }
});
