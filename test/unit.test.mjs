// Unit tests. Each name starts with its area, so --test-name-pattern "^<area>:" picks one step's cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, REPO } from './helpers.mjs';
import { makeHome, userLine, assistantLine, toolUse, toolResult, notification, sid } from './fixtures.mjs';
import { writeFileAtomic, appendJsonl, one, addDays, dayKey, startOfDay } from '../lib/util.mjs';
import { createTail } from '../lib/tail.mjs';
import * as source from '../lib/sources/index.mjs';
import { dedupe, usdOf, burstsOf, createUsageCache, loadPrices, mainFamily } from '../lib/usage.mjs';
import { sessionTools, folderClosed, BG_MAX_MS } from '../lib/sesstools.mjs';
import {
  sessionState, sessionShown, weekStart, markSeen, markPark, parseSeen, parsePark, applyPark, parseLive, pruneLive, nodeId, readLiveDir, jobId, jobState,
  helperState, jobSeen, jobOf, parseOutcomes, parseNeeds, countStates,
} from '../lib/states.mjs';
import { main as statusMain, writeLive } from '../hooks/status.mjs';
import { parseOutputs, readOutputs, kindOf, localUrl, localPath, openerFor, openOutput, OUTPUTS_MAX } from '../lib/outputs.mjs';
import { collect, buildBrain, sumDid } from '../lib/brain.mjs';
import { todayTimeline, clipSpans } from '../lib/timeline.mjs';
import { loadDetails, spendOf } from '../lib/details.mjs';
import { countUsage, mergeHints } from '../lib/toolusage.mjs';
import { listTools, parseCatalog } from '../lib/tools.mjs';
import { readTeam, modelsFor, setFrontmatter, setTeam } from '../lib/team.mjs';
import { readConfig, setProjectName } from '../lib/config.mjs';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const NOW = new Date(2026, 2, 11, 15, 0, 0).getTime(); // a Wednesday afternoon, local time
const jl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const touch = (f, t) => fs.utimesSync(f, new Date(t), new Date(t));
const PRICES = loadPrices();

// ---------------------------------------------------------------- util
test('util: atomic write reads back', async () => {
  const f = path.join(tmpDir(), 'a', 'b.txt');
  await writeFileAtomic(f, 'hello\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello\n');
  await writeFileAtomic(f, 'again\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'again\n');
});
test('util: appendJsonl makes the folder', async () => {
  const f = path.join(tmpDir(), 'x', 'y', 'log.jsonl');
  await appendJsonl(f, { a: 1 });
  await appendJsonl(f, { a: 2 });
  assert.deepEqual(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).a), [1, 2]);
});
test('util: one strips control characters', () => {
  assert.equal(one('a\u0000b\n\tc   d', 40), 'a b c d');
  assert.equal(one('abcdef', 3), 'abc');
  assert.equal(one(null, 5), '');
});
test('util: addDays across a month end', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('bad', 1), null);
});

// ---------------------------------------------------------------- tail
test('tail: whole lines only, a half line waits', async () => {
  const f = path.join(tmpDir(), 't.jsonl');
  fs.writeFileSync(f, 'one\ntwo\nthr');
  const t = createTail();
  const got = [];
  await t.read(f, null, (l) => got.push(l));
  assert.deepEqual(got, ['one', 'two']);
  fs.appendFileSync(f, 'ee\r\n');
  await t.read(f, null, (l) => got.push(l));
  assert.deepEqual(got, ['one', 'two', 'three']);
});
test('tail: appended bytes are read once', async () => {
  const f = path.join(tmpDir(), 't.jsonl');
  fs.writeFileSync(f, 'a\n');
  const t = createTail();
  const got = [];
  await t.read(f, null, (l) => got.push(l));
  await t.read(f, null, (l) => got.push(l));
  fs.appendFileSync(f, 'b\n');
  await Promise.all([t.read(f, null, (l) => got.push(l)), t.read(f, null, (l) => got.push(l))]);
  assert.deepEqual(got, ['a', 'b']);
});
test('tail: a shorter file resets', async () => {
  const f = path.join(tmpDir(), 't.jsonl');
  fs.writeFileSync(f, 'long line one\nlong line two\n');
  const t = createTail();
  let got = [];
  await t.read(f, null, (l) => got.push(l));
  fs.writeFileSync(f, 'new\n');
  let reset = 0;
  const r = await t.read(f, null, (l) => got.push(l), () => { reset++; got = []; });
  assert.equal(r.reset, true);
  assert.equal(reset, 1);
  assert.deepEqual(got, ['new']);
});
test('tail: a missing file does not throw', async () => {
  const t = createTail();
  const r = await t.read(path.join(tmpDir(), 'nope.jsonl'), null, () => {});
  assert.equal(r.reset, false);
});

// ---------------------------------------------------------------- source
const C0 = { session: sid(1), cwd: path.join('w', 'p'), entry: 'cli' };
test('source: usageOfLine reads counters, the 1-hour part, side and effort', () => {
  const line = JSON.stringify({ ...assistantLine(C0, NOW, { id: 'msg_1', effort: 'high' }), isSidechain: true });
  const r = source.usageOfLine(line, 'f');
  assert.deepEqual(r, ['msg_1', NOW, 'claude-opus-4-1', 100, 50, 1000, 5000, true, 'high', 400]);
  const odd = JSON.parse(JSON.stringify(assistantLine(C0, NOW, { id: 'msg_2' })));
  odd.effort = 'Not A Word!';
  assert.equal(source.usageOfLine(JSON.stringify(odd), 'f')[8], '');
  const syn = assistantLine(C0, NOW, { model: '<synthetic>' });
  assert.equal(source.usageOfLine(JSON.stringify(syn), 'f'), null);
  assert.equal(source.usageOfLine(JSON.stringify(userLine(C0, NOW, 'usage')), 'f'), null);
});
test('source: toolLabel names skills, helpers, MCP servers and tools', () => {
  assert.deepEqual(source.toolLabel('Skill', { skill: 'plug:my-skill' }), { k: 'skill', name: 'my-skill' });
  assert.deepEqual(source.toolLabel('Agent', { subagent_type: 'reviewer' }), { k: 'helper', name: 'reviewer' });
  assert.deepEqual(source.toolLabel('mcp__claude_ai_Some_Server__do', {}), { k: 'mcp', name: 'Some Server' });
  assert.deepEqual(source.toolLabel('mcp__plugin_x_srv__do', {}), { k: 'mcp', name: 'srv' });
  assert.equal(source.toolLabel('A_very_long_tool_name_that_goes_on', {}).name.length, 24);
});
test('source: eventsOfLine counts skills, helpers, MCP and catalog matches, never results', () => {
  const a = assistantLine(C0, NOW, { content: [toolUse('Skill', { skill: 'pl:Demo-Skill' }, 'toolu_1'), toolUse('Agent', { subagent_type: 'Reviewer' }, 'toolu_2'),
    toolUse('mcp__fixture_mcp__ping', {}, 'toolu_3'), toolUse('Bash', { command: 'node tools/resize.mjs' }, 'toolu_4')] });
  const ev = source.eventsOfLine(JSON.stringify(a), ['resize.mjs']);
  assert.deepEqual(ev.map(([k, n]) => [k, n]), [['skill', 'demo-skill'], ['helper', 'reviewer'], ['mcp', 'fixturemcp'], ['tool', 'resize.mjs']]);
  const res = toolResult(C0, NOW, 'toolu_4', JSON.stringify({ type: 'tool_use', name: 'Skill', input: { skill: 'x' } }));
  assert.deepEqual(source.eventsOfLine(JSON.stringify(res), ['resize.mjs']), []);
});
test('source: sessionHead reads the entry point and the working folder', async () => {
  const d = tmpDir();
  const mk = (name, entry) => { const f = path.join(d, name); fs.writeFileSync(f, jl([{ type: 'x' }, userLine({ ...C0, entry }, NOW, 'hi')])); return f; };
  assert.deepEqual(await source.sessionHead(mk('a.jsonl', 'cli')), { cwd: C0.cwd, entry: 'cli' });
  assert.equal((await source.sessionHead(mk('b.jsonl', 'sdk-cli'))).entry, 'headless');
  assert.equal((await source.sessionHead(mk('c.jsonl', 'ide-thing'))).entry, '');
});
test('source: listSessions keeps the window and counts every file', async () => {
  const h = makeHome(tmpDir(), NOW);
  const P = source.locate({ claudeDir: h.claudeDir });
  const { sessions, total } = await source.listSessions(P, NOW - 4 * HOUR);
  assert.equal(total, 11);
  const ids = sessions.map((s) => s.session);
  assert.ok(ids.includes(h.ids.A6) && !ids.includes(h.ids.B5) && !ids.includes(h.ids.B3));
});
test('source: helperMeta returns the job label, never another meta field', async () => {
  const h = makeHome(tmpDir(), NOW);
  const P = source.locate({ claudeDir: h.claudeDir });
  const sub = path.join(P.projectsDir, h.folders[0], h.ids.A1, 'subagents');
  const [hf] = await source.listHelpers(sub);
  const meta = await source.helperMeta(hf.file);
  assert.deepEqual(Object.keys(meta).sort(), ['finished', 'job', 'toolUseId', 'who']);
  assert.equal(meta.who, 'reviewer'); assert.equal(meta.job, 'review the login change');
  assert.ok(!JSON.stringify(meta).includes('CANARY'));
});
test('source: folderOf matches the folder naming', () => {
  assert.equal(source.folderOf(['C:', 'a b', 'c.d', ''].join('\\')), 'C--a-b-c-d');
  assert.equal(source.folderOf(['', 'srv', 'x', 'y'].join('/')), '-srv-x-y');
});

// ---------------------------------------------------------------- usage
test('usage: dedupe keeps the largest counters and the earliest time', () => {
  const m = dedupe([['m1', 20, 'opus', 1, 5, 0, 0, false, '', 0], ['m1', 10, 'opus', 3, 2, 7, 1, false, 'high', 2]], new Map(), true);
  assert.deepEqual(m.get('m1'), { t: 10, model: 'opus', i: 3, o: 5, cw: 7, cr: 1, cw1h: 2, side: false, own: true, effort: 'high' });
  const s = dedupe([['m2', 1, 'opus', 1, 1, 0, 0, true, '', 0]], new Map(), true);
  assert.equal(s.get('m2').own, false);
});
test('usage: usdOf prices the 5-minute and 1-hour parts, 0 for an unknown family', () => {
  const p = { cache_write_x: 1.25, cache_write_1h_x: 2, models: { opus: { in: 4, out: 20, cache_read: 0.2 } } };
  const r = { model: 'claude-opus-4', i: 1e6, o: 1e6, cw: 1e6, cr: 1e6, cw1h: 4e5 };
  assert.equal(Math.round(usdOf(r, p) * 1000) / 1000, Math.round((4 + 20 + 0.6 * 4 * 1.25 + 0.4 * 4 * 2 + 0.2) * 1000) / 1000);
  assert.equal(usdOf({ ...r, model: 'mystery' }, p), 0);
  assert.equal(mainFamily([{ model: 'claude-sonnet', o: 5 }, { model: 'claude-opus', o: 9 }]), 'opus');
});
test('usage: burstsOf splits at the gap', () => {
  assert.deepEqual(burstsOf([0, MIN, 2 * MIN, 20 * MIN, 21 * MIN]), [[0, 2 * MIN], [20 * MIN, 21 * MIN]]);
});
test('usage: the cache reads appended rows once', async () => {
  const f = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(f, jl([assistantLine(C0, NOW, { id: 'a' })]));
  const c = createUsageCache();
  assert.equal((await c.rows(f, fs.statSync(f))).length, 1);
  fs.appendFileSync(f, jl([assistantLine(C0, NOW, { id: 'b' })]));
  assert.equal((await c.rows(f, fs.statSync(f))).length, 2);
  assert.equal((await c.rows(f, fs.statSync(f))).length, 2);
});

// ---------------------------------------------------------------- sesstools
const bgLines = (c, id, t, byResult = false) => [
  assistantLine(c, t, { content: [toolUse('Bash', byResult ? { command: 'x' } : { command: 'x', run_in_background: true }, id)] }),
  toolResult(c, t + 1000, id, byResult ? 'Async agent launched successfully' : 'ok'),
];
test('sesstools: a background launch by flag and by result text', async () => {
  const d = tmpDir();
  const f1 = path.join(d, 'f1.jsonl'), f2 = path.join(d, 'f2.jsonl');
  fs.writeFileSync(f1, jl(bgLines(C0, 'toolu_bgflag01', NOW - MIN)));
  fs.writeFileSync(f2, jl(bgLines(C0, 'toolu_bgtext01', NOW - MIN, true)));
  assert.equal((await sessionTools(f1, null, NOW)).bg, 1);
  assert.equal((await sessionTools(f2, null, NOW)).bg, 1);
});
test('sesstools: closed by a queued notification and by a text user turn', async () => {
  const d = tmpDir();
  const f1 = path.join(d, 'q.jsonl'), f2 = path.join(d, 'u.jsonl');
  fs.writeFileSync(f1, jl([...bgLines(C0, 'toolu_close001', NOW - MIN), notification(C0, NOW, 'toolu_close001')]));
  const n = notification(C0, NOW, 'toolu_close002');
  fs.writeFileSync(f2, jl([...bgLines(C0, 'toolu_close002', NOW - MIN), userLine(C0, NOW, n.content)]));
  assert.equal((await sessionTools(f1, null, NOW)).bg, 0);
  assert.equal((await sessionTools(f2, null, NOW)).bg, 0);
});
test('sesstools: not closed by an assistant line or a tool result that quotes one', async () => {
  const d = tmpDir();
  const f = path.join(d, 'n.jsonl');
  const n = notification(C0, NOW, 'toolu_keep0001').content;
  fs.writeFileSync(f, jl([...bgLines(C0, 'toolu_keep0001', NOW - MIN), assistantLine(C0, NOW, { content: [{ type: 'text', text: n }] }), toolResult(C0, NOW, 'toolu_other01', n)]));
  assert.equal((await sessionTools(f, null, NOW)).bg, 1);
});
test('sesstools: closed from another session of the folder', async () => {
  const d = tmpDir();
  const f1 = path.join(d, 'one.jsonl'), f2 = path.join(d, 'two.jsonl');
  fs.writeFileSync(f1, jl(bgLines(C0, 'toolu_across01', NOW - MIN)));
  fs.writeFileSync(f2, jl([notification(C0, NOW, 'toolu_across01')]));
  touch(f1, NOW); touch(f2, NOW);
  const closed = await folderClosed(d, NOW);
  assert.ok(closed.has('toolu_across01'));
  assert.equal((await sessionTools(f1, null, NOW, { closed })).bg, 0);
});
test('sesstools: the 3-hour cap', async () => {
  const f = path.join(tmpDir(), 'old.jsonl');
  fs.writeFileSync(f, jl(bgLines(C0, 'toolu_oldjob01', NOW - BG_MAX_MS - MIN)));
  assert.equal((await sessionTools(f, null, NOW)).bg, 0);
});
test('sesstools: a helper own file with side: true', async () => {
  const f = path.join(tmpDir(), 'agent-x.jsonl');
  const c = { ...C0, side: true };
  fs.writeFileSync(f, jl([assistantLine(c, NOW, { content: [toolUse('Grep', { pattern: 'a' }, 'toolu_side0001')] })]));
  assert.equal((await sessionTools(f, null, NOW, { side: true })).tool.name, 'Grep');
  const g = path.join(tmpDir(), 'main.jsonl');
  fs.writeFileSync(g, jl([assistantLine(c, NOW, { content: [toolUse('Grep', { pattern: 'a' }, 'toolu_side0002')] })]));
  assert.equal((await sessionTools(g, null, NOW)).tool, null);
});

// ---------------------------------------------------------------- states
test('states: the sessionState table', () => {
  const f = (state, at, sticky = false) => ({ state, at, sticky });
  assert.equal(sessionState({ idleSec: 9 * 60 }), 'run');
  assert.equal(sessionState({ idleSec: 11 * 60 }), 'idle');
  assert.equal(sessionState({ idleSec: 11 * 60, lastAt: 5, seenAt: 6 }), 'done');
  assert.equal(sessionState({ idleSec: 60 * 60, bg: 1 }), 'run');
  assert.equal(sessionState({ file: f('running', 0), idleSec: 29 * 60 }), 'run');
  assert.equal(sessionState({ file: f('running', 0), idleSec: 31 * 60 }), 'idle');
  assert.equal(sessionState({ file: f('awaiting', 1000), idleSec: 60, ownAt: 1000 }), 'await');
  assert.equal(sessionState({ file: f('awaiting', 1000), idleSec: 60, ownAt: 1000 + 60000 }), 'run');
  assert.equal(sessionState({ file: f('awaiting', 1000, true), idleSec: 60, ownAt: 1000 + 60000 }), 'await');
  assert.equal(sessionState({ file: f('waiting', 0, true), idleSec: 9999 }), 'wait');
  assert.equal(sessionState({ file: f('idle', 0), idleSec: 9999, bg: 2 }), 'run');
});
test('states: sessionShown at the 2-hour and 12-hour edges', () => {
  assert.equal(sessionShown({ idleSec: 2 * 3600 - 1, now: NOW }), true);
  assert.equal(sessionShown({ idleSec: 2 * 3600, now: NOW }), false);
  assert.equal(sessionShown({ file: { at: NOW - 12 * HOUR + 1000 }, idleSec: 99999, now: NOW }), true);
  assert.equal(sessionShown({ file: { at: NOW - 12 * HOUR }, idleSec: 0, now: NOW }), false);
});
test('states: weekStart on a Sunday and a Monday', () => {
  assert.equal(weekStart(new Date(2026, 2, 15, 22, 0).getTime()), new Date(2026, 2, 9).getTime());
  assert.equal(weekStart(new Date(2026, 2, 16, 0, 30).getTime()), new Date(2026, 2, 16).getTime());
});
test('states: each error of markSeen and markPark', async () => {
  const d = tmpDir();
  const f = path.join(d, 'seen.jsonl'), p = path.join(d, 'park.jsonl');
  const id = nodeId('x-session-1');
  const err = async (fn, body) => (await fn(f, body)).body.error;
  assert.equal(await err(markSeen, null), 'expected {id}');
  assert.equal(await err(markSeen, { id, x: 1 }), 'unknown key x');
  assert.equal(await err(markSeen, { id: '123' }), 'which one? (s-<id>)');
  assert.equal(await err(markSeen, { id, name: 5 }), 'name must be text');
  assert.equal((await markSeen(f, { id, name: 'a\u0000b' }, NOW)).status, 200);
  assert.equal(await err(markPark, [1]), 'expected {id}');
  assert.equal(await err(markPark, { id, unpark: false }), 'unpark is true or absent');
  assert.equal(await err(markPark, { id, until: '3/1' }), 'the date is YYYY-MM-DD');
  assert.equal(await err(markPark, { id, name: [] }), 'name must be text');
  assert.equal((await markPark(p, { id, until: '2026-03-14' }, NOW)).status, 200);
});
test('states: parseSeen, the newest line wins', () => {
  const id = nodeId('s1-session');
  const m = parseSeen(`${JSON.stringify({ at: '2026-03-11T10:00:00Z', id, name: 'old' })}\nbad\n${JSON.stringify({ at: '2026-03-11T11:00:00Z', id, name: 'new' })}\n`);
  assert.equal(m.get(id).name, 'new');
});
test('states: applyPark takes off, brings back due ones as idle, and unparks', () => {
  const a = nodeId('a-session'), b = nodeId('b-session'), c = nodeId('c-session');
  const nodes = [{ id: a, st: 'run' }, { id: b, st: 'run' }, { id: c, st: 'idle' }];
  const park = parsePark([{ at: '2026-03-11T08:00:00Z', id: a, name: 'later', until: '2026-03-20' }, { at: '2026-03-11T08:00:00Z', id: b, until: '2026-03-10' },
    { at: '2026-03-11T08:00:00Z', id: c, until: '' }, { at: '2026-03-11T09:00:00Z', id: c, unpark: true }].map((x) => JSON.stringify(x)).join('\n'));
  const r = applyPark(nodes, park, NOW);
  assert.deepEqual(r.nodes.map((n) => [n.id, n.st, !!n.back]), [[b, 'idle', true], [c, 'idle', false]]);
  assert.deepEqual(r.parked.map((x) => [x.id, x.name]), [[a, 'later']]);
});
test('states: parseLive rejects a bad state and cleans the label', () => {
  assert.equal(parseLive(JSON.stringify({ session: 'abcdefgh-1', state: 'sleeping', at: new Date(NOW).toISOString() })), null);
  const v = parseLive(JSON.stringify({ session: 'abcdefgh-1', state: 'idle', at: new Date(NOW).toISOString(), task: `a\u0007b ${'x'.repeat(80)}` }));
  assert.equal(v.task.length, 48);
  assert.ok(!/[\u0000-\u001f]/.test(v.task));
});
test('states: pruneLive deletes files older than 14 days', async () => {
  const d = tmpDir();
  writeLive(d, 'abcdefgh-old', { state: 'idle' }, Date.now() - 20 * DAY);
  writeLive(d, 'abcdefgh-new', { state: 'idle' }, Date.now());
  assert.equal(await pruneLive(path.join(d, 'live')), 1);
  assert.deepEqual([...(await readLiveDir(path.join(d, 'live'))).keys()], ['abcdefgh-new']);
});

// ---------------------------------------------------------------- hooks
const runHook = async (dataDir, argv, stdin = '') => {
  const out = [], err = [];
  const code = await statusMain([...argv, '--data', dataDir], {}, { stdin, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};
const liveOf = (d, s) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'live', `${s}.json`), 'utf8')); } catch { return null; } };
test('hooks: each hook mode writes its state', async () => {
  const d = tmpDir(), s = 'abcdefgh-hook-1';
  const input = (extra = {}) => JSON.stringify({ session_id: s, ...extra });
  assert.equal((await runHook(d, ['--hook', 'running'], input())).code, 0);
  assert.equal(liveOf(d, s).state, 'running');
  await runHook(d, ['--hook', 'awaiting'], input({ notification_type: 'permission_prompt' }));
  assert.equal(liveOf(d, s).state, 'awaiting');
  await runHook(d, ['--hook', 'idle'], input());
  assert.equal(liveOf(d, s).state, 'idle');
});
test('hooks: idle keeps a sticky awaiting', async () => {
  const d = tmpDir(), s = 'abcdefgh-hook-2';
  await runHook(d, ['--state', 'awaiting', '--session', s]);
  assert.equal(liveOf(d, s).sticky, true);
  await runHook(d, ['--hook', 'idle'], JSON.stringify({ session_id: s }));
  assert.equal(liveOf(d, s).state, 'awaiting');
  await runHook(d, ['--hook', 'running'], JSON.stringify({ session_id: s }));
  assert.equal(liveOf(d, s).state, 'running');
  assert.equal(liveOf(d, s).sticky, undefined);
});
test('hooks: awaiting ignores idle_prompt and a missing type', async () => {
  const d = tmpDir(), s = 'abcdefgh-hook-3';
  await runHook(d, ['--hook', 'running'], JSON.stringify({ session_id: s }));
  await runHook(d, ['--hook', 'awaiting'], JSON.stringify({ session_id: s, notification_type: 'idle_prompt' }));
  await runHook(d, ['--hook', 'awaiting'], JSON.stringify({ session_id: s }));
  assert.equal(liveOf(d, s).state, 'running');
});
test('hooks: a prompt in stdin never reaches the file', async () => {
  const d = tmpDir(), s = 'abcdefgh-hook-4';
  await runHook(d, ['--hook', 'running'], JSON.stringify({ session_id: s, prompt: 'CANARY_HOOKPROMPT_abc123', cwd: '/x/CANARY_HOOKCWD' }));
  const text = fs.readFileSync(path.join(d, 'live', `${s}.json`), 'utf8');
  assert.ok(!text.includes('CANARY'));
});
test('hooks: bad stdin exits 0 and writes nothing', async () => {
  const d = tmpDir();
  assert.equal((await runHook(d, ['--hook', 'running'], 'not json')).code, 0);
  assert.equal((await runHook(d, ['--hook', 'running'], JSON.stringify({ session_id: '../../x' }))).code, 0);
  assert.equal(fs.existsSync(path.join(d, 'live')), false);
});
test('hooks: --state bogus exits 2', async () => {
  const r = await runHook(tmpDir(), ['--state', 'bogus', '--session', 'abcdefgh-hook-5']);
  assert.equal(r.code, 2);
  assert.match(r.err, /the state is awaiting, waiting, running or idle/);
});
test('hooks: --task keeps a cleaned label of 48 characters at most', async () => {
  const d = tmpDir(), s = 'abcdefgh-hook-6';
  assert.equal((await runHook(d, ['--task', `fix\u0007 the\tlogin ${'y'.repeat(60)}`, '--session', s])).out, 'status saved');
  const v = liveOf(d, s);
  assert.equal(v.task.length, 48);
  assert.ok(v.task.startsWith('fix the login'));
  assert.ok(!/[\u0000-\u001f]/.test(v.task));
  await runHook(d, ['--hook', 'idle'], JSON.stringify({ session_id: s }));
  assert.equal(liveOf(d, s).task, v.task);
  assert.equal((await runHook(d, ['--task', '\u0001 ', '--session', s])).code, 2);
});
test('hooks: --print-install holds this file path and three events', async () => {
  const r = await runHook(tmpDir(), ['--print-install']);
  const o = JSON.parse(r.out);
  assert.deepEqual(Object.keys(o.hooks).sort(), ['Notification', 'Stop', 'UserPromptSubmit']);
  const p = path.join(REPO, 'hooks', 'status.mjs').replace(/\\/g, '/');
  assert.ok(o.hooks.Stop[0].hooks[0].command.includes(p));
});

// ---------------------------------------------------------------- brain
async function brainOf(opts = {}, now = NOW) {
  const h = opts.h || makeHome(tmpDir(), NOW, opts);
  const P = source.locate({ claudeDir: h.claudeDir });
  const team = await readTeam(P.agentsDir);
  const cache = opts.cache || createUsageCache();
  const c = await collect({ P, cache, prices: PRICES, team, now });
  const B = await buildBrain(c.sess, { dataDir: h.dataDir, total: c.total, team, now });
  const node = (k) => B.nodes.find((n) => n.id === nodeId(h.ids[k])) || null;
  return { h, P, c, B, node, cache, team };
}
test('brain: each row of the fixture table', async () => {
  const { B, node } = await brainOf();
  const a1 = node('A1');
  assert.equal(a1.st, 'run'); assert.equal(a1.entry, 'cli');
  assert.deepEqual(a1.tool, { k: 'tool', name: 'Bash' }); assert.equal(a1.skill, 'demo-skill');
  assert.equal(a1.plus, 1); assert.equal(a1.bg, undefined);
  assert.deepEqual(a1.helpers.map((x) => [x.role, x.st, x.effort]), [['reviewer', 'run', 'med']]);
  assert.equal(a1.model, 'opus'); assert.equal(a1.effort, 'med');
  const a2 = node('A2');
  assert.equal(a2.st, 'idle'); assert.equal(a2.entry, 'headless'); assert.equal(a2.noHooks, true);
  const a3 = node('A3');
  assert.equal(a3.st, 'run'); assert.equal(a3.waitJob, true); assert.equal(a3.bg, 1);
  assert.equal(node('A4').st, 'idle');
  assert.equal(node('A5'), null); assert.equal(node('A6'), null);
  assert.equal(node('B1').st, 'await');
  assert.equal(node('B2').st, 'run');
  assert.equal(node('B3').st, 'idle');
  assert.equal(node('B4').st, 'wait');
  assert.equal(node('B5'), null);
  assert.equal(B.nodes.length, 8);
  assert.deepEqual(B.projects.map((p) => [p.label, p.st, p.n]).sort(), [['alpha', 'run', 4], ['beta', 'await', 4]]);
  // the counts hold the job cards too: A1's reviewer and B2's maker run; B2's three finished jobs are done, to check
  assert.deepEqual(B.counts, { run: 5, await: 1, wait: 1, idle: 3, done: 0, check: 3, look: 0 });
  assert.equal(B.you.st, 'await'); assert.equal(B.you.sessions, 8); assert.equal(B.you.running, 3);
  assert.equal(B.empty, false); assert.equal(B.hooks, true);
  assert.equal(new Set(B.nodes.map((n) => n.id)).size, B.nodes.length);
});
test('brain: the session label shows, cleaned and cut', async () => {
  const h = makeHome(tmpDir(), NOW);
  writeLive(h.dataDir, h.ids.B3, { task: `ship the \u0007 release ${'z'.repeat(60)}` }, NOW);
  const { node } = await brainOf({ h });
  assert.equal(node('B4').task, 'tidy the test data');
  const t = node('B3').task;
  assert.equal(t.length, 48); assert.ok(t.startsWith('ship the release'));
  assert.equal(node('A1').task, undefined);
});
test('brain: twin labels', async () => {
  const { B } = await brainOf({ twin: true });
  assert.deepEqual(B.projects.map((p) => p.label).sort(), ['alpha', 'alpha (2)', 'beta']);
});
test('brain: a seen line moves A2 to done and a later write brings it back', async () => {
  const h = makeHome(tmpDir(), NOW);
  const id = nodeId(h.ids.A2);
  await markSeen(path.join(h.dataDir, 'seen.jsonl'), { id, name: 'alpha · 2:20 PM' }, NOW);
  const cache = createUsageCache();
  const r1 = await brainOf({ h, cache });
  assert.equal(r1.node('A2'), null);
  assert.deepEqual(r1.B.done.map((x) => [x.id, x.name]), [[id, 'alpha · 2:20 PM']]);
  assert.equal(r1.B.counts.done, 1);
  const f = path.join(r1.P.projectsDir, h.folders[0], `${h.ids.A2}.jsonl`);
  fs.appendFileSync(f, jl([assistantLine({ session: h.ids.A2, cwd: 'x', entry: 'sdk-cli' }, NOW + MIN, { model: 'claude-sonnet-4-5' })]));
  touch(f, NOW + MIN);
  const r2 = await brainOf({ h, cache }, NOW + 2 * MIN);
  assert.ok(r2.node('A2'));
});
test('brain: at most 8 nodes per project, the rest counted', async () => {
  const { B } = await brainOf({ many: 10 });
  const g = B.projects.find((p) => p.label === 'gamma');
  assert.equal(g.n, 8); assert.equal(g.more, 2);
  assert.equal(B.nodes.filter((n) => n.parent === g.key).length, 8);
});
test('brain: an empty home', async () => {
  const h = makeHome(tmpDir(), NOW, { empty: true });
  const { B } = await brainOf({ h });
  assert.equal(B.empty, true); assert.equal(B.hooks, false); assert.deepEqual(B.nodes, []);
  assert.deepEqual(B.today.rows, []);
});

// ---------------------------------------------------------------- timeline
test('timeline: spans are clipped to today', async () => {
  const h = makeHome(tmpDir(), NOW);
  const sod = startOfDay(NOW);
  const c = { session: sid(90), cwd: path.join(h.workDir, 'alpha'), entry: 'cli' };
  const f = path.join(h.claudeDir, 'projects', h.folders[0], `${c.session}.jsonl`);
  fs.writeFileSync(f, jl([assistantLine(c, sod - 2 * MIN), assistantLine(c, sod + MIN)]));
  touch(f, NOW - 30 * MIN);
  const { B } = await brainOf({ h });
  assert.equal(B.today.day, dayKey(NOW)); assert.equal(B.today.from, sod); assert.equal(B.today.to, NOW);
  const lanes = B.today.rows.flatMap((r) => r.lanes);
  const lane = lanes.find((x) => x.id === nodeId(c.session));
  assert.ok(B.nodes.some((n) => n.id === lane.id), 'a lane is a node on the tree');
  assert.deepEqual(lane.spans, [[sod, sod + MIN]]);
  for (const x of lanes) for (const [a, b] of [...x.spans, ...x.helpers.flatMap((y) => y.spans)]) assert.ok(a >= sod && b <= NOW && a <= b);
  const a1 = lanes.find((x) => x.id === nodeId(h.ids.A1));
  assert.deepEqual(a1.helpers.map((y) => [y.role, y.st, y.model]), [['reviewer', 'run', 'sonnet']]);
  const order = B.projects.map((p) => p.key).filter((k) => B.today.rows.some((r) => r.key === k));
  assert.deepEqual(B.today.rows.map((r) => r.key), order, 'rows keep the tree order');
});
test('timeline: a session with no span today is absent', () => {
  const sod = startOfDay(NOW);
  const nodes = [{ id: 's-old', parent: 'p-1' }, { id: 's-new', parent: 'p-2' }];
  const projects = [{ key: 'p-1' }, { key: 'p-2' }];
  const lanes = new Map([['s-old', { spans: [[sod - 2 * HOUR, sod - HOUR]], helpers: [] }],
    ['s-new', { spans: [[sod + HOUR, sod + 2 * HOUR]], helpers: [{ role: 'r', st: 'done', model: 'opus', spans: [[sod - HOUR, sod - MIN]] }] }]]);
  const T = todayTimeline({ nodes, projects, lanes, now: NOW });
  assert.deepEqual(T.rows, [{ key: 'p-2', lanes: [{ id: 's-new', spans: [[sod + HOUR, sod + 2 * HOUR]], helpers: [] }] }]);
  assert.deepEqual(clipSpans([[NOW - MIN, NOW + HOUR]], sod, NOW), [[NOW - MIN, NOW]]);
});

// ---------------------------------------------------------------- details
test('details: days, totals, one response once, the lead and helper split', async () => {
  const h = makeHome(tmpDir(), NOW);
  const P = source.locate({ claudeDir: h.claudeDir });
  const d = await loadDetails({ P, cache: createUsageCache(), prices: PRICES, now: NOW });
  assert.equal(d.days.length, 14);
  assert.equal(d.days.at(-1).day, dayKey(NOW));
  assert.equal(d.today, dayKey(NOW));
  assert.equal(d.responses, h.responses);
  const todayTok = Object.values(d.days.at(-1).models).reduce((a, v) => a + v.tok, 0);
  assert.ok(todayTok > 0);
  assert.equal(spendOf(d).tokens, todayTok);
  assert.ok(!d.sessions.some((s) => s.id === nodeId(h.ids.B5)));
  const alpha = d.projects.find((p) => p.label === 'alpha');
  assert.equal(alpha.helper.n, 2);
  assert.ok(alpha.lead.n > 0);
});
test('details: spendOf usual is the median, null under 3 days', () => {
  const day = (k, tok) => ({ day: k, models: tok ? { opus: { n: 1, tok, usd: tok / 1000 } } : {} });
  const d = { today: '2026-03-11', days: [day('2026-03-07', 100), day('2026-03-08', 0), day('2026-03-09', 300), day('2026-03-10', 200), day('2026-03-11', 50)] };
  assert.deepEqual(spendOf(d).usual, { tokens: 200, usd: 0.2 });
  assert.equal(spendOf({ ...d, days: d.days.slice(2) }).usual, null);
});

// ---------------------------------------------------------------- tools
test('tools: the inventory, usage counts and merges', async () => {
  const h = makeHome(tmpDir(), NOW);
  const P = source.locate({ claudeDir: h.claudeDir });
  const catalogFile = path.join(tmpDir(), 'tools-catalog.json');
  fs.writeFileSync(catalogFile, JSON.stringify({ items: [{ name: 'resize', line: 'Resizes', match: 'resize.mjs' }, { name: 'deploy', line: 'Ships' }] }));
  const usage = await countUsage(P.projectsDir, ['resize.mjs'], NOW);
  const T = await listTools({ P, catalogFile, usageOf: () => usage, now: NOW });
  assert.equal(T.usage, 'ready');
  const where = Object.fromEntries(T.skills.map((s) => [s.name, s.where]));
  assert.equal(where['demo-skill'], 'user'); assert.equal(where['proj-skill'], 'project alpha'); assert.equal(where['plug-skill'], 'plugin plug-a');
  assert.equal(where['not-enabled'], undefined); assert.equal(where.gone, undefined);
  assert.deepEqual(T.mcp.map((m) => m.name).sort(), ['dot-mcp', 'fixture-mcp', 'proj-mcp']);
  assert.deepEqual(T.hooks.map((x) => [x.event, x.script]), [['Stop', 'stop.mjs']]);
  assert.deepEqual(T.commands.map((c) => c.name), ['/ship']);
  assert.deepEqual(T.plugins, ['plug-a@mk']);
  assert.equal(T.statusLine, 'statusline.mjs');
  const demo = T.skills.find((s) => s.name === 'demo-skill').use;
  assert.equal(demo.d30, 3); assert.equal(demo.d7, 2);
  assert.equal(T.skills.find((s) => s.name === 'unused-skill').use.d30, 0);
  assert.equal(T.helpers.find((x) => x.name === 'reviewer').use.d30, 1);
  assert.equal(T.mcp.find((m) => m.name === 'fixture-mcp').use.d30, 2);
  assert.equal(T.own.find((i) => i.name === 'deploy').use, null);
  assert.ok(T.merges.some((m) => m.names.includes('demo-skill') && m.names.includes('unused-skill')));
  assert.ok(!JSON.stringify(T).includes('CANARY'));
});
test('tools: the catalog parse drops bad items and short matches', () => {
  const c = parseCatalog(JSON.stringify({ items: [{ name: 'ok', line: 'fine', match: 'abc' }, { line: 'no name' }, 5, { name: 'm', match: 'Long.MJS' }] }));
  assert.deepEqual(c, [{ name: 'ok', line: 'fine' }, { name: 'm', line: '', match: 'long.mjs' }]);
  assert.equal(parseCatalog('nope'), null);
  assert.equal(mergeHints([{ name: 'a', where: 'user', description: 'one two three four' }, { name: 'b', where: 'user', description: 'other words entirely here' }]).length, 0);
});

// ---------------------------------------------------------------- team
test('team: readTeam and modelsFor', async () => {
  const h = makeHome(tmpDir(), NOW);
  const t = await readTeam(path.join(h.claudeDir, 'agents'));
  assert.deepEqual(t.map((x) => x.name), ['bad', 'planner', 'reviewer']);
  assert.deepEqual(t.find((x) => x.name === 'bad'), { name: 'bad', description: '', model: '', modelRaw: '', effort: '' });
  assert.equal(t.find((x) => x.name === 'planner').model, 'opus');
  assert.ok(modelsFor(t).includes('claude-opus-9-9'));
});
test('team: setFrontmatter changes two lines only and keeps CRLF', () => {
  const text = '---\r\nname: r\r\nmodel: sonnet\r\neffort: low\r\n---\r\nBody\r\n';
  assert.equal(setFrontmatter(text, { model: 'opus', effort: 'high' }), '---\r\nname: r\r\nmodel: opus\r\neffort: high\r\n---\r\nBody\r\n');
  assert.equal(setFrontmatter('---\nname: p\nmodel: x\n---\nB\n', { effort: 'max' }), '---\nname: p\nmodel: x\neffort: max\n---\nB\n');
  assert.equal(setFrontmatter('no frontmatter', { model: 'opus' }), null);
});
test('team: each guard, the write and the log line', async () => {
  const h = makeHome(tmpDir(), NOW);
  const agentsDir = path.join(h.claudeDir, 'agents'), logFile = path.join(h.dataDir, 'team-changes.jsonl');
  const set = (body, o = {}) => setTeam(body, { agentsDir, logFile, now: NOW, ...o });
  const st = async (body) => { const r = await set(body); return [r.status, r.body.error]; };
  assert.deepEqual(await st('x'), [400, 'expected {helper, model, effort}']);
  assert.deepEqual(await st({ helper: 'reviewer', x: 1 }), [400, 'unknown key x']);
  assert.deepEqual(await st({ helper: '../x', model: 'opus' }), [400, 'which helper? (its file name, no path)']);
  assert.deepEqual(await st({ helper: 'reviewer' }), [400, 'nothing to change']);
  assert.match((await st({ helper: 'reviewer', model: 'gpt' }))[1], /^the model is one of: fable, opus/);
  assert.match((await st({ helper: 'reviewer', effort: 'huge' }))[1], /^the effort is one of: low/);
  assert.deepEqual(await st({ helper: 'ghost', model: 'opus' }), [404, 'no helper named ghost']);
  assert.deepEqual(await st({ helper: 'bad', model: 'opus' }), [409, 'bad.md has no frontmatter']);
  const file = path.join(agentsDir, 'reviewer.md');
  const before = fs.readFileSync(file, 'utf8');
  const dry = await set({ helper: 'reviewer', model: 'opus' }, { dryRun: true });
  assert.equal(dry.body.dryRun, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(logFile), false);
  const r = await set({ helper: 'reviewer', model: 'opus' });
  assert.equal(r.status, 200);
  const after = fs.readFileSync(file, 'utf8');
  const diff = before.split('\r\n').map((l, i) => (l === after.split('\r\n')[i] ? null : [l, after.split('\r\n')[i]])).filter(Boolean);
  assert.deepEqual(diff, [['model: sonnet', 'model: opus']]);
  const line = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
  assert.deepEqual([line.helper, line.from.model, line.to.model], ['reviewer', 'sonnet', 'opus']);
});

// ---------------------------------------------------------------- jobs
const GROUPS = { 'Blender recreation, 6 variations': 'Mint video' };
test('jobs: helpers that share a job name are one card, under the session that drives them', async () => {
  const { B, node } = await brainOf();
  const b2 = node('B2'), a1 = node('A1');
  const mine = (n) => B.jobs.filter((x) => x.parent === n.id);
  assert.deepEqual(mine(a1).map((x) => [x.job, x.role, x.st, x.n]), [['review the login change', 'reviewer', 'run', 1]]);
  const js = mine(b2);
  // the running job first, then the finished ones, the newest first
  assert.deepEqual(js.map((x) => [x.role, x.st, x.n, x.nDone]), [['maker', 'run', 1, 0], ['', 'done', 2, 2], ['builder', 'done', 1, 1], ['planner', 'done', 1, 1]]);
  const [maker, gallery, builder, planner] = js;
  assert.equal(maker.job, 'Blender recreation, 6 variations');
  assert.equal(builder.job, 'builder', 'no description: the role word');
  assert.equal(planner.job.length, 48); assert.ok(planner.job.startsWith('Plan the Threads job cards'));
  assert.equal(maker.model, 'opus'); assert.equal(maker.effort, 'high'); assert.ok(maker.tokens > 0); assert.ok(maker.min >= 1);
  // "<Job>: <step>", matched without case: one job, the name as its first helper wrote it, each helper a row
  assert.equal(gallery.job, 'Gallery');
  assert.deepEqual(gallery.helpers.map((x) => [x.role, x.step, x.st]), [['auditor', 'check links', 'done'], ['builder', 'build pages', 'done']]);
  assert.equal(gallery.tokens, gallery.helpers.reduce((s, x) => s + x.tokens, 0));
  assert.deepEqual(b2.jobs, { run: 1, done: 3, n: 4 });
  assert.equal(B.you.jobs, 5);
  for (const x of B.jobs) { assert.match(x.id, /^j-[a-f0-9]{16}$/); assert.equal(x.kind, 'job'); assert.equal(x.pkey, undefined); }
  assert.equal(new Set(B.jobs.map((x) => x.id)).size, B.jobs.length);
  const lane = B.today.rows.flatMap((r) => r.lanes).find((l) => l.id === b2.id);
  assert.deepEqual(lane.helpers.map((x) => x.id).sort(), js.map((x) => x.id).sort());
});
test('jobs: a finished job is done (green) at once and stays on the tree until Got it', async () => {
  const { B, node } = await brainOf();
  const done = B.jobs.filter((x) => x.parent === node('B2').id && x.st === 'done');
  assert.equal(done.length, 3, 'no Got it yet: all three finished jobs are on the tree, done');
  assert.equal(B.counts.check, 3); assert.equal(B.counts.done, 0, 'done this week counts after Got it');
  assert.ok(!B.jobs.some((x) => x.st === 'idle'), 'a finished job is never idle');
  assert.equal(B.projects.find((p) => p.base === 'beta').st, 'await', 'a done job does not change its project');
});
test('jobs: jobGroups in the config puts a helper under a job by its exact description', async () => {
  const cfg = path.join(tmpDir(), 'config.json');
  const plan = `Plan the Threads job cards ${'z'.repeat(60)}`.slice(0, 48); // a long description matches by its first 48 characters
  fs.writeFileSync(cfg, JSON.stringify({ jobGroups: { 'Blender recreation, 6 variations': ' Mint\u0007 video ', [`${plan}zzz`]: 'Mint video', builder: 'Mint video', 'not there': 'Nowhere', bad: 7, [`${'k'.repeat(60)}`]: 'x'.repeat(60) } }));
  const C = readConfig(cfg);
  assert.deepEqual(C.jobGroups, { 'Blender recreation, 6 variations': 'Mint video', [plan]: 'Mint video', builder: 'Mint video', 'not there': 'Nowhere', ['k'.repeat(48)]: 'x'.repeat(48) });
  const h = makeHome(tmpDir(), NOW);
  const P = source.locate({ claudeDir: h.claudeDir });
  const c = await collect({ P, cache: createUsageCache(), prices: PRICES, team: [], now: NOW });
  const B = await buildBrain(c.sess, { dataDir: h.dataDir, total: c.total, groups: C.jobGroups, now: NOW });
  const mint = B.jobs.find((x) => x.job === 'Mint video');
  assert.deepEqual(mint.helpers.map((x) => [x.role, x.step, x.st]), [['maker', 'Blender recreation, 6 variations', 'run'], ['planner', plan, 'done']]);
  assert.equal(mint.st, 'run', 'the worst of its helpers'); assert.equal(mint.n, 2); assert.equal(mint.nDone, 1);
  assert.ok(!B.jobs.some((x) => x.job === 'Nowhere'));
  assert.ok(B.jobs.some((x) => x.job === 'builder'), 'a helper with no description is not grouped by the config');
});
test('jobs: a job that waits on its own background render is running and shows it', async () => {
  const { node, B } = await brainOf();
  const maker = B.jobs.find((x) => x.parent === node('B2').id && x.role === 'maker');
  assert.equal(maker.st, 'run'); assert.equal(maker.bg, 1);
  assert.deepEqual(maker.bgw.map((x) => [x.tool, x.prog, x.script]), [['Bash', 'Blender', 'render_steps.py']]);
  assert.ok(maker.bgw[0].since < NOW);
  assert.equal(node('A3').bgw[0].tool, 'Bash', 'the lead shows its own background command');
});
test('jobs: a finished helper whose background render is still out is running; a stale one ages out', async () => {
  const { node, B } = await brainOf({ h: makeHome(tmpDir(), NOW, { bgdone: true }) });
  const fr = B.jobs.find((x) => x.parent === node('B2').id && x.job === 'Frames');
  assert.equal(fr.st, 'run'); assert.equal(fr.bg, 1); assert.equal(fr.nDone, 0);
  assert.deepEqual(fr.helpers.map((x) => x.st), ['run']);
  assert.deepEqual(fr.bgw.map((x) => Object.keys(x).sort()), [['prog', 'script', 'since', 'tool']]);
  assert.deepEqual(fr.bgw.map((x) => [x.tool, x.prog, x.script]), [['Bash', 'blender', 'render_frames.py']]);
  assert.ok(fr.bgw[0].since < NOW && NOW - fr.bgw[0].since < 20 * 60000);
  const old = B.jobs.find((x) => x.parent === node('B2').id && x.job === 'Old frames');
  assert.equal(old.st, 'done', 'a background command past BG_MAX_MS no longer keeps it running'); assert.equal(old.bgw, undefined);
  const s = JSON.stringify(B);
  for (const w of ['frprompt', 'frpath', 'frarg', 'frdesc', 'frresult', 'frreply']) assert.ok(!s.includes(`CANARY_${w.toUpperCase()}_`), w);
});
test('jobs: Got it removes a done job and counts it in done this week; Park takes one off the tree', async () => {
  const h = makeHome(tmpDir(), NOW);
  const r0 = await brainOf({ h });
  const gallery = r0.B.jobs.find((x) => x.job === 'Gallery'), maker = r0.B.jobs.find((x) => x.role === 'maker');
  assert.equal(gallery.st, 'done');
  assert.equal((await markSeen(path.join(h.dataDir, 'seen.jsonl'), { id: gallery.id, name: gallery.job }, NOW)).status, 200);
  assert.equal((await markPark(path.join(h.dataDir, 'parked.jsonl'), { id: maker.id, name: maker.job, until: '' }, NOW)).status, 200);
  const { B, node } = await brainOf({ h });
  assert.ok(!B.jobs.some((x) => x.id === gallery.id || x.id === maker.id), 'the whole job card is gone');
  assert.deepEqual(B.done.map((x) => [x.id, x.name, x.outcome]), [[gallery.id, 'Gallery', '6 pages built, links checked']]);
  assert.equal(B.counts.done, 1); assert.equal(B.counts.check, 2);
  assert.ok(B.parked.some((x) => x.id === maker.id && x.name === maker.job));
  assert.deepEqual(node('B2').jobs, { run: 1, done: 3, n: 4 }, 'a parked job still runs: the lead counts it');
  // Got it on a running job does not remove it; a helper that writes after Got it brings the job back
  await markSeen(path.join(h.dataDir, 'seen.jsonl'), { id: r0.B.jobs.find((x) => x.role === 'reviewer').id, name: 'x' }, NOW);
  assert.ok((await brainOf({ h })).B.jobs.some((x) => x.role === 'reviewer' && x.st === 'run'));
  const later = await brainOf({ h }, NOW + 30 * MIN);
  assert.ok(!later.B.jobs.some((x) => x.id === gallery.id));
});
test('jobs: what it did is names and counts only, added up over its helpers', async () => {
  const { B } = await brainOf();
  const g = B.jobs.find((x) => x.job === 'Gallery');
  assert.deepEqual(g.did.calls.map((c) => [c.k, c.name, c.n]), [['tool', 'Bash', 2], ['tool', 'Write', 2], ['skill', 'demo-skill', 1], ['tool', 'Edit', 1], ['mcp', 'fixture mcp', 1], ['tool', 'Read', 1]]);
  assert.equal(g.did.total, 8);
  assert.deepEqual(g.did.scripts, ['build_pages.py'], 'the script a command ran; a file that was only read is not one');
  assert.equal(g.did.files, 2, 'two different files written (one of them twice)');
  assert.equal(g.did.errors, 1);
  assert.deepEqual(g.helpers.map((x) => [x.role, x.calls, x.files, x.errors]), [['auditor', 1, 0, 0], ['builder', 7, 2, 1]]);
  assert.deepEqual(Object.keys(g.did).sort(), ['calls', 'errors', 'files', 'scriptMore', 'scripts', 'total']);
  assert.deepEqual(Object.keys(g.helpers[0]).sort(), ['calls', 'effort', 'errors', 'files', 'min', 'model', 'role', 'st', 'step', 'tokens', 'usd']);
  assert.ok(!JSON.stringify(B.jobs).includes('CANARY'));
  const many = sumDid([{ calls: Array.from({ length: 30 }, (_, k) => ({ k: 'tool', name: `t${k}`, n: k + 1 })), scripts: Array.from({ length: 20 }, (_, k) => `s${k}.py`), files: 3, errors: 0 }, null]);
  assert.equal(many.calls.length, 12); assert.equal(many.calls[0].n, 30); assert.equal(many.scripts.length, 8); assert.equal(many.scriptMore, 12);
});
test('jobs: the outcome line is the lead\'s own, cleaned, 80 characters at most', async () => {
  const { B } = await brainOf();
  assert.equal(B.jobs.find((x) => x.job === 'Gallery').outcome, '6 pages built, links checked');
  assert.ok(B.jobs.filter((x) => x.job !== 'Gallery').every((x) => x.outcome === undefined));
  const s = 'abcdefgh-0000-4000-8000-000000000001';
  const m = parseOutcomes([
    { at: '2026-03-11T10:00:00Z', session: s, job: 'Site', outcome: 'old' },
    { at: '2026-03-11T11:00:00Z', session: s, job: ' site ', outcome: `new\u0007 line ${'y'.repeat(100)}`, extra: 'x' },
    { at: '2026-03-11T11:00:00Z', session: '../x', job: 'site', outcome: 'bad session' },
    { at: 'never', session: s, job: 'site', outcome: 'bad time' },
    { at: '2026-03-11T11:00:00Z', session: s, job: 'gone', outcome: 'x' }, { at: '2026-03-11T12:00:00Z', session: s, job: 'gone', outcome: '' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  assert.deepEqual([...m.keys()], [`${s}\nsite`, `${s}\ngone`]);
  const v = m.get(`${s}\nsite`).text;
  assert.equal(v.length, 80); assert.ok(v.startsWith('new line yyy')); assert.ok(!/[\u0000-\u001f]/.test(v));
  assert.equal(m.get(`${s}\ngone`).text, '');
});
test('hooks: --job with --outcome appends the lead\'s line; one without the other is refused', async () => {
  const d = tmpDir(), s = 'abcdefgh-hook-7';
  assert.equal((await runHook(d, ['--job', 'Gallery', '--outcome', `6 pages\u0007 built ${'y'.repeat(100)}`, '--session', s])).out, 'outcome saved');
  const m = parseOutcomes(fs.readFileSync(path.join(d, 'outcomes.jsonl'), 'utf8'));
  const v = m.get(`${s}\ngallery`).text;
  assert.equal(v.length, 80); assert.ok(v.startsWith('6 pages built'));
  assert.equal(liveOf(d, s), null, 'an outcome line does not touch the session state');
  assert.equal((await runHook(d, ['--job', 'Gallery', '--session', s])).code, 2);
  assert.equal((await runHook(d, ['--outcome', 'x', '--session', s])).code, 2);
  assert.equal((await runHook(d, ['--job', '\u0001', '--outcome', 'x', '--session', s])).code, 2);
  assert.equal((await runHook(d, ['--job', 'Gallery', '--outcome', '', '--session', s])).code, 0, 'an empty line takes it away');
  assert.equal(parseOutcomes(fs.readFileSync(path.join(d, 'outcomes.jsonl'), 'utf8')).get(`${s}\ngallery`).text, '');
});
test('jobs: helperState, jobState, jobSeen and jobOf', () => {
  assert.equal(helperState({ idleSec: 60 }), 'run');
  assert.equal(helperState({ idleSec: 3600, bg: 1 }), 'run');
  assert.equal(helperState({ finished: true, idleSec: 1 }), 'done', 'finished is done at once');
  assert.equal(helperState({ finished: true, idleSec: 3600, bg: 1 }), 'run', 'finished but its background command is still out');
  assert.equal(helperState({ idleSec: 3600 }), 'idle', 'stopped without the finished mark');
  assert.equal(jobState(['done', 'done']), 'done');
  assert.equal(jobState(['done', 'idle']), 'idle');
  assert.equal(jobState(['done', 'idle', 'run']), 'run');
  assert.equal(jobState(['run', 'await', 'wait']), 'await');
  assert.equal(jobState(['done', 'wait', 'idle']), 'wait');
  assert.equal(jobSeen({ st: 'done', seenAt: 10, lastAt: 5 }), true);
  assert.equal(jobSeen({ st: 'done', seenAt: 4, lastAt: 5 }), false);
  assert.equal(jobSeen({ st: 'done' }), false);
  assert.equal(jobSeen({ st: 'run', seenAt: 10, lastAt: 5 }), false);
  assert.deepEqual(jobOf('Gallery: build pages', 'builder'), { job: 'Gallery', step: 'build pages' });
  assert.deepEqual(jobOf('no colon here', 'builder'), { job: 'no colon here', step: 'no colon here' });
  assert.deepEqual(jobOf('', 'builder'), { job: 'builder', step: 'builder' });
  assert.deepEqual(jobOf(': odd', 'x'), { job: ': odd', step: ': odd' });
  assert.deepEqual(jobOf('trailing:', 'x'), { job: 'trailing:', step: 'trailing:' });
  assert.deepEqual(jobOf('a: b: c', 'x'), { job: 'a', step: 'b: c' });
  assert.deepEqual(jobOf('Plan it', 'planner', { 'Plan it': 'Site' }), { job: 'Site', step: 'Plan it' });
  assert.deepEqual(jobOf('Site: plan', 'planner', { 'Site: plan': 'site' }), { job: 'site', step: 'plan' });
  assert.equal(jobOf(`${'j'.repeat(60)}: step`, 'x').job.length, 48);
  assert.match(jobId('a', 'b'), /^j-[a-f0-9]{16}$/); assert.notEqual(jobId('a', 'b'), jobId('a', 'c')); assert.equal(jobId('a', 'Site'), jobId('a', 'site'));
});
test('source: programOf keeps file names only', () => {
  assert.deepEqual(source.programOf('cd "/x/y z" && nohup /opt/Blender.app/Contents/MacOS/Blender -b s.blend --python /a/b/render_steps.py -- --seed 9 &'), { prog: 'Blender', script: 'render_steps.py' });
  assert.deepEqual(source.programOf('TOKEN=abc timeout 60 python3 /p/run.py --key xyz'), { prog: 'python3', script: 'run.py' });
  assert.deepEqual(source.programOf('echo secret > /tmp/out'), { prog: '', script: '' });
  assert.deepEqual(source.programOf('"/x/my tool" arg'), { prog: '', script: '' });
});
test('names: a project shows under the name set in config.json', async () => {
  const h = makeHome(tmpDir(), NOW);
  const cfg = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ keep: 1, projectNames: { beta: 'Bob', alpha: 7 } }));
  const C = readConfig(cfg);
  assert.deepEqual(C.projectNames, { beta: 'Bob' });
  const P = source.locate({ claudeDir: h.claudeDir });
  const c = await collect({ P, cache: createUsageCache(), prices: PRICES, team: [], now: NOW });
  const B = await buildBrain(c.sess, { dataDir: h.dataDir, total: c.total, names: C.projectNames, now: NOW });
  const beta = B.projects.find((p) => p.base === 'beta');
  assert.equal(beta.label, 'Bob'); assert.equal(B.projects.find((p) => p.base === 'alpha').label, 'alpha');
  assert.ok(B.nodes.filter((n) => n.parent === beta.key).every((n) => n.project === 'Bob'));
  assert.ok(B.jobs.filter((j) => j.role === 'maker').every((j) => j.project === 'Bob'));
  assert.equal((await setProjectName(cfg, { label: 'nowhere', name: 'x' }, new Set(['beta']))).status, 400);
  assert.equal((await setProjectName(cfg, { label: 'beta', name: 'x', more: 1 }, new Set(['beta']))).status, 400);
  assert.equal((await setProjectName(cfg, { label: 'beta', name: 'Bob \u0007 two' }, new Set(['beta']))).status, 200);
  const o = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(o.keep, 1); assert.equal(o.projectNames.beta, 'Bob two');
  await setProjectName(cfg, { label: 'beta', name: '' }, new Set(['beta']));
  assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).projectNames.beta, undefined);
});
test('source: more Claude folders are read, each session once', async () => {
  const a = makeHome(tmpDir(), NOW), b = makeHome(tmpDir(), NOW);
  const P = source.locate({ claudeDir: a.claudeDir, extraDirs: [b.claudeDir, a.claudeDir] });
  assert.equal(P.projectsDirs.length, 2);
  const { sessions, total } = await source.listSessions(P, NOW - 4 * HOUR);
  assert.equal(total, 11, 'the same session ids in both homes count once');
  assert.ok(sessions.every((s) => s.dir.startsWith(a.claudeDir)));
  fs.renameSync(path.join(b.claudeDir, 'projects', b.folders[1]), path.join(b.claudeDir, 'projects', 'moved'));
  for (const f of fs.readdirSync(path.join(b.claudeDir, 'projects', 'moved')).filter((x) => x.endsWith('.jsonl'))) fs.renameSync(path.join(b.claudeDir, 'projects', 'moved', f), path.join(b.claudeDir, 'projects', 'moved', f.replace('aaaaaaaa', 'bbbbbbbb')));
  assert.ok((await source.listSessions(P, NOW - 4 * HOUR)).total > 11, 'a session only in the second home is read');
  assert.equal(source.entryWord('claude-desktop'), 'desktop'); assert.equal(source.entryWord('claude-vscode'), 'ide');
});

// ---------------------------------------------------------------- needs you and outputs
test('needs: parseNeeds keeps the newest reason per job, cleaned, 80 characters at most; "" clears it', () => {
  const s = 'abcdefgh-0000-4000-8000-000000000001';
  const m = parseNeeds(jl([
    { at: '2026-03-11T10:00:00Z', session: s, job: 'Site', needs: 'old' },
    { at: '2026-03-11T11:00:00Z', session: s, job: ' site ', needs: `pick\u0007 one ${'y'.repeat(100)}`, prompt: 'x' },
    { at: '2026-03-11T11:00:00Z', session: '../x', job: 'site', needs: 'bad session' },
    { at: 'never', session: s, job: 'site', needs: 'bad time' },
    { at: '2026-03-11T11:00:00Z', session: s, job: 'gone', needs: 'x' }, { at: '2026-03-11T12:00:00Z', session: s, job: 'Gone', needs: '' },
    { at: '2026-03-11T11:00:00Z', session: s, job: 'num', needs: 7 },
  ]) + 'not json\n');
  assert.deepEqual([...m.keys()], [`${s}\nsite`]);
  const v = m.get(`${s}\nsite`).text;
  assert.equal(v.length, 80); assert.ok(v.startsWith('pick one yyy'));
});
test('outputs: local targets only, the newest first, one per target, a clear empties the list', () => {
  const s = 'abcdefgh-0000-4000-8000-000000000001', abs = path.resolve('/srv/out/index.html');
  const m = parseOutputs(jl([
    { at: '2026-03-11T10:00:00Z', session: s, job: 'Site', target: abs, label: 'first' },
    { at: '2026-03-11T10:01:00Z', session: s, job: 'site', target: 'http://127.0.0.1:8080/x', label: 'srv' },
    { at: '2026-03-11T10:02:00Z', session: s, job: 'site', target: abs, label: `again\u0007 ${'z'.repeat(60)}` },
    { at: '2026-03-11T10:03:00Z', session: s, job: 'site', target: 'https://example.com/x', label: 'remote' },
    { at: '2026-03-11T10:03:00Z', session: s, job: 'site', target: 'http://user:pw@localhost/x', label: 'creds' },
    { at: '2026-03-11T10:03:00Z', session: s, job: 'site', target: 'file:///etc/passwd', label: 'file url' },
    { at: '2026-03-11T10:03:00Z', session: s, job: 'site', target: 'rel/x.html', label: 'relative' },
    { at: '2026-03-11T10:03:00Z', session: s, job: 'old', target: abs }, { at: '2026-03-11T10:04:00Z', session: s, job: 'old', clear: true },
  ]));
  assert.deepEqual([...m.keys()], [`${s}\nsite`]);
  const list = m.get(`${s}\nsite`);
  assert.deepEqual(list.map((x) => x.target), [abs, 'http://127.0.0.1:8080/x']);
  assert.equal(list[0].label.length, 48); assert.ok(list[0].label.startsWith('again zzz'));
  const many = parseOutputs(jl(Array.from({ length: 12 }, (_, k) => ({ at: `2026-03-11T10:${String(k).padStart(2, '0')}:00Z`, session: s, job: 'j', target: `http://localhost/${k}` }))));
  assert.equal(many.get(`${s}\nj`).length, OUTPUTS_MAX); assert.equal(many.get(`${s}\nj`)[0].target, 'http://localhost/11');
});
test('outputs: kindOf, localUrl, localPath and the opener of each platform', () => {
  assert.deepEqual(['a.HTML', 'b.htm', 'c.mp4', 'd.mov', 'e.png', 'f.JPG', 'g.pdf', 'h.md', 'noext'].map((f) => kindOf(path.resolve('/x', f))),
    ['html', 'html', 'video', 'video', 'image', 'image', 'pdf', 'file', 'file']);
  assert.equal(kindOf(path.resolve('/x/dir.png'), true), 'folder');
  assert.equal(kindOf('http://localhost:3000/a.png'), 'url');
  assert.equal(localUrl('https://127.0.0.1/x'), 'https://127.0.0.1/x');
  for (const bad of ['https://127.0.0.1.evil.example/', 'http://0.0.0.0/', 'ftp://localhost/', 'http://localhost/a b', 'javascript:alert(1)', 7]) assert.equal(localUrl(bad), '', String(bad));
  assert.equal(localPath('rel/x'), ''); assert.equal(localPath('http://localhost/'), ''); assert.equal(localPath(path.resolve('/a/../b')), path.resolve('/b'));
  assert.deepEqual(openerFor('/a b/x.html', 'darwin'), ['open', ['/a b/x.html']]);
  assert.deepEqual(openerFor('/x.html', 'linux'), ['xdg-open', ['/x.html']]);
  assert.deepEqual(openerFor('C:\\out\\x.html', 'win32'), ['cmd', ['/c', 'start', '""', 'C:\\out\\x.html']]);
  assert.equal(openerFor('C:\\out\\a&calc.html', 'win32'), null, 'a cmd metacharacter is never passed to start');
});
test('outputs: openOutput opens only a registered target that is there, by number, through the stubbed opener', async () => {
  const d = tmpDir(), s = 'abcdefgh-0000-4000-8000-000000000001', page = path.join(d, 'index.html'), gone = path.join(d, 'gone.mp4');
  fs.writeFileSync(page, 'x'); fs.writeFileSync(gone, 'x');
  fs.writeFileSync(path.join(d, 'outputs.jsonl'), jl([
    { at: '2026-03-11T10:00:00Z', session: s, job: 'site', target: gone, label: 'film' },
    { at: '2026-03-11T10:01:00Z', session: s, job: 'site', target: page, label: 'page' },
  ]));
  const outputs = await readOutputs(path.join(d, 'outputs.jsonl'));
  const opened = [];
  const opener = (t) => { opened.push(t); return true; };
  const key = `${s}\nsite`;
  const r = await openOutput({ jobKey: key, outputs, body: {}, opener });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, output: 0, kind: 'html', label: 'page' });
  assert.ok(!JSON.stringify(r.body).includes(d), 'the answer never holds the path');
  assert.equal((await openOutput({ jobKey: key, outputs, body: { output: 1 }, opener })).body.kind, 'video');
  assert.deepEqual(opened, [page, gone]);
  fs.unlinkSync(gone);
  const g = await openOutput({ jobKey: key, outputs, body: { output: 1 }, opener });
  assert.equal(g.status, 404); assert.match(g.body.error, /gone/);
  assert.equal((await openOutput({ jobKey: undefined, outputs, body: {}, opener })).status, 404, 'an id that is not on the tree');
  assert.equal((await openOutput({ jobKey: `${s}\nother`, outputs, body: {}, opener })).status, 404, 'a job with no output');
  for (const body of [{ path: page }, { output: -1 }, { output: 'x' }, { output: 99 }, [], null]) assert.equal((await openOutput({ jobKey: key, outputs, body, opener })).status, 400, JSON.stringify(body));
  assert.equal((await openOutput({ jobKey: key, outputs, body: {}, opener: () => false })).status, 500);
  assert.equal(opened.length, 2, 'nothing else was opened');
});
test('needs: a job that needs you is red, says why, outranks done and Got it, rolls up to its lead and project, and is never parked', async () => {
  const h = makeHome(tmpDir(), NOW, { marks: true });
  const r0 = await brainOf({ h });
  const b2 = r0.node('B2');
  const builder = r0.B.jobs.find((x) => x.job === 'builder');
  assert.equal(builder.st, 'await'); assert.equal(builder.needs, 'Pick one of 3 colourways for the hero');
  assert.equal(builder.nDone, 1, 'its helper is still finished');
  assert.equal(b2.st, 'await'); assert.equal(b2.needs, 1); assert.equal(b2.needsOnly, undefined, 'the inner flag stays on the server');
  const beta = r0.B.projects.find((p) => p.base === 'beta');
  assert.equal(beta.st, 'await'); assert.equal(beta.needs, 1);
  assert.equal(r0.B.projects[0].base, 'beta', 'the project that needs you comes first');
  assert.equal(r0.B.you.st, 'await');
  // B1 awaits on its own; B2 only through its job: the job counts once
  assert.equal(r0.B.counts.await, 2);
  assert.ok(!r0.B.jobs.some((x) => x.job.startsWith('Plan the') && x.needs), 'a cleared reason is gone');
  await markSeen(path.join(h.dataDir, 'seen.jsonl'), { id: builder.id, name: 'builder' }, NOW + MIN);
  await markPark(path.join(h.dataDir, 'parked.jsonl'), { id: builder.id, name: 'builder', until: '' }, NOW + MIN);
  const r1 = await brainOf({ h }, NOW + 2 * MIN);
  assert.equal(r1.B.jobs.find((x) => x.id === builder.id).st, 'await', 'Got it and Park do not hide a job that needs you');
  assert.ok(!r1.B.parked.some((x) => x.id === builder.id));
  fs.appendFileSync(path.join(h.dataDir, 'needs.jsonl'), jl([{ at: new Date(NOW + 3 * MIN).toISOString(), session: h.ids.B2, job: 'Builder', needs: '' }]));
  const r2 = await brainOf({ h }, NOW + 4 * MIN);
  assert.ok(!r2.B.jobs.some((x) => x.id === builder.id), 'cleared: Got it and Park apply again');
  assert.equal(r2.node('B2').st, 'run'); assert.equal(r2.node('B2').needs, undefined);
});
test('outputs: a job shows that it has outputs, their labels and type words, never a target; done with one counts to look at', async () => {
  const h = makeHome(tmpDir(), NOW, { marks: true });
  const keys = new Map();
  const P = source.locate({ claudeDir: h.claudeDir });
  const c = await collect({ P, cache: createUsageCache(), prices: PRICES, team: [], now: NOW });
  const B = await buildBrain(c.sess, { dataDir: h.dataDir, total: c.total, keys, now: NOW });
  const g = B.jobs.find((x) => x.job === 'Gallery'), maker = B.jobs.find((x) => x.role === 'maker');
  assert.equal(g.st, 'done'); assert.equal(g.hasOutput, true);
  assert.deepEqual(g.outputs, [{ label: 'Gallery: 6 pages', kind: 'html' }, { label: 'Frames', kind: 'folder' }, { label: 'Preview server', kind: 'url' }]);
  assert.deepEqual(maker.outputs, [{ label: 'First frames', kind: 'image' }], 'a running job can show a partial output');
  assert.ok(B.jobs.filter((x) => x.outputs).every((x) => x.outputs.every((o) => Object.keys(o).join() === 'label,kind')));
  assert.equal(B.counts.look, 1, 'a finished job with an output; the running one is not counted');
  assert.equal(countStates([{ st: 'done', hasOutput: true }, { st: 'done' }, { st: 'await', needsOnly: true }, { st: 'await' }]).look, 1);
  const text = JSON.stringify(B);
  for (const t of Object.values(h.outputs)) assert.ok(!text.includes(t));
  assert.ok(!text.includes('CANARY'));
  assert.equal(keys.get(g.id), `${h.ids.B2}\ngallery`, 'the server keeps which session and job an id stands for');
});
test('hooks: --needs and --needs-clear write the lead\'s reason; --output keeps a target that exists or a local URL', async () => {
  const d = tmpDir(), s = 'abcdefgh-hook-8', page = path.join(d, 'page.html');
  fs.writeFileSync(page, 'x');
  assert.equal((await runHook(d, ['--job', 'Gallery', '--needs', `Pick\u0007 a colour ${'y'.repeat(100)}`, '--session', s])).out, 'needs saved');
  const v = parseNeeds(fs.readFileSync(path.join(d, 'needs.jsonl'), 'utf8')).get(`${s}\ngallery`).text;
  assert.equal(v.length, 80); assert.ok(v.startsWith('Pick a colour'));
  assert.equal((await runHook(d, ['--job', 'gallery', '--needs-clear', '--session', s])).out, 'needs cleared');
  assert.equal(parseNeeds(fs.readFileSync(path.join(d, 'needs.jsonl'), 'utf8')).size, 0);
  assert.equal((await runHook(d, ['--job', 'Gallery', '--output', page, '--output-label', `The page\u0007 ${'z'.repeat(60)}`, '--session', s])).out, 'output saved');
  assert.equal((await runHook(d, ['--job', 'Gallery', '--output', 'http://localhost:5173/', '--session', s])).code, 0);
  const list = parseOutputs(fs.readFileSync(path.join(d, 'outputs.jsonl'), 'utf8')).get(`${s}\ngallery`);
  assert.deepEqual(list.map((x) => x.target), ['http://localhost:5173/', page]);
  assert.equal(list[1].label.length, 48); assert.ok(list[1].label.startsWith('The page zzz'));
  for (const bad of [path.join(d, 'missing.html'), 'page.html', 'https://example.com/', 'file:///x']) assert.equal((await runHook(d, ['--job', 'Gallery', '--output', bad, '--session', s])).code, 2, bad);
  assert.equal((await runHook(d, ['--output', page, '--session', s])).code, 2, 'no job');
  assert.equal((await runHook(d, ['--job', 'Gallery', '--output-label', 'x', '--session', s])).code, 2, 'a label without an output');
  assert.equal((await runHook(d, ['--job', 'Gallery', '--needs', 'x', '--needs-clear', '--session', s])).code, 2);
  assert.equal((await runHook(d, ['--job', 'Gallery', '--output-clear', '--session', s])).out, 'outputs cleared');
  assert.equal(parseOutputs(fs.readFileSync(path.join(d, 'outputs.jsonl'), 'utf8')).size, 0);
  assert.equal(liveOf(d, s), null, 'none of these touch the session state');
});
test('outputs: an output registered after Got it brings the job back to look at; one from before does not', async () => {
  const h = makeHome(tmpDir(), NOW, { marks: true });
  const r0 = await brainOf({ h });
  const plan = r0.B.jobs.find((x) => x.job.startsWith('Plan the'));
  await markSeen(path.join(h.dataDir, 'seen.jsonl'), { id: plan.id, name: plan.job }, NOW + MIN);
  assert.ok(!(await brainOf({ h }, NOW + 2 * MIN)).B.jobs.some((x) => x.id === plan.id), 'Got it takes it off');
  fs.appendFileSync(path.join(h.dataDir, 'outputs.jsonl'), jl([{ at: new Date(NOW + 3 * MIN).toISOString(), session: h.ids.B2, job: plan.job, target: h.outputs.page, label: 'The plan' }]));
  const back = (await brainOf({ h }, NOW + 4 * MIN)).B.jobs.find((x) => x.id === plan.id);
  assert.ok(back, 'a new output brings it back'); assert.equal(back.st, 'done'); assert.deepEqual(back.outputs, [{ label: 'The plan', kind: 'html' }]);
  await markSeen(path.join(h.dataDir, 'seen.jsonl'), { id: plan.id, name: plan.job }, NOW + 5 * MIN);
  assert.ok(!(await brainOf({ h }, NOW + 6 * MIN)).B.jobs.some((x) => x.id === plan.id), 'Got it again takes it off');
});
