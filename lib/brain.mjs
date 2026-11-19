// The Brain tab: every session written lately (the lead) and the jobs it drives. A job is the helpers that share a job
// name ("<Job>: <step>" in their description, or the local config's jobGroups); it has one card, with its helpers,
// numbers, tool tags, background work, what it did (names and counts) and its outcome line. collect() keeps
// server-side records (with session ids, never sent); buildBrain() turns them into the payload (hashed ids only).
import path from 'node:path';
import { startOfDay, one, uniqueLabels } from './util.mjs';
import { dedupe, usdOf, mainFamily, burstsOf } from './usage.mjs';
import { sessionTools, folderClosed } from './sesstools.mjs';
import { todayTimeline } from './timeline.mjs';
import {
  RUN_MS, LIVE_SHOW_MS, nodeId, jobId, jobState, helperState, jobSeen, jobOf, projectKey, weekStart, sessionState, sessionShown, countStates,
  readSeen, readPark, applyPark, readLiveDir, readOutcomes, readNeeds, effortWord,
} from './states.mjs';
import { readOutputs, outputsForPage } from './outputs.mjs';
import * as source from './sources/index.mjs';

const tok = (r) => r.i + r.o + r.cw + r.cr;
const sumUsd = (rs, prices) => (prices ? Math.round(rs.reduce((s, r) => s + usdOf(r, prices), 0) * 1e4) / 1e4 : null);
const newestEffort = (rs) => { for (let k = rs.length - 1; k >= 0; k--) if (rs[k].effort) return rs[k].effort; return ''; };

/** The label rule: the last segment of the working folder; else the end of the folder name; else the folder name. */
export function projectLabel(cwd, folder) {
  let label = source.labelOfCwd(cwd);
  if (!label) label = one(String(folder).split('-').filter(Boolean).pop() || '', 40);
  return label || one(folder, 40);
}

/** -> {sess: Sess[], total} */
export async function collect({ P, cache, prices = null, team = [], now = Date.now() }) {
  const teamEffort = new Map(team.map((t) => [t.name, t.effort]));
  const { sessions, total } = await source.listSessions(P, Math.min(now - LIVE_SHOW_MS, startOfDay(now)));
  const sess = [];
  for (const s of sessions) {
    const helpers = await source.listHelpers(s.subDir);
    const resp = dedupe(await cache.rows(s.file, s.st), new Map(), true);
    const helperRows = [];
    for (const h of helpers) {
      const rows = await cache.rows(h.file, h.st);
      helperRows.push(rows);
      dedupe(rows, resp, false);
    }
    const all = [...resp.values()];
    const own = all.filter((r) => r.own).sort((a, b) => a.t - b.t);
    if (!own.length) continue;
    const last = Math.max(s.st.mtimeMs, ...helpers.map((h) => h.st.mtimeMs));
    const times = all.map((r) => r.t);
    const spans = burstsOf(times);
    const busyMin = Math.max(1, Math.round(spans.reduce((a, [x, y]) => a + (y - x), 0) / 60000));
    const closed = await folderClosed(s.dir || path.join(P.projectsDir, s.folder), now);
    const runs = [];
    for (let k = 0; k < helpers.length; k++) {
      const h = helpers[k];
      const meta = await source.helperMeta(h.file);
      const rs = [...dedupe(helperRows[k]).values()].sort((a, b) => a.t - b.t);
      const T = await sessionTools(h.file, h.st, now, { side: true, closed });
      const ts = rs.map((r) => r.t);
      runs.push({
        key: path.basename(h.file, '.jsonl'), who: meta.who, job: meta.job, finished: meta.finished, bg: T.bg, bgw: T.bgw, did: T.did, toolUseId: meta.toolUseId, tool: T.tool, skill: T.skill,
        start: ts.length ? ts[0] : null, end: ts.length ? ts[ts.length - 1] : null, spans: burstsOf(ts),
        tok: rs.reduce((a, r) => a + tok(r), 0), usd: sumUsd(rs, prices), model: mainFamily(rs),
        effort: teamEffort.get(meta.who) || newestEffort(rs), mtimeMs: h.st.mtimeMs,
      });
    }
    for (const r of runs) if (r.finished && r.toolUseId) closed.add(r.toolUseId);
    const T = await sessionTools(s.file, s.st, now, { closed });
    const head = await source.sessionHead(s.file);
    sess.push({
      session: s.session, folder: s.folder, project: { key: projectKey(s.folder), label: projectLabel(head.cwd, s.folder) }, entry: head.entry,
      turns: own.length, tokens: all.reduce((a, r) => a + tok(r), 0), own: own.reduce((a, r) => a + tok(r), 0),
      usd: sumUsd(all, prices), ownUsd: sumUsd(own, prices), model: mainFamily(own), effort: newestEffort(own),
      idleSec: Math.max(0, Math.round((now - last) / 1000)), ownAt: s.st.mtimeMs, last, first: Math.min(...times), spans, busyMin,
      bg: T.bg, bgw: T.bgw, tool: T.tool, skill: T.skill, runs,
    });
  }
  return { sess, total };
}

/** The labels of the projects in a list of Sess, with " (2)" for a second folder that has the same label. */
const labelsOf = (sess) => uniqueLabels(sess.map((s) => s.project));

const RANK = { await: 0, run: 1, wait: 2, idle: 3, done: 4 };
const PER_PROJECT = 8, HELPERS_MAX = 24, DONE_MAX = 80, JOB_HELPERS = 12, DID_CALLS = 12, DID_SCRIPTS = 8;
const minOf = (r) => (r.start != null && r.end != null ? Math.max(1, Math.round((r.end - r.start) / 60000)) : null);

/** What a job's helpers did, added up: {calls: [{k, name, n}] (the most called), total, scripts, scriptMore, files, errors}. */
export function sumDid(list) {
  const calls = new Map(), scripts = new Map();
  let files = 0, errors = 0, total = 0;
  for (const d of list) {
    if (!d) continue;
    for (const c of d.calls) { const key = `${c.k}\n${c.name}`; const had = calls.get(key); if (had) had.n += c.n; else calls.set(key, { k: c.k, name: c.name, n: c.n }); total += c.n; }
    d.scripts.forEach((s, k) => scripts.set(s, (scripts.get(s) || 0) + d.scripts.length - k));
    files += d.files; errors += d.errors;
  }
  const names = [...scripts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
  return { calls: [...calls.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, DID_CALLS), total,
    scripts: names.slice(0, DID_SCRIPTS), scriptMore: Math.max(0, names.length - DID_SCRIPTS), files, errors };
}

/** Sess[] -> Brain (the /api/brain payload). */
/**
 * names: {label: display name} and groups: {helper description: job name} from the local config (readConfig). The
 * helpers of a shown session that share a job name are one job (B.jobs, kind 'job', parent = the session's id). Its
 * state is the worst of its helpers'; all finished is done (green, still on the tree); Got it takes it off.
 */
export async function buildBrain(sess, { dataDir, total = 0, team = [], spend = null, pricesAsOf = '', names = {}, groups = {}, keys = null, now = Date.now() } = {}) {
  const seen = await readSeen(path.join(dataDir, 'seen.jsonl'));
  const park = await readPark(path.join(dataDir, 'parked.jsonl'));
  const lives = await readLiveDir(path.join(dataDir, 'live'));
  const outcomes = await readOutcomes(path.join(dataDir, 'outcomes.jsonl'));
  const needsOf = await readNeeds(path.join(dataDir, 'needs.jsonl'));
  const outputsOf = await readOutputs(path.join(dataDir, 'outputs.jsonl'));
  const ws = weekStart(now);
  const labels = labelsOf(sess);
  const shownName = (label) => (Object.prototype.hasOwnProperty.call(names, label) && names[label]) || label;
  const nodes = [];
  const jobs = [];
  const done = new Map();
  const lanes = new Map();
  const jobSpans = new Map();
  const addDone = (id, name, at, outcome = '') => { if (at >= ws && (!done.has(id) || done.get(id).at < at)) done.set(id, { id, name, at, ...(outcome ? { outcome } : {}) }); };
  for (const S of sess) {
    const lf = lives.get(S.session) || null;
    if (!sessionShown({ file: lf, idleSec: S.idleSec, now })) continue;
    const id = nodeId(S.session);
    const sa = seen.has(id) ? seen.get(id).at : null;
    const lastAt = lf && lf.at ? lf.at : S.last;
    const args = { file: lf, idleSec: S.idleSec, ownAt: S.ownAt, lastAt, seenAt: sa, bg: S.bg };
    let st = sessionState(args);
    if (st === 'done') { addDone(id, (seen.get(id) || {}).name || 'session', sa); continue; }
    const waitJob = st === 'run' && S.bg > 0 && sessionState({ ...args, bg: 0 }) !== 'run';
    const hs = S.runs.map((r) => ({
      role: r.who, st: helperState({ finished: r.finished, idleSec: Math.max(0, (now - r.mtimeMs) / 1000), bg: r.bg }) === 'run' ? 'run' : 'done', model: r.model, effort: effortWord(r.effort),
      tokens: r.tok, usd: r.usd, min: r.start != null && r.end != null ? Math.max(1, Math.round((r.end - r.start) / 60000)) : null,
      ...(r.tool ? { tool: r.tool } : {}), ...(r.skill ? { skill: r.skill } : {}), at: r.mtimeMs, spans: r.spans,
    })).sort((a, b) => (a.st === b.st ? b.at - a.at : a.st === 'run' ? -1 : 1));
    lanes.set(id, { spans: S.spans });
    const base = labels.get(S.project.key) || S.project.label;
    const project = shownName(base);
    const mine = [];
    let jobsDone = 0;
    // the helpers that share a job name are one job; the name keeps the spelling of the first helper on it
    const byJob = new Map();
    for (const r of [...S.runs].sort((x, y) => (x.start || 0) - (y.start || 0))) {
      const { job, step } = jobOf(r.job, r.who, groups);
      const k = job.toLowerCase();
      (byJob.get(k) || byJob.set(k, { name: job, runs: [] }).get(k)).runs.push({ r, step, st: helperState({ finished: r.finished, idleSec: Math.max(0, (now - r.mtimeMs) / 1000), bg: r.bg }) });
    }
    for (const [k, G] of byJob) {
      const jid = jobId(S.session, k);
      const jsa = seen.has(jid) ? seen.get(jid).at : null;
      const lastAt = Math.max(...G.runs.map((x) => x.r.mtimeMs));
      const jkey = `${S.session}\n${k}`;
      if (keys) keys.set(jid, jkey); // server side only: which session and job an id stands for
      // the lead's "needs you" outranks every other state of the job, and keeps it on the tree
      const needs = (needsOf.get(jkey) || {}).text || '';
      const jst = needs ? 'await' : jobState(G.runs.map((x) => x.st));
      const outcome = (outcomes.get(jkey) || {}).text || '';
      const outs = (await outputsForPage(outputsOf.get(jkey))).map(({ label, kind }) => ({ label, kind }));
      // an output registered after Got it is something new to look at: the job comes back
      const outAt = Math.max(0, ...(outputsOf.get(jkey) || []).map((x) => x.at));
      const gone = !needs && jobSeen({ st: jst, seenAt: jsa, lastAt: Math.max(lastAt, outs.length ? outAt : 0) });
      if (jst === 'done' || gone) jobsDone++;
      if (gone) { addDone(jid, (seen.get(jid) || {}).name || G.name, jsa, outcome); continue; }
      const rs = G.runs.map((x) => x.r);
      const top = rs.reduce((m, r) => (r.tok > m.tok ? r : m), rs[0]);
      const roles = [...new Set(rs.map((r) => r.who))];
      const newest = rs.reduce((m, r) => (r.mtimeMs > m.mtimeMs ? r : m), rs[0]);
      const bgw = G.runs.filter((x) => x.st === 'run').flatMap((x) => x.r.bgw).sort((x, y) => y.since - x.since).slice(0, 4);
      const mins = rs.map(minOf).filter((m) => m != null);
      const usd = rs.some((r) => r.usd == null) ? null : Math.round(rs.reduce((s, r) => s + r.usd, 0) * 1e4) / 1e4;
      const order = { run: 0, idle: 1, done: 2 };
      const helpers = [...G.runs].sort((x, y) => order[x.st] - order[y.st] || y.r.mtimeMs - x.r.mtimeMs).map(({ r, step, st }) => ({
        role: r.who, step, st, model: r.model, effort: effortWord(r.effort), tokens: r.tok, usd: r.usd, min: minOf(r),
        calls: r.did ? r.did.calls.reduce((s, c) => s + c.n, 0) : 0, files: r.did ? r.did.files : 0, errors: r.did ? r.did.errors : 0,
        ...(st === 'run' && r.tool ? { tool: r.tool } : {}), ...(st === 'run' && r.skill ? { skill: r.skill } : {}),
      }));
      jobSpans.set(jid, rs.flatMap((r) => r.spans).sort((x, y) => x[0] - y[0]));
      const starts = rs.map((r) => r.start).filter((x) => x != null);
      mine.push({
        id: jid, kind: 'job', parent: id, pkey: S.project.key, project, job: G.name, role: roles.length === 1 ? roles[0] : '', st: jst, model: top.model, effort: effortWord(top.effort),
        tokens: rs.reduce((s, r) => s + r.tok, 0), usd, min: mins.length ? mins.reduce((s, m) => s + m, 0) : null,
        started: starts.length ? Math.min(...starts) : null, at: lastAt, n: rs.length, nDone: G.runs.filter((x) => x.st === 'done').length,
        helpers: helpers.slice(0, JOB_HELPERS), helperMore: Math.max(0, helpers.length - JOB_HELPERS), did: sumDid(rs.map((r) => r.did)),
        ...(outcome ? { outcome } : {}), ...(needs ? { needs } : {}), ...(outs.length ? { hasOutput: true, outputs: outs } : {}),
        ...(jst === 'run' && newest.tool ? { tool: newest.tool } : {}), ...(jst === 'run' && newest.skill ? { skill: newest.skill } : {}),
        ...(bgw.length ? { bg: G.runs.reduce((s, x) => s + (x.st === 'run' ? x.r.bg : 0), 0), bgw } : {}),
      });
    }
    mine.sort((a, b) => RANK[a.st] - RANK[b.st] || b.at - a.at);
    // a job that needs you makes its lead red too (counted once, on the job)
    const needN = mine.filter((j) => j.needs).length;
    const needsOnly = needN > 0 && st !== 'await';
    if (needsOnly) st = 'await';
    jobs.push(...mine.slice(0, HELPERS_MAX));
    nodes.push({
      id, kind: 'session', parent: S.project.key, project, st,
      entry: S.entry, started: S.first, at: lastAt, model: S.model, effort: effortWord(S.effort),
      tokens: S.tokens, usd: S.usd, own: S.own, ownUsd: S.ownUsd, min: S.busyMin, plus: hs.filter((h) => h.st === 'run').length,
      helpers: hs.slice(0, HELPERS_MAX).map(({ at, spans, ...h }) => h), helperMore: Math.max(0, hs.length - HELPERS_MAX),
      jobs: { run: mine.filter((j) => j.st === 'run').length, done: jobsDone, n: byJob.size }, jobMore: Math.max(0, mine.length - HELPERS_MAX),
      ...(S.bgw && S.bgw.length ? { bgw: S.bgw } : {}),
      ...(lf && lf.task ? { task: lf.task } : {}),
      ...(S.tool ? { tool: S.tool } : {}), ...(S.skill ? { skill: S.skill } : {}), ...(S.bg ? { bg: S.bg } : {}),
      ...(waitJob ? { waitJob: true } : {}), ...(lf ? {} : { noHooks: true }), ...(needN ? { needs: needN } : {}), ...(needsOnly ? { needsOnly: true } : {}),
    });
  }
  for (const [id, x] of seen) if (!done.has(id) && x.at >= ws) addDone(id, x.name || 'session', x.at);
  const doneList = [...done.values()].sort((a, b) => b.at - a.at);
  const P = applyPark([...nodes, ...jobs], park, now);
  const parkedJobs = P.nodes.filter((n) => n.kind === 'job');
  P.nodes = P.nodes.filter((n) => n.kind !== 'job');
  // at most PER_PROJECT nodes per project: the most urgent first, then the newest
  const byProject = new Map();
  for (const n of P.nodes) (byProject.get(n.parent) || byProject.set(n.parent, []).get(n.parent)).push(n);
  const shown = [];
  const projects = [];
  for (const [key, list] of byProject) {
    list.sort((a, b) => RANK[a.st] - RANK[b.st] || b.at - a.at);
    const keep = list.slice(0, PER_PROJECT);
    shown.push(...keep);
    const st = keep.reduce((best, n) => (RANK[n.st] < RANK[best] ? n.st : best), 'idle');
    const base = labels.get(key) || keep[0].project;
    projects.push({ key, label: keep[0].project, base, st, n: keep.length, more: list.length - keep.length });
  }
  const onTree = new Set(shown.map((n) => n.id));
  const shownJobs = parkedJobs.filter((j) => onTree.has(j.parent));
  for (const p of projects) { const js = shownJobs.filter((j) => j.pkey === p.key); p.jobs = js.length; const nn = js.filter((j) => j.needs).length; if (nn) p.needs = nn; if (js.some((j) => RANK[j.st] < RANK[p.st])) p.st = js.reduce((b, j) => (RANK[j.st] < RANK[b] ? j.st : b), p.st); }
  for (const j of shownJobs) {
    const L = lanes.get(j.parent);
    if (L) (L.helpers || (L.helpers = [])).push({ id: j.id, role: j.role, st: j.st, model: j.model, spans: jobSpans.get(j.id) || [] });
  }
  projects.sort((a, b) => RANK[a.st] - RANK[b.st] || a.label.localeCompare(b.label));
  const counts = countStates([...shown, ...shownJobs], doneList.length);
  for (const n of shown) delete n.needsOnly;
  const running = shown.filter((n) => n.st === 'run').length;
  return {
    ok: true, now, source: source.LABEL, empty: total === 0, hooks: lives.size > 0,
    you: { st: shown.some((n) => n.st === 'await') ? 'await' : running ? 'run' : 'idle', sessions: shown.length, running, jobs: shownJobs.length },
    projects, nodes: shown, jobs: shownJobs.map(({ pkey, ...j }) => j), parked: P.parked, done: doneList.slice(0, DONE_MAX), counts, weekStart: ws, spend,
    team: team.map((t) => ({ name: t.name, model: t.model, effort: effortWord(t.effort) })), pricesAsOf,
    today: todayTimeline({ nodes: shown, projects, lanes, now }),
  };
}
