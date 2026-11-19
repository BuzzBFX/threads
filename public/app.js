// The Threads page: five tabs drawn from the local server's /api answers. No build step, no packages.
// Every string is set with textContent; styles are set through the CSSOM only (the CSP blocks style attributes).
'use strict';
(() => {
  const TOKEN = document.querySelector('meta[name="threads-token"]').content;
  const $ = (id) => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------- helpers
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') for (const [p, x] of Object.entries(v)) e.style.setProperty(p, x);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(4)) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  function s(tag, attrs, parent, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  const store = {
    get(area, k) { try { return area.getItem(k); } catch { return null; } },
    set(area, k, v) { try { area.setItem(k, v); } catch { /* storage blocked: this visit only */ } },
  };
  // a phone or a narrow window: the tree stacks its projects and fits the width (styles.css has the same 700px)
  const NARROW = window.matchMedia ? window.matchMedia('(max-width: 700px)') : { matches: false };
  const still = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const md = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const keyMs = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : Date.now(); };
  const when = (ms) => (dayOf(ms) === dayOf(Date.now()) ? hhmm(ms) : `${md(ms)}, ${hhmm(ms)}`);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const agoText = (sec) => (sec < 60 ? `${sec}s ago` : sec < 3600 ? `${Math.round(sec / 60)} min ago` : `${Math.round(sec / 3600)} h ago`);

  // ---------------------------------------------------------------- state
  const VIEWS = [['brain', 'Brain'], ['details', 'Details'], ['tools', 'Tools'], ['team', 'Team']];
  const LAYOUTS = [['tree', 'Tree'], ['timeline', 'Timeline']];
  const hashParts = () => location.hash.replace(/^#/, '').split('/');
  const viewOfHash = () => { const v = hashParts()[0]; return VIEWS.some(([k]) => k === v) ? v : 'brain'; };
  // the Brain's layout: #brain/timeline or #brain/tree wins, else the one this viewer picked last
  const layoutOf = () => { const [v, l] = hashParts(); if (v === 'brain' && LAYOUTS.some(([k]) => k === l)) return l; return store.get(localStorage, 'threads-layout') === 'timeline' ? 'timeline' : 'tree'; };
  const ui = { view: viewOfHash(), brLayout: layoutOf(), brSel: null, brDone: false, brParkOpen: false, brHelpOpen: !NARROW.matches, brFocus: false, brRename: null, brRenameText: null, dragging: false, pending: false,
    toolSort: 'az', toolQ: '', toolOpen: new Set() };
  const data = { brain: null, details: null, tools: null, team: null };
  const errors = {};
  const feedbacks = new Map();
  let money = store.get(localStorage, 'threads-money') === 'usd' ? 'usd' : 'tokens';

  // ---------------------------------------------------------------- server
  function banner(text) { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; }
  async function api(path, opts = {}) {
    let r;
    try { r = await fetch(path, { ...opts, headers: { 'X-Threads-Token': TOKEN, ...(opts.headers || {}) } }); } catch (e) {
      banner('The Threads server is not answering. Start it again: node server.mjs');
      throw e;
    }
    banner('');
    if (r.status === 401) {
      const last = Number(store.get(sessionStorage, 'threads-reload') || 0);
      if (Date.now() - last > 60000) { store.set(sessionStorage, 'threads-reload', String(Date.now())); location.reload(); }
      throw new Error('the server restarted');
    }
    return r;
  }
  async function post(path, body) {
    try {
      const res = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    } catch (e) { return { ok: false, error: e.message || 'the server is not answering' }; }
  }
  const ENDPOINT = { brain: '/api/brain', details: '/api/details', tools: '/api/tools', team: '/api/team' };
  const busy = {};
  const retry = {};
  async function load(k) {
    if (busy[k]) return;
    busy[k] = true;
    try {
      const r = await api(ENDPOINT[k]);
      const v = await r.json();
      if (r.ok) { data[k] = v; delete errors[k]; } else errors[k] = v.error || `HTTP ${r.status}`;
      const pending = v && (v.pending || v.usage === 'pending');
      if (pending && !retry[k]) retry[k] = setTimeout(() => { retry[k] = null; load(k); }, 6000);
    } catch (e) { errors[k] = e.message || 'failed'; }
    busy[k] = false;
    render();
  }
  function feedback(key, text, bad) {
    feedbacks.set(key, { text, bad, at: Date.now() });
    render();
    setTimeout(() => { const f = feedbacks.get(key); if (f && Date.now() - f.at >= 3900) { feedbacks.delete(key); render(); } }, 4000);
  }
  const fbNode = (key) => { const f = feedbacks.get(key); return f ? h('span', { class: `br-feedback${f.bad ? ' bad' : ''}`, text: f.text, role: 'status' }) : null; };

  // ---------------------------------------------------------------- shared marks
  const FAM = { fable: ['F', 'Fable'], opus: ['O', 'Opus'], sonnet: ['S', 'Sonnet'], haiku: ['H', 'Haiku'], other: ['?', 'model not known'] };
  const FAM_ORDER = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
  const famOf = (m) => (m && FAM[m] ? m : 'other');
  const BR = { run: ['●', 'running'], await: ['!', 'awaiting you'], wait: ['⧗', 'waiting'], idle: ['…', 'idle'], done: ['✓', 'done'], off: ['–', 'off the tree'] };
  const BR_TAG = { run: 'RUNNING', await: 'AWAITING YOU', wait: 'WAITING', idle: 'IDLE · to review', done: 'DONE' };
  // a job that stopped before every helper finished is idle; a finished one is done (green) and waits for Got it
  // a job the lead marked "needs you" says so; a finished job with an output says it is ready to look at
  const tagOf = (st, n) => (n && n.kind === 'job' && n.needs ? 'NEEDS YOU' : n && n.kind === 'job' && st === 'done' && n.hasOutput ? 'DONE · output ready'
    : n && n.kind === 'job' && st === 'idle' ? 'IDLE · not finished' : BR_TAG[st]);
  const fmtTok = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v || 0)));
  const fmtUsd = (v) => (v == null ? '–' : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
  const brTok = (tokens, usd, blank) => (money === 'usd' ? fmtUsd(usd) : !tokens && blank ? '–' : fmtTok(tokens || 0));
  const brMin = (m) => (m == null ? '' : m < 100 ? `${m}m` : `${Math.round(m / 60)}h`);
  const brChip = (m) => h('b', { class: `br-chip m-${famOf(m)}`, text: FAM[famOf(m)][0], title: FAM[famOf(m)][1] });
  const brG = (st) => h('span', { class: 'br-g', text: (BR[st] || BR.off)[0], 'aria-hidden': 'true' });
  const brTag = (st, n) => h('span', { class: 'br-st', text: `${BR[st][0]} ${tagOf(st, n)}${st === 'run' && n && n.waitJob ? ' · waiting on a job' : ''}`,
    title: st === 'run' && n && n.waitJob ? `Its turn ended; ${n.bg > 1 ? `${n.bg} background jobs it started are` : 'a background job it started is'} still running` : null });
  const BR_TK = { tool: 'tool', skill: 'skill', helper: 'helper', mcp: 'MCP server' };
  function brToolText(x) {
    if (!x || (!x.tool && !x.skill)) return '';
    const parts = [];
    if (x.skill) parts.push(x.skill);
    if (x.tool && !(x.tool.k === 'skill' && x.tool.name === x.skill)) parts.push(x.tool.k === 'helper' ? `▸ ${x.tool.name}` : x.tool.name);
    return parts.join(' · ');
  }
  function brTool(x, cls = 'br-tl') {
    const t = brToolText(x);
    if (!t) return null;
    const tip = [x.skill ? `skill in use: ${x.skill}` : '', x.tool ? `last call: ${x.tool.name} (${BR_TK[x.tool.k] || 'tool'})` : ''].filter(Boolean).join(' · ');
    return h('span', { class: cls, text: `⚙ ${t}`, title: tip });
  }
  const brBar = (pct) => h('span', { class: 'br-bar' }, h('i', { style: { width: `${Math.max(0, Math.min(100, Math.round(pct)))}%` } }));
  const brTokEl = (tokens, usd) => h('span', { class: 'br-tok', text: brTok(tokens, usd) });
  const frame = (title, note, ...kids) => h('section', { class: 'br-fr' }, h('h2', { class: 'br-frt' }, h('span', { text: title }), note ? h('span', { class: 'br-frn', text: note }) : null), kids);
  const empty = (text) => h('div', { class: 'br-empty', text });
  /** A node's name: a job's own label (its role when it has none); a session's own label, else its project and start time. */
  const nodeName = (n) => (n.kind === 'job' ? n.job || n.role || 'job' : n.task || `${n.project} · ${hhmm(n.started)}`);
  /** The kind of Claude Code instance, when it is not a terminal: headless, desktop or ide. */
  const brEntry = (n) => (n.entry && n.entry !== 'cli' ? h('span', { class: 'br-hl', text: n.entry }) : null);
  // background work still out: the program and the script it runs, file names only, and how long it has run
  const bgText = (x) => [x.prog || x.tool, x.script].filter(Boolean).join(' · ');
  const brSince = (ms) => brMin(Math.max(1, Math.round((Date.now() - ms) / 60000)));
  function brBgw(n) {
    const list = n.bgw || [];
    if (!list.length) return null;
    return h('div', { class: 'br-bgw' }, list.map((x) => h('div', { class: 'br-bgi s-run', title: `A background ${x.tool} call it started, still running since ${hhmm(x.since)}` },
      brG('run'), h('span', { class: 'br-nm', text: bgText(x) }), h('span', { class: 'br-eff', text: 'in background' }), h('span', { class: 'br-push br-min', text: brSince(x.since) }))));
  }
  /** Who works on a job: its one role, or how many helpers. */
  const jobWho = (j) => (j.n > 1 ? plural(j.n, 'helper') : j.role || 'helper');
  /** A job's helpers as small rows inside its card: sign, model, step. One helper whose step is the job's name has no row. */
  function brJobRows(j) {
    const hs = j.helpers || [];
    if (!(hs.length > 1 || (hs[0] && hs[0].step.toLowerCase() !== nodeName(j).toLowerCase()))) return null;
    const show = hs.slice(0, 5), more = (j.n || hs.length) - show.length;
    return h('div', { class: 'br-jh' }, show.map((x) => h('div', { class: `br-jr s-${x.st}`, title: `${x.step} · ${x.role}: ${BR[x.st][1]}` },
      brG(x.st), brChip(x.model), h('span', { class: 'br-nm', text: x.step }), h('span', { class: 'br-push br-eff', text: x.role }))),
      more > 0 ? h('div', { class: 'br-more', text: `+${plural(more, 'more helper')}` }) : null);
  }
  /** The lead line of a session that drives jobs: how many run and how many are done. */
  const leadText = (n) => (n.jobs && n.jobs.n ? `lead · ${n.needs ? `${n.needs} needs you · ` : ''}${n.jobs.run} running · ${n.jobs.done} done` : '');
  /** A job's outputs as buttons: each opens what the lead registered, on this computer (the page never sees where it is). */
  async function brOpen(j, i) {
    const o = j.outputs[i];
    const r = await post(`/api/jobs/${j.id}/open`, { output: i });
    feedback('br', r.ok ? `Opened ${o.label || o.kind} (${o.kind})` : `Not opened: ${r.error || 'failed'}`, !r.ok);
    if (!r.ok) load('brain');
  }
  function brOutputs(j, cls = 'br-outs') {
    const list = j.outputs || [];
    if (!list.length) return null;
    const ready = j.st === 'done';
    return h('div', { class: cls }, list.map((o, i) => h('button', { class: `br-btn br-open${ready ? ' go' : ''}`, type: 'button',
      title: `Open ${o.label || 'the output'} (${o.kind}) on this computer${ready ? '' : ': the job is still going, so it may be partial'}`, onclick: brStop(() => brOpen(j, i)) },
    h('span', { text: '↗ Open output' }), o.label ? h('span', { class: 'br-ol', text: o.label }) : null, h('span', { class: 'br-ok', text: o.kind }))));
  }
  async function brHandled(j) {
    const r = await post(`/api/jobs/${j.id}/handled`, {});
    await load('brain');
    feedback('br', r.ok ? `✓ ${nodeName(j)}: handled` : `Not saved: ${r.error || 'failed'}`, !r.ok);
  }

  // ---------------------------------------------------------------- header
  function header() {
    const fams = new Set();
    for (const n of (data.brain && data.brain.nodes) || []) { if (n.model) fams.add(n.model); for (const x of n.helpers || []) if (x.model) fams.add(x.model); }
    const asOf = (data.brain && data.brain.pricesAsOf) || 'unknown';
    const sw = h('div', { class: 'br-sw', role: 'group', 'aria-label': 'Show tokens or dollars' },
      h('button', { class: money === 'tokens' ? 'on' : null, type: 'button', 'aria-pressed': money === 'tokens' ? 'true' : 'false', onclick: () => setMoney('tokens') }, 'Tokens'),
      h('button', { class: money === 'usd' ? 'on' : null, type: 'button', 'aria-pressed': money === 'usd' ? 'true' : 'false', title: `List price estimate, prices as of ${asOf}. Not your bill.`, onclick: () => setMoney('usd') }, '$'));
    return h('header', { class: 'br-top' },
      h('h1', {}, h('b', { text: '//', 'aria-hidden': 'true' }), 'Threads'),
      h('nav', { class: 'br-tabs', 'aria-label': 'Tabs' }, VIEWS.map(([k, label]) => h('button', { class: ui.view === k ? 'on' : null, type: 'button', 'aria-current': ui.view === k ? 'page' : null, onclick: () => go(k) }, label))),
      ui.view === 'brain' ? h('div', { class: 'br-seg br-lay', role: 'group', 'aria-label': 'Brain layout' }, LAYOUTS.map(([k, label]) => h('button', { class: ui.brLayout === k ? 'on' : null, type: 'button',
        'aria-pressed': ui.brLayout === k ? 'true' : 'false', title: k === 'tree' ? 'You, your projects and their sessions as a tree' : 'Today on one clock: one lane per session', onclick: () => setLayout(k) }, label))) : null,
      h('div', { class: 'br-key', 'aria-label': 'Models' }, FAM_ORDER.filter((m) => fams.has(m)).map((m) => h('span', {}, brChip(m), FAM[m][1]))),
      sw);
  }
  function setMoney(m) { money = m; store.set(localStorage, 'threads-money', m); render(); }
  /** Tree or Timeline: the same data, the picked session stays picked. */
  function setLayout(l) {
    if (ui.brLayout === l) return;
    ui.brLayout = l; ui.brFocus = !!ui.brSel;
    store.set(localStorage, 'threads-layout', l);
    if (hashParts()[1]) { try { history.replaceState(null, '', `#brain/${l}`); } catch { /* the hash stays */ } }
    render();
  }
  function go(k) { if (location.hash !== `#${k}`) location.hash = k; else setView(k); }
  function setView(k) {
    ui.view = k;
    if (k === 'brain') ui.brLayout = layoutOf();
    if (k !== 'brain') load(k);
    render();
  }
  window.addEventListener('hashchange', () => setView(viewOfHash()));

  // ---------------------------------------------------------------- Brain
  async function brGotIt(n) {
    const r = await post('/api/seen', { id: n.id, name: nodeName(n).slice(0, 40) });
    if (r.ok && ui.brSel === n.id) ui.brSel = null;
    await load('brain');
    feedback('br', r.ok ? `✓ ${nodeName(n)}: done` : `Not saved: ${r.error || 'failed'}`, !r.ok);
  }
  const brStop = (fn) => (e) => { e.stopPropagation(); fn(); };
  function brActs(n, cls = 'br-acts') {
    if (n.kind === 'job' && n.needs) return h('div', { class: cls }, h('button', { class: 'br-btn br-need-ok', type: 'button', title: 'You have dealt with it: the card goes back to its own state', onclick: brStop(() => brHandled(n)) }, "Done, I've handled it"));
    if (n.st !== 'idle' && !(n.kind === 'job' && n.st === 'done')) return null;
    return h('div', { class: cls }, h('button', { class: 'br-btn ok', type: 'button', title: n.st === 'done' ? 'Checked: it leaves the tree and counts in done this week' : 'Seen: it leaves the tree and counts in done this week', onclick: brStop(() => brGotIt(n)) }, 'Got it'));
  }
  const brSelect = (id) => { ui.brSel = ui.brSel === id ? null : id; ui.brFocus = !!ui.brSel; render(); };

  function brNode(n) {
    const sel = ui.brSel === n.id;
    const l1 = h('div', { class: 'br-l1' }, brG(n.st), h('span', { class: 'br-nm', text: nodeName(n) }), brEntry(n), brTag(n.st, n));
    const lead = leadText(n);
    const l2 = h('div', { class: 'br-l2' }, brChip(n.model), h('span', { class: 'br-eff', text: n.effort || '' }),
      lead ? h('span', { class: 'br-lead', text: lead, title: `It drives ${plural(n.jobs.n, 'job')}: each has its own card under it` }) : null,
      h('span', { class: 'br-push br-tok', text: brTok(n.tokens, n.usd, true) }), h('span', { class: 'br-min', text: brMin(n.min) }), n.back ? h('span', { class: 'br-back', text: '↩ back from park' }) : null);
    return h('div', { class: `br-n br-c s-${n.st}${sel ? ' sel' : ''}`, 'data-id': n.id, tabindex: '0', role: 'button', 'aria-pressed': sel ? 'true' : 'false',
      'aria-label': `${nodeName(n)}: ${BR[n.st][1]}${n.waitJob ? ', waiting on a job' : ''}${brToolText(n) ? `. Using ${brToolText(n)}` : ''}`,
      onclick: () => brSelect(n.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); brSelect(n.id); } } }, l1, l2, brTool(n), brBgw(n), brActs(n));
  }
  /** A job card: the helpers of one session that share a job name, as one branch under it. Pressing it opens what it did. */
  function brJob(j) {
    const sel = ui.brSel === j.id;
    const l1 = h('div', { class: 'br-l1' }, brG(j.st), h('span', { class: 'br-nm', text: nodeName(j) }), brTag(j.st, j));
    const l2 = h('div', { class: 'br-l2' }, brChip(j.model), h('span', { text: jobWho(j) }), j.n > 1 ? h('span', { class: 'br-eff', text: `${j.nDone}/${j.n} done` }) : h('span', { class: 'br-eff', text: j.effort || '' }),
      h('span', { class: 'br-push br-tok', text: brTok(j.tokens, j.usd, true) }), h('span', { class: 'br-min', text: brMin(j.min) }), j.back ? h('span', { class: 'br-back', text: '↩ back from park' }) : null);
    return h('div', { class: `br-n br-c br-job s-${j.st}${sel ? ' sel' : ''}`, 'data-id': j.id, tabindex: '0', role: 'button', 'aria-pressed': sel ? 'true' : 'false',
      'aria-label': `Job ${nodeName(j)} (${jobWho(j)}): ${j.needs ? `needs you: ${j.needs}` : BR[j.st][1]}${j.hasOutput ? `, ${plural(j.outputs.length, 'output')} to open` : ''}${j.outcome ? `. Outcome: ${j.outcome}` : ''}${(j.bgw || []).length ? `, background ${bgText(j.bgw[0])} running` : ''}. Press for what it did`,
      onclick: () => brSelect(j.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); brSelect(j.id); } } }, l1, l2,
      j.needs ? h('div', { class: 'br-need', text: `! ${j.needs}`, title: `Needs you: ${j.needs}` }) : null,
      j.outcome ? h('div', { class: 'br-out', text: `→ ${j.outcome}`, title: `Outcome: ${j.outcome}` }) : null, brOutputs(j), brJobRows(j), brTool(j), brBgw(j), brActs(j));
  }
  /** A project's name; a click renames it (kept in the local config.json). */
  function brProjName(p) {
    if (ui.brRename === p.key) {
      const inp = h('input', { class: 'br-rename', type: 'text', value: ui.brRenameText != null ? ui.brRenameText : p.label, maxlength: '40', 'aria-label': `A name for the project ${p.base}`,
        title: 'Enter saves, Esc cancels; empty goes back to the folder name', oninput: () => { ui.brRenameText = inp.value; },
        onclick: (e) => e.stopPropagation(), onkeydown: (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); brRename(p, inp.value); } else if (e.key === 'Escape') { ui.brRename = null; ui.brRenameText = null; render(); }
        } });
      return inp;
    }
    const open = () => { ui.brRename = p.key; ui.brRenameText = null; render(); };
    return h('b', { class: 'br-pname', text: p.label, role: 'button', tabindex: '0', title: `${p.label}${p.base && p.base !== p.label ? ` (folder ${p.base})` : ''}: click to rename`,
      onclick: brStop(open), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } } });
  }
  async function brRename(p, name) {
    const r = await post('/api/name', { label: p.base, name: name.trim() });
    ui.brRename = null; ui.brRenameText = null;
    await load('brain');
    feedback('br', r.ok ? `${p.base} shows as ${r.name}` : `Not saved: ${r.error || 'failed'}`, !r.ok);
  }
  const WIRE = { run: 'live', await: 'await', wait: 'wait', idle: 'idle', done: 'done' };

  /** The tree: you on top, one branch per project, its sessions under it, and each session's jobs side by side as its branches. */
  function brTree(B) {
    const edges = [];
    const you = h('div', { class: `br-n br-root s-${B.you.st}`, 'data-id': 'you' },
      h('div', { class: 'br-l1' }, brG(B.you.st), h('span', { class: 'br-nm', text: 'YOU' }), brTag(B.you.st)),
      h('div', { class: 'br-l2' }, h('span', { text: `${plural(B.you.sessions, 'session')} · ${B.you.running} running${B.you.jobs ? ` · ${plural(B.you.jobs, 'job')}` : ''}` })));
    const cols = B.projects.map((p) => {
      edges.push(['you', p.key, WIRE[p.st], NARROW.matches ? 'side' : null]);
      const nodes = B.nodes.filter((n) => n.parent === p.key);
      const items = nodes.map((n) => {
        edges.push([p.key, n.id, WIRE[n.st], 'side']);
        const kids = (B.jobs || []).filter((j) => j.parent === n.id).map((j) => { edges.push([n.id, j.id, WIRE[j.st], 'drop']); return brJob(j); });
        return [brNode(n), kids.length ? h('div', { class: 'br-jobs' }, kids, n.jobMore ? h('div', { class: 'br-more', text: `+${plural(n.jobMore, 'more job')}` }) : null) : null];
      });
      return h('div', { class: 'br-pcol' },
        h('div', { class: `br-n br-mini br-proj s-${p.st}`, 'data-id': p.key, title: `${p.label}: ${plural(p.n, 'session')} and ${plural(p.jobs || 0, 'job')} on the tree` }, brG(p.st), brProjName(p),
          h('span', { class: 'br-eff', text: p.jobs ? `${plural(p.n, 'lead')} · ${plural(p.jobs, 'job')}` : plural(p.n, 'session') }),
          p.needs ? h('span', { class: 'br-st', text: `! ${p.needs} needs you` }) : null),
        h('div', { class: 'br-col' }, items, p.more ? h('div', { class: 'br-more', text: `+${p.more} older` }) : null));
    });
    const g = h('section', { class: 'br-graph br-tree', 'aria-label': 'You, your projects and their sessions' }, s('svg', { class: 'br-wires', 'aria-hidden': 'true' }),
      h('div', { class: 'br-row0' }, you), h('div', { class: 'br-row1' }, cols));
    g.brEdges = edges;
    return g;
  }

  /** Right-angle wires once laid out: an elbow from you to each project, a trunk down each column. */
  function brWires(scope) {
    const calm = still();
    const PR = { done: 0, idle: 1, wait: 2, await: 3, live: 4 };
    for (const g of scope.querySelectorAll('.br-graph')) {
      const svg = g.querySelector('.br-wires');
      if (!svg) continue;
      svg.replaceChildren();
      const G = g.getBoundingClientRect();
      if (!G.width) continue;
      const sc = G.width / (g.offsetWidth || G.width);
      const box = (e) => { const q = e.getBoundingClientRect(); return { left: (q.left - G.left) / sc, top: (q.top - G.top) / sc, right: (q.right - G.left) / sc, bottom: (q.bottom - G.top) / sc, width: q.width / sc, height: q.height / sc }; };
      const r = (n) => Math.round(n) + 0.5;
      for (const [a, b, k, where] of [...(g.brEdges || [])].sort((x, y) => PR[x[2]] - PR[y[2]])) {
        const A = g.querySelector(`[data-id="${CSS.escape(a)}"]`), B = g.querySelector(`[data-id="${CSS.escape(b)}"]`);
        if (!A || !B) continue;
        const ra = box(A), rb = box(B);
        let d, x1, y1, x2, y2;
        if (where === 'side') {
          x1 = r(ra.left + 12); y1 = ra.bottom; x2 = rb.left; y2 = r(rb.top + rb.height / 2);
          d = `M${x1},${y1} V${y2} H${x2}`;
        } else if (where === 'drop') {
          // a branch: down the parent's left edge, across the gap above the row, then down into the card's top
          x1 = r(ra.left + 12); y1 = ra.bottom; x2 = r(rb.left + 14); y2 = rb.top;
          const by = r(y2 - 11);
          d = `M${x1},${y1} V${by} H${x2} V${y2}`;
        } else {
          x1 = r(ra.left + ra.width / 2); y1 = ra.bottom; x2 = r(rb.left + rb.width / 2); y2 = rb.top;
          const by = r(y2 - Math.min(20, (y2 - y1) / 2));
          d = `M${x1},${y1} V${by} H${x2} V${y2}`;
        }
        s('path', { class: `br-w ${k}`, d, 'data-a': a, 'data-b': b }, svg);
        s('circle', { class: `br-port ${k}`, cx: x1, cy: y1, r: '2.6', 'data-a': a, 'data-b': b }, svg);
        s('circle', { class: `br-port ${k}`, cx: x2, cy: y2, r: '2.6', 'data-a': a, 'data-b': b }, svg);
        if (k === 'live' && !calm) {
          const len = Math.abs(y2 - y1) + Math.abs(x2 - x1), dur = Math.max(1.1, len / 75);
          for (let j = 0; j < 2; j++) s('animateMotion', { dur: `${dur.toFixed(2)}s`, begin: `-${(dur * (0.3 + j * 0.5)).toFixed(2)}s`, repeatCount: 'indefinite', path: d }, s('circle', { class: 'br-dot', r: '2.6' }, svg));
        }
      }
    }
  }
  /** Hovering a node lights its own wires, up to you and down to what hangs under it, and dims the rest. */
  function brHoverWires(scope) {
    for (const g of scope.querySelectorAll('.br-graph')) {
      const svg = g.querySelector('.br-wires');
      const edges = g.brEdges || [];
      for (const n of g.querySelectorAll('.br-n[data-id]')) {
        const id = n.dataset.id;
        const on = () => {
          const lit = new Set();
          for (let cur = id, k = 0; cur && k < 10; k++) { const e = edges.find((x) => x[1] === cur); if (!e) break; lit.add(`${e[0]}>${e[1]}`); cur = e[0]; }
          const down = [id];
          while (down.length) { const p = down.pop(); for (const e of edges) if (e[0] === p && !lit.has(`${e[0]}>${e[1]}`)) { lit.add(`${e[0]}>${e[1]}`); down.push(e[1]); } }
          svg.classList.add('hov');
          for (const el of svg.querySelectorAll('[data-a]')) el.classList.toggle('hi', lit.has(`${el.dataset.a}>${el.dataset.b}`));
        };
        const off = () => { svg.classList.remove('hov'); for (const el of svg.querySelectorAll('.hi')) el.classList.remove('hi'); };
        n.addEventListener('mouseenter', on);
        n.addEventListener('mouseleave', off);
      }
    }
  }

  function brAgo(n) {
    if (!n.at) return '';
    if (n.st === 'run') return `last write ${agoText(Math.max(0, Math.round((Date.now() - n.at) / 1000)))}`;
    if (n.st === 'await') return `asked ${when(n.at)}`;
    if (n.st === 'wait') return `waiting since ${when(n.at)}`;
    if (n.st === 'done') return `finished ${when(n.at)}`;
    return `stopped ${when(n.at)}`;
  }
  const nextSaturday = () => { const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); return dayOf(d.getTime()); };
  async function brParkPost(body, label) {
    const r = await post('/api/park', body);
    if (r.ok && !body.unpark && ui.brSel === body.id) ui.brSel = null;
    await load('brain');
    feedback('br', r.ok ? label : `Not saved: ${r.error || 'failed'}`, !r.ok);
  }
  function brParkCtl(n) {
    if (n.needs) return null; // a job that needs you stays on the tree
    const date = h('input', { class: 'br-date', type: 'date', value: nextSaturday(), 'aria-label': 'Back on (optional)', title: 'Back on this day (optional)' });
    const name = nodeName(n).slice(0, 40);
    return h('span', { class: 'br-park' }, h('button', { class: 'br-btn', type: 'button', title: 'Off the tree until the date; it is not done',
      onclick: () => brParkPost({ id: n.id, name, until: date.value || '' }, `⏸ ${name}: parked${date.value ? ` until ${md(keyMs(date.value))}` : ''}`) }, '⏸ Park'), date);
  }
  /** The drawer: everything about the picked session, over the lower canvas; resizable from its top edge. */
  function brDrawer(n) {
    if (n.kind === 'job') return brJobDrawer(n);
    const st = n.st;
    const close = () => { ui.brSel = null; render(); };
    const head = h('header', { class: 'br-dhead' }, brG(st), h('span', { class: 'br-dm', text: n.project }), h('b', { class: 'br-dname', text: nodeName(n) }), brTag(st, n),
      brChip(n.model), h('span', { class: 'br-eff', text: n.effort || '' }),
      h('span', { class: 'br-dnum' }, brTokEl(n.tokens, n.usd), h('span', { class: 'br-min', text: brMin(n.min) })),
      h('button', { class: 'br-btn br-close', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, '×'));
    const ago = brAgo(n);
    const left = h('div', { class: 'br-dl' },
      h('div', { class: 'br-dm', text: `${n.entry && n.entry !== 'cli' ? n.entry : 'session'}${leadText(n) ? ` · ${leadText(n)}` : ''} · started ${when(n.started)}` }),
      brBgw(n),
      ago ? h('div', { class: `br-dm br-ago s-${st}`, text: ago }) : null,
      n.noHooks ? h('div', { class: 'br-dm', text: 'no status hooks: its state is read from its writes' }) : null,
      h('div', { class: 'br-foot' }, brActs(n, 'br-acts in'), brParkCtl(n)));
    const helpers = n.helpers || [];
    const rows = [{ st, m: n.model, who: 'session (own share)', eff: n.effort, t: n.own != null ? n.own : n.tokens, u: n.own != null ? n.ownUsd : n.usd, min: n.min, x: n },
      ...helpers.map((x) => ({ st: x.st, m: x.model, who: x.role, eff: x.effort, t: x.tokens, u: x.usd, min: x.min, x }))];
    const max = Math.max(1, ...rows.map((x) => x.t || 0));
    const table = h('div', { class: 'br-dtab', role: 'table', 'aria-label': 'Who worked on it' },
      h('div', { class: 'br-drow2 hd', role: 'row' }, ['', 'who', 'effort', money === 'tokens' ? 'tokens' : '$', '', 'time'].map((t) => h('span', { role: 'columnheader', text: t }))),
      rows.map((x) => h('div', { class: `br-drow2 s-${x.st}`, role: 'row' }, h('span', { class: 'br-g', text: BR[x.st] ? BR[x.st][0] : '–' }),
        h('span', { class: 'br-who' }, brChip(x.m), h('span', { text: x.who }), brTool(x.x, 'br-tl in')),
        h('span', { class: 'br-eff', text: x.eff || '' }), brTokEl(x.t, x.u), brBar((100 * (x.t || 0)) / max), h('span', { class: 'br-min', text: brMin(x.min) }))),
      n.helperMore ? h('div', { class: 'br-dm', text: `+${n.helperMore} more helpers` }) : null);
    const grip = h('div', { class: 'br-grip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Drag to resize the drawer', title: 'Drag to resize' });
    return h('section', { class: `br-drawer s-${st}`, 'aria-label': `${nodeName(n)}: ${BR[st][1]}` }, grip, head, h('div', { class: 'br-dbody' }, left, table));
  }
  const DID_K = { skill: 'skill', helper: '▸', mcp: 'mcp' };
  /** What a job did, as safe facts: names and counts only (never a prompt, a reply, a command or a path). */
  function brDid(j) {
    const D = j.did;
    if (!D || !D.total) return h('div', { class: 'br-dm', text: 'No tool calls yet.' });
    const fact = (num, label, cls) => h('span', { class: `br-fact${cls ? ` ${cls}` : ''}` }, h('b', { text: String(num) }), ` ${label}`);
    return h('div', { class: 'br-did' },
      h('div', { class: 'br-facts' }, fact(D.total, D.total === 1 ? 'call' : 'calls'), fact(D.files, D.files === 1 ? 'file written' : 'files written'),
        D.errors ? fact(D.errors, D.errors === 1 ? 'call failed' : 'calls failed', 'bad') : fact(0, 'calls failed')),
      h('div', { class: 'br-chips', 'aria-label': 'What it called, the most used first' }, D.calls.map((c) => h('span', { class: 'br-call', title: `${c.name} (${BR_TK[c.k] || 'tool'}): ${plural(c.n, 'call')}` },
        DID_K[c.k] ? h('i', { text: `${DID_K[c.k]} ` }) : null, c.name, h('b', { text: ` ${c.n}` })))),
      D.scripts.length ? h('div', { class: 'br-dm br-scripts', title: 'Script files its commands ran (file names only)' }, h('span', { class: 'br-eff', text: 'ran ' }), D.scripts.join(' · '), D.scriptMore ? ` · +${D.scriptMore} more` : '') : null);
  }
  /** The drawer of a job: its outcome line, what it did, its helpers, its background work, Got it and Park. */
  function brJobDrawer(j) {
    const st = j.st;
    const lead = (data.brain.nodes || []).find((n) => n.id === j.parent);
    const close = () => { ui.brSel = null; render(); };
    const head = h('header', { class: 'br-dhead' }, brG(st), h('span', { class: 'br-dm', text: j.project }), h('b', { class: 'br-dname', text: nodeName(j) }), brTag(st, j),
      brChip(j.model), h('span', { class: 'br-eff', text: j.effort || '' }),
      h('span', { class: 'br-dnum' }, brTokEl(j.tokens, j.usd), h('span', { class: 'br-min', text: brMin(j.min) })),
      h('button', { class: 'br-btn br-close', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, '×'));
    const ago = brAgo(j);
    const left = h('div', { class: 'br-dl' },
      j.needs ? h('div', { class: 'br-outcome br-need', title: 'The lead session needs you for this job' }, h('span', { class: 'br-eff', text: 'needs you ' }), j.needs) : null,
      brOutputs(j, 'br-outs in'),
      j.outcome ? h('div', { class: 'br-outcome', title: 'The outcome line the lead session wrote for this job' }, h('span', { class: 'br-eff', text: 'outcome ' }), j.outcome)
        : h('div', { class: 'br-dm', text: 'No outcome line yet: the lead can write one (hooks/README.md).' }),
      h('div', { class: 'br-dm', text: `job · ${jobWho(j)}${j.n > 1 ? ` · ${j.nDone} of ${j.n} done` : ''}${j.started ? ` · started ${when(j.started)}` : ''}` }),
      ago ? h('div', { class: `br-dm br-ago s-${st}`, text: ago }) : null,
      h('h3', { class: 'br-dh3', text: 'What it did' }), brDid(j), brTool(j), brBgw(j),
      lead ? h('button', { class: 'br-btn br-lead', type: 'button', title: 'Open the session that drives it', onclick: () => brSelect(lead.id) }, `driven by ${nodeName(lead)}`) : null,
      h('div', { class: 'br-foot' }, brActs(j, 'br-acts in'), brParkCtl(j)));
    const rows = j.helpers || [];
    const max = Math.max(1, ...rows.map((x) => x.tokens || 0));
    const table = h('div', { class: 'br-dtab', role: 'table', 'aria-label': 'The helpers on this job' },
      h('div', { class: 'br-drow2 hd', role: 'row' }, ['', 'helper · step', 'effort', money === 'tokens' ? 'tokens' : '$', '', 'time'].map((x) => h('span', { role: 'columnheader', text: x }))),
      rows.map((x) => h('div', { class: `br-drow2 s-${x.st}`, role: 'row', title: `${BR[x.st][1]} · ${plural(x.calls, 'call')} · ${plural(x.files, 'file')} written${x.errors ? ` · ${x.errors} failed` : ''}` },
        h('span', { class: 'br-g', text: BR[x.st][0] }),
        h('span', { class: 'br-who' }, brChip(x.model), h('span', { text: x.role }), h('span', { class: 'br-step', text: x.step }), brTool(x, 'br-tl in')),
        h('span', { class: 'br-eff', text: x.effort || '' }), brTokEl(x.tokens, x.usd), brBar((100 * (x.tokens || 0)) / max), h('span', { class: 'br-min', text: brMin(x.min) }))),
      j.helperMore ? h('div', { class: 'br-dm', text: `+${j.helperMore} more helpers` }) : null);
    const grip = h('div', { class: 'br-grip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Drag to resize the drawer', title: 'Drag to resize' });
    return h('section', { class: `br-drawer s-${st}`, 'aria-label': `${nodeName(j)}: ${BR[st][1]}` }, grip, head, h('div', { class: 'br-dbody' }, left, table));
  }
  let drawerH = Number(store.get(sessionStorage, 'threads-drawer')) || null;
  function brDrawerSize() {
    const cv = document.querySelector('.br-canvas, .tl-box'), d = document.querySelector('.br-drawer');
    const tl = !!cv && cv.classList.contains('tl-box');
    if (tl && !d) cv.style.setProperty('padding-bottom', '0px');
    if (!cv || !d) return;
    const H = cv.clientHeight;
    const hb = cv.querySelector('.br-helpers');
    const top = hb ? hb.offsetTop + hb.offsetHeight + 12 : 60;
    d.style.setProperty('height', `${Math.max(140, Math.min(H - top, drawerH || Math.round(H * 0.4)))}px`);
    if (tl) cv.style.setProperty('padding-bottom', `${d.offsetHeight + 12}px`);
  }
  function brDrawerGrip() {
    const d = document.querySelector('.br-drawer'), g = d && d.querySelector('.br-grip');
    if (!g) return;
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const y0 = e.clientY, h0 = d.offsetHeight;
      try { g.setPointerCapture(e.pointerId); } catch { /* fine */ }
      const move = (ev) => { drawerH = Math.max(140, h0 + (y0 - ev.clientY)); brDrawerSize(); };
      const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); store.set(sessionStorage, 'threads-drawer', String(drawerH)); };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.view === 'brain' && ui.brSel) { ui.brSel = null; render(); } });

  /** The strip, which is also the legend: sign, colour, word, count; today against a usual day; done this week. */
  function brStrip(B) {
    const C = B.counts;
    const cell = (st, num, label) => h('div', { class: `br-cell s-${st}` }, brG(st), h('span', { class: 'br-n1', text: String(num) }), h('span', { class: 'br-l', text: label }));
    const S = B.spend;
    const tok = money === 'tokens';
    const today = S ? (tok ? S.tokens : S.usd) || 0 : 0;
    const usual = S && S.usual ? (tok ? S.usual.tokens : S.usual.usd) : null;
    const max = Math.max(today, usual || 0, 1e-9);
    const pct = (v) => `${Math.round((100 * v) / max)}%`;
    const ratio = usual ? today / usual : null;
    const rTxt = !S ? '' : ratio == null ? '– no usual day yet' : ratio >= 1.05 ? `▲ ${ratio.toFixed(1)}×` : ratio <= 0.95 ? `▼ ${ratio.toFixed(1)}×` : '≈ usual';
    const spend = h('div', { class: 'br-cell br-today', title: S ? `Every session's ${tok ? 'tokens' : 'list price estimate'} today${usual ? `, against a usual day (${brTok(S.usual.tokens, S.usual.usd)})` : ''}` : 'Reading the session files…' },
      h('span', { class: 'br-tok br-big', text: S ? brTok(S.tokens, S.usd) : '–' }), h('span', { class: 'br-l', text: 'today' }),
      S ? h('span', { class: 'br-bullet', role: 'img', 'aria-label': `Today ${brTok(S.tokens, S.usd)}${usual ? `; a usual day is ${brTok(S.usual.tokens, S.usual.usd)}` : ''}` },
        h('i', { style: { width: pct(today) } }), usual ? h('i', { class: 'base', style: { width: pct(Math.min(today, usual)) } }) : null, usual ? h('u', { style: { left: pct(usual) } }) : null) : null,
      h('span', { class: 'br-ratio', text: rTxt }));
    const done = h('button', { class: `br-cell s-done br-donec${ui.brDone ? ' on' : ''}`, type: 'button', 'aria-expanded': ui.brDone ? 'true' : 'false', title: 'Done since Monday 00:00: click for the list',
      onclick: () => { ui.brDone = !ui.brDone; render(); } }, brG('done'), h('span', { class: 'br-n1', text: String(C.done) }), h('span', { class: 'br-l', text: 'done this week' }));
    return h('section', { class: 'br-strip', 'aria-label': 'The five states' }, cell('await', C.await, 'awaiting you'), cell('idle', C.idle, 'idle'), cell('run', C.run, 'running'), cell('wait', C.wait, 'waiting'), spend, C.check ? cell('done', C.check, 'done · to check') : null,
      C.look ? h('div', { class: 'br-cell s-done br-look', title: 'Finished jobs with an output to open' }, h('span', { class: 'br-g', text: '↗', 'aria-hidden': 'true' }), h('span', { class: 'br-n1', text: String(C.look) }), h('span', { class: 'br-l', text: 'to look at' })) : null, done,
      B.parked.length ? h('button', { class: `br-cell br-parkc${ui.brParkOpen ? ' on' : ''}`, type: 'button', 'aria-expanded': ui.brParkOpen ? 'true' : 'false', title: 'Parked: off the tree until their date', onclick: () => { ui.brParkOpen = !ui.brParkOpen; render(); } },
        h('span', { class: 'br-g', text: '⏸', 'aria-hidden': 'true' }), h('span', { class: 'br-l', text: `parked ${B.parked.length}` })) : null);
  }
  function brDoneList(B) {
    return h('section', { class: 'br-done', 'aria-label': 'Done this week' },
      B.done.length ? B.done.map((x) => h('div', { class: 'br-drow' }, h('span', { class: 'br-g s-done', text: '✓', 'aria-hidden': 'true' }), h('span', { class: 'br-dn' }, x.name, x.outcome ? h('span', { class: 'br-eff', text: ` → ${x.outcome}` }) : null), h('span', { class: 'br-dw', text: when(x.at) })))
        : h('div', { class: 'br-dm', text: 'Nothing done since Monday yet.' }));
  }
  function brParkList(B) {
    return h('section', { class: 'br-done', 'aria-label': 'Parked' }, B.parked.map((x) => h('div', { class: 'br-drow br-prow3' }, h('span', { class: 'br-g', text: '⏸', 'aria-hidden': 'true' }),
      h('span', { class: 'br-dn', text: x.name }), h('span', { class: 'br-dw', text: x.until ? `back ${md(keyMs(x.until))}` : 'no date' }),
      h('button', { class: 'br-btn', type: 'button', onclick: () => brParkPost({ id: x.id, unpark: true }, `${x.name}: back on the tree`) }, 'Unpark'))));
  }

  // ---- the canvas: pan, zoom, fit; the view is kept for the visit
  const KMIN = 0.15, KMAX = 2.5, VIEW_KEY = 'threads-view';
  let view = null;
  try { const v = JSON.parse(store.get(sessionStorage, VIEW_KEY) || 'null'); if (v && [v.k, v.tx, v.ty].every(Number.isFinite)) view = v; } catch { /* fit */ }
  const saveView = () => store.set(sessionStorage, VIEW_KEY, JSON.stringify(view));
  function applyView() {
    const cv = document.querySelector('.br-canvas'), w = cv && cv.querySelector('.br-world');
    if (!w || !view) return;
    w.style.setProperty('transform', `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`);
    const g = 24 * view.k;
    cv.style.setProperty('background-size', `${g}px ${g}px`);
    cv.style.setProperty('background-position', `${view.tx % g}px ${view.ty % g}px`);
  }
  function fit() {
    const cv = document.querySelector('.br-canvas'), w = cv && cv.querySelector('.br-world');
    if (!w) return;
    const hb = cv.querySelector('.br-helpers'), rw = hb ? hb.offsetWidth + 20 : 0;
    const dr = document.querySelector('.br-drawer');
    const bw = w.offsetWidth || 1, bh = w.offsetHeight || 1;
    if (NARROW.matches) {
      // narrow: fit the width only and start at the top, under the zoom buttons and the helpers box; scroll by dragging
      const m = 8, top = hb ? hb.offsetTop + hb.offsetHeight + 12 : 52;
      const k = Math.max(KMIN, Math.min(1, (cv.clientWidth - 2 * m) / bw));
      view = { k, tx: Math.max(m, (cv.clientWidth - bw * k) / 2), ty: top };
    } else {
      const W = cv.clientWidth - rw, H = cv.clientHeight - (dr ? dr.offsetHeight : 0), m = 24;
      const k = Math.max(KMIN, Math.min(1, (W - 2 * m) / bw, (H - 2 * m) / bh));
      view = { k, tx: Math.max(m, (W - bw * k) / 2), ty: m + Math.max(0, (H - 2 * m - bh * k) / 2) };
    }
    applyView(); saveView();
  }
  function zoom(f, px, py) {
    const cv = document.querySelector('.br-canvas');
    if (!cv || !view) return;
    if (px == null) { px = cv.clientWidth / 2; py = cv.clientHeight / 2; }
    const k = Math.min(KMAX, Math.max(KMIN, view.k * f));
    view = { k, tx: px - ((px - view.tx) * k) / view.k, ty: py - ((py - view.ty) * k) / view.k };
    applyView(); saveView();
  }
  const pan = (dx, dy) => { if (!view) return; view = { ...view, tx: view.tx + dx, ty: view.ty + dy }; applyView(); saveView(); };
  function showNode(id) {
    const cv = document.querySelector('.br-canvas'), n = id && cv && cv.querySelector(`.br-tree [data-id="${CSS.escape(id)}"]`);
    if (!n || !view) return;
    const d = document.querySelector('.br-drawer');
    const C = cv.getBoundingClientRect(), r = n.getBoundingClientRect();
    const limit = C.bottom - (d ? d.offsetHeight : 0) - 16;
    if (r.bottom > limit) pan(0, limit - r.bottom); else if (r.top < C.top + 16) pan(0, C.top + 16 - r.top);
  }
  function canvasSize() {
    const cv = document.querySelector('.br-canvas, .tl-box');
    if (!cv) return;
    const top = cv.getBoundingClientRect().top + window.scrollY;
    cv.style.setProperty('height', `${Math.max(360, window.innerHeight - top - 12)}px`);
  }
  const NOPAN = 'button, input, a, [role="button"], .br-helpers, .br-drawer';
  function helpersBox(B) {
    const running = {};
    for (const n of B.nodes) for (const x of n.helpers || []) if (x.st === 'run') running[x.role] = (running[x.role] || 0) + 1;
    const rows = B.team.slice(0, 12).map((t) => [t.name, t.model, t.effort]);
    for (const role of Object.keys(running)) if (!rows.some((r) => r[0] === role)) rows.push([role, null, 'no file']);
    const open = ui.brHelpOpen;
    return h('section', { class: 'br-helpers', 'aria-label': 'Helpers' },
      h('button', { class: 'br-hh', type: 'button', 'aria-expanded': open ? 'true' : 'false', onclick: () => { ui.brHelpOpen = !open; render(); } }, 'Helpers', h('span', { 'aria-hidden': 'true', text: open ? '▾' : '▸' })),
      open ? h('div', { class: 'br-hlist' }, rows.length ? rows.map(([name, model, effort]) => h('div', { class: 'br-hrow' }, brChip(model), h('b', { text: name }), h('span', { class: 'br-eff', text: effort || '' }),
        running[name] ? h('span', { class: 'br-hn', text: `● ${running[name]}`, title: `${running[name]} running now` }) : h('span', {}))) : h('div', { class: 'br-dm', text: 'No helper files yet.' })) : null);
  }
  function canvas(kids, fixed) {
    const world = h('div', { class: 'br-world' }, kids);
    if (view) world.style.setProperty('transform', `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`);
    const btn = (label, title, fn) => h('button', { class: 'br-btn', type: 'button', title, 'aria-label': title, onclick: fn }, label);
    const cv = h('section', { class: 'br-canvas', tabindex: '0', 'aria-label': 'The tree: drag to pan, wheel or pinch to zoom; arrows pan, + and - zoom, 0 fits' }, world,
      h('div', { class: 'br-zoom', role: 'group', 'aria-label': 'Zoom' }, btn('+', 'Zoom in', () => zoom(1.2)), btn('−', 'Zoom out', () => zoom(1 / 1.2)), btn('fit', 'Fit the whole tree', fit)), fixed);
    const pts = new Map();
    let drag = null, pinch = null, suppress = false;
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest(NOPAN)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch { /* fine */ }
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; drag = null; }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const r = cv.getBoundingClientRect();
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        pan(mx - pinch.mx, my - pinch.my); zoom(d / pinch.d, mx - r.left, my - r.top);
        pinch = { d, mx, my }; suppress = true;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; suppress = true; ui.dragging = true;
      cv.classList.add('dragging');
      pan(dx, dy);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!pts.size) { drag = null; cv.classList.remove('dragging'); ui.dragging = false; if (ui.pending) { ui.pending = false; render(); } }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('click', (e) => { if (suppress) { suppress = false; e.stopPropagation(); e.preventDefault(); } }, true);
    cv.addEventListener('click', (e) => { if (ui.brSel && !e.target.closest('.br-n, .br-zoom, .br-helpers, .br-drawer')) { ui.brSel = null; render(); } });
    cv.addEventListener('dblclick', (e) => { if (!e.target.closest(NOPAN)) fit(); });
    cv.addEventListener('keydown', (e) => {
      if (e.target !== cv || e.ctrlKey || e.metaKey || e.altKey) return;
      const step = 60;
      const act = { ArrowLeft: () => pan(step, 0), ArrowRight: () => pan(-step, 0), ArrowUp: () => pan(0, step), ArrowDown: () => pan(0, -step),
        '+': () => zoom(1.2), '=': () => zoom(1.2), '-': () => zoom(1 / 1.2), _: () => zoom(1 / 1.2), 0: () => fit() }[e.key];
      if (act) { e.preventDefault(); act(); }
    });
    return cv;
  }
  function canvasInit() {
    const cv = document.querySelector('.br-canvas');
    if (!cv) return;
    canvasSize();
    brDrawerSize(); brDrawerGrip();
    if (!view) fit(); else applyView();
    if (ui.brFocus) { showNode(ui.brSel); ui.brFocus = false; }
    requestAnimationFrame(() => { brWires(cv); brHoverWires(cv); });
  }
  // crossing the narrow line changes the tree's shape: draw it again and fit it
  if (NARROW.addEventListener) NARROW.addEventListener('change', () => { view = null; ui.brHelpOpen = !NARROW.matches; if (ui.view === 'brain') render(); });
  window.addEventListener('resize', () => { if (ui.view === 'brain') { canvasSize(); brDrawerSize(); brWires(document); } });

  // ---- the Timeline layout: today on one clock, a lane per session, its helpers under it (as in a trace viewer)
  const TL_HELPERS = 24;
  let tlScroll = Number(store.get(sessionStorage, 'threads-tl-scroll')) || 0;
  function brTimeline(B) {
    const T = B.today || { rows: [], from: Date.now(), to: Date.now() };
    const byId = new Map(B.nodes.map((n) => [n.id, n]));
    const jobById = new Map((B.jobs || []).map((j) => [j.id, j]));
    const stText = (st, n) => `${BR[st][0]} ${tagOf(st, n)}${n && (n.bgw || []).length ? ` · bg ${bgText(n.bgw[0])}` : ''}`;
    const rows = T.rows.map((r) => ({ p: B.projects.find((p) => p.key === r.key), lanes: r.lanes.filter((l) => byId.has(l.id)) })).filter((r) => r.p && r.lanes.length);
    const box = (kids) => h('section', { class: 'tl-box', tabindex: '0', 'aria-label': 'Today on one clock: one lane per session, its busy stretches as bars',
      onclick: (e) => { if (ui.brSel && !e.target.closest('.tl-lane, .br-drawer')) { ui.brSel = null; render(); } } }, kids);
    if (!rows.length) return box(empty(B.nodes.length ? 'No session on the tree has run today yet.' : 'Nothing ran today yet.'));
    const first = Math.min(...rows.flatMap((r) => r.lanes.flatMap((l) => l.spans.map((x) => x[0]))));
    const a = new Date(first); a.setMinutes(0, 0, 0);
    const from = a.getTime(), now = T.to, to = Math.max(now, from + 3600000), span = to - from;
    const pct = (t) => `${(100 * (t - from)) / span}%`;
    const step = span > 12 * 3600000 ? 3 : span > 6 * 3600000 ? 2 : 1;
    const ticks = [];
    for (let t = from; t <= to; t += step * 3600000) ticks.push(t);
    const bars = (spans) => spans.map(([p, q]) => h('i', { class: 'tl-bar', title: p === q ? hhmm(p) : `${hhmm(p)} to ${hhmm(q)}`, style: { left: pct(p), width: `${Math.max(0, (100 * (q - p)) / span)}%` } }));
    const track = (spans) => h('div', { class: 'tl-track' }, bars(spans));
    const pick = (id) => ({ onclick: () => brSelect(id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); brSelect(id); } } });
    const lane = (n, L) => {
      const sel = ui.brSel === n.id;
      const more = L.helpers.length - TL_HELPERS;
      return h('div', { class: `tl-sess${sel ? ' sel' : ''}`, 'data-id': n.id },
        h('div', { class: `tl-lane s-${n.st}`, role: 'button', tabindex: '0', 'aria-pressed': sel ? 'true' : 'false',
          'aria-label': `${nodeName(n)}: ${BR[n.st][1]}${n.waitJob ? ', waiting on a job' : ''}. Busy ${L.spans.length} ${L.spans.length === 1 ? 'stretch' : 'stretches'} today, from ${hhmm(L.spans[0][0])}`, ...pick(n.id) },
          h('span', { class: 'tl-name' }, brG(n.st), brChip(n.model), h('span', { class: 'br-nm', text: nodeName(n) }), brEntry(n), n.jobs && n.jobs.n ? h('span', { class: 'br-hl', text: 'lead', title: leadText(n) }) : null),
          track(L.spans), h('span', { class: 'br-st', text: stText(n.st, n), title: leadText(n) || null })),
        L.helpers.filter((x) => jobById.has(x.id)).slice(0, TL_HELPERS).map((x) => {
          const j = jobById.get(x.id), jsel = ui.brSel === j.id;
          return h('div', { class: `tl-lane tl-help s-${j.st}${jsel ? ' sel' : ''}`, 'data-id': j.id, role: 'button', tabindex: '0', 'aria-pressed': jsel ? 'true' : 'false',
            'aria-label': `Job ${nodeName(j)} (${jobWho(j)}): ${BR[j.st][1]}`, title: `${nodeName(j)} · ${jobWho(j)}: ${j.needs ? `needs you: ${j.needs}` : BR[j.st][1]}${j.hasOutput ? ' · output ready' : ''}${j.outcome ? ` · ${j.outcome}` : ''}`, ...pick(j.id) },
            h('span', { class: 'tl-name' }, brG(j.st), brChip(j.model), h('span', { class: 'br-nm', text: `▸ ${nodeName(j)}` }), h('span', { class: 'br-eff', text: jobWho(j) })),
            track(x.spans), h('span', { class: 'br-st', text: stText(j.st, j) }));
        }),
        more > 0 ? h('div', { class: 'br-more tl-more', text: `+${plural(more, 'more job')}` }) : null);
    };
    const axis = h('div', { class: 'tl-lane tl-axis', 'aria-hidden': 'true' }, h('span', { class: 'tl-name', text: `${md(T.from)} · today` }),
      h('div', { class: 'tl-track' }, ticks.map((t, k) => h('span', { class: `tl-tick${k % 2 ? ' odd' : ''}`, style: { left: pct(t) }, text: hhmm(t) })),
        h('span', { class: `tl-nowl${now - from > 0.9 * span ? ' end' : ''}`, style: { left: pct(now) }, text: 'now' })), h('span', {}));
    const groups = rows.map(({ p, lanes }) => h('div', { class: 'tl-group' },
      h('div', { class: `tl-proj s-${p.st}` }, brG(p.st), brProjName(p), h('span', { class: 'br-eff', text: `${plural(lanes.length, 'session')}${p.jobs ? ` · ${plural(p.jobs, 'job')}` : ''}` }),
        p.needs ? h('span', { class: 'br-st', text: `! ${p.needs} needs you` }) : null),
      lanes.map((l) => lane(byId.get(l.id), l))));
    const nowLine = h('div', { class: 'tl-over', 'aria-hidden': 'true' }, h('span', {}), h('div', { class: 'tl-overt' }, h('i', { class: 'tl-now', style: { left: pct(now) } })), h('span', {}));
    const wrap = h('div', { class: 'tl-wrap', style: { '--hr': `${(100 * 3600000 * step) / span}%` } }, axis, groups, nowLine);
    return box(wrap);
  }
  function timelineInit() {
    const box = document.querySelector('.tl-box');
    if (!box) return;
    canvasSize();
    brDrawerSize(); brDrawerGrip();
    box.scrollTop = tlScroll;
    box.addEventListener('scroll', () => { tlScroll = box.scrollTop; store.set(sessionStorage, 'threads-tl-scroll', String(tlScroll)); }, { passive: true });
    if (ui.brFocus && ui.brSel) {
      const n = box.querySelector(`[data-id="${CSS.escape(ui.brSel)}"]`), d = document.querySelector('.br-drawer');
      if (n) {
        const R = box.getBoundingClientRect(), r = n.getBoundingClientRect(), limit = R.bottom - (d ? d.offsetHeight : 0) - 16;
        if (r.bottom > limit) box.scrollTop += r.bottom - limit; else if (r.top < R.top + 40) box.scrollTop -= R.top + 40 - r.top;
      }
      ui.brFocus = false;
    }
  }

  function renderBrain() {
    const B = data.brain;
    if (!B) return [errors.brain ? empty(`Could not read the sessions: ${errors.brain}`) : empty('Reading the session files…')];
    const sel = ui.brSel ? B.nodes.find((n) => n.id === ui.brSel) || (B.jobs || []).find((j) => j.id === ui.brSel) || null : null;
    const hint = B.empty ? h('div', { class: 'br-hint', text: 'No Claude Code sessions found yet. Start one in any folder; it shows up here within 20 seconds.' })
      : !B.hooks ? h('div', { class: 'br-hint', text: 'Status hooks are not installed: "awaiting you" needs them (hooks/README.md).' }) : null;
    const tree = ui.brLayout === 'timeline' ? null : B.nodes.length ? brTree(B) : h('div', { class: 'br-graph br-tree' }, h('div', { class: 'br-row0' }, h('div', { class: 'br-n br-root s-idle', 'data-id': 'you' },
      h('div', { class: 'br-l1' }, brG('idle'), h('span', { class: 'br-nm', text: 'YOU' })), h('div', { class: 'br-l2' }, h('span', { text: B.empty ? 'no sessions yet' : 'nothing on the tree: quiet for 2 hours' })))));
    return [brStrip(B), hint, ui.brDone ? brDoneList(B) : null, ui.brParkOpen && B.parked.length ? brParkList(B) : null, h('div', { class: 'br-fb' }, fbNode('br')),
      h('div', { class: 'br-stage' }, ui.brLayout === 'timeline' ? brTimeline(B) : canvas([tree], helpersBox(B)), sel ? brDrawer(sel) : null)];
  }

  // ---------------------------------------------------------------- Details
  const valOf = (v) => (money === 'tokens' ? v.tok || 0 : v.usd || 0);
  const fmtVal = (v) => (money === 'tokens' ? fmtTok(v) : fmtUsd(v));
  const famLegend = (fams) => h('div', { class: 'br-leg' }, fams.map((m) => h('span', {}, brChip(m), FAM[famOf(m)][1])));
  function renderDetails() {
    const D = data.details;
    if (!D) return [errors.details ? empty(`Could not read the details: ${errors.details}`) : empty('Reading the session files. The first read can take a minute.')];
    if (D.pending) return [empty('Reading the session files. The first read can take a minute.')];
    const unit = money === 'tokens' ? 'Tokens' : 'List dollars';
    const fams = FAM_ORDER.filter((m) => D.days.some((d) => d.models[m]));
    const tot = (row) => Object.values(row).reduce((x, v) => x + valOf(v), 0);
    const max = Math.max(1e-9, ...D.days.map((d) => tot(d.models)));
    const cols = D.days.map((d) => {
      const t = tot(d.models);
      const lines = fams.filter((m) => d.models[m]).map((m) => `${FAM[m][1]}: ${fmtVal(valOf(d.models[m]))} · ${plural(d.models[m].n, 'response')}`);
      return h('div', { class: 'br-col1', role: 'img', 'aria-label': `${md(keyMs(d.day))}: ${fmtVal(t)}`, title: `${md(keyMs(d.day))}\n${lines.join('\n') || 'Nothing ran'}` },
        h('span', { class: 'br-cv', text: t ? fmtVal(t) : '' }),
        h('div', { class: 'br-stack' }, fams.filter((m) => d.models[m]).map((m) => h('i', { class: `m-${m}`, style: { height: `${(100 * valOf(d.models[m])) / max}%` } }))),
        h('span', { class: `br-cx${d.day === D.today ? ' on' : ''}`, text: d.day === D.today ? 'today' : String(new Date(keyMs(d.day)).getDate()) }));
    });
    const perDay = frame(`${unit} per day, by model`, `last ${D.days.length} days`, fams.length ? famLegend(fams) : empty('Nothing ran in the last 14 days.'), h('div', { class: 'br-cols' }, cols));
    const pmax = Math.max(1e-9, ...D.projects.map((p) => tot(p.models)));
    const prow = (p) => {
      const lt = valOf(p.lead), ht = valOf(p.helper), all = lt + ht;
      return h('div', { class: 'br-prow' }, h('span', { class: 'br-pn', text: p.label, title: p.label }),
        h('div', { class: 'br-ptrack' }, h('div', { class: 'br-hbar', style: { width: `${Math.max(1, (100 * tot(p.models)) / pmax)}%` } },
          FAM_ORDER.filter((m) => p.models[m]).map((m) => h('i', { class: `m-${m}`, title: `${FAM[m][1]}: ${fmtVal(valOf(p.models[m]))}`, style: { 'flex-grow': String(valOf(p.models[m]) || 0.0001) } })))),
        h('span', { class: 'br-tok', text: fmtVal(tot(p.models)) }),
        h('span', { class: 'br-dm', text: all ? `lead ${Math.round((100 * lt) / all)}% · helpers ${Math.round((100 * ht) / all)}%` : '' }));
    };
    const byProject = frame(`${unit} by project`, 'last 7 days', D.projects.length ? D.projects.map(prow) : empty('Nothing ran in the last 7 days.'));
    const cmax = Math.max(200000, ...D.sessions.map((x) => x.peak));
    const srow = (x) => h('div', { class: 'br-srow' }, h('span', { class: 'br-pn', text: x.project, title: x.project }), brChip(x.model),
      h('span', { class: 'br-dm', text: `${dayOf(x.last) === dayOf(Date.now()) ? '' : `${md(x.last)} `}${hhmm(x.first)} to ${hhmm(x.last)} · ${plural(x.n, 'response')}` }),
      h('span', { class: 'br-tok', text: fmtVal(money === 'tokens' ? x.tok : x.usd) }),
      h('div', { class: 'br-ctx', role: 'img', 'aria-label': `Largest context ${fmtTok(x.peak)}`, title: `Largest context of its own turns: ${fmtTok(x.peak)}` }, h('i', { style: { width: `${Math.min(100, (100 * x.peak) / cmax)}%` } })),
      h('span', { class: 'br-dm', text: fmtTok(x.peak) }));
    const sessions = frame('Sessions and their largest context', 'last 2 days', D.sessions.length ? D.sessions.map(srow) : empty('No session in the last 2 days.'));
    return [perDay, h('div', { class: 'br-two' }, byProject, sessions)];
  }

  // ---------------------------------------------------------------- Tools
  const SORTS = [['az', 'A–Z'], ['most', 'Most used'], ['least', 'Least used'], ['never', 'Never used (30 days)']];
  const agoDays = (ms) => { const d = Math.floor((Date.now() - ms) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`; };
  function renderTools() {
    const D = data.tools;
    if (!D) return [errors.tools ? empty(`Could not read the tools: ${errors.tools}`) : empty('Reading the skills and tools…')];
    const sort = ui.toolSort;
    const mergeNames = new Set(D.merges.flatMap((m) => m.names));
    const pending = D.usage === 'pending';
    const useLine = (i) => (i.use ? (i.use.d30 ? `last used ${agoDays(i.use.last)} · ${plural(i.use.d30, 'use')} in 30 days` : 'no use in 30 days') : pending ? 'usage: counting…' : 'usage not counted');
    const card = (kind, i) => {
      const k = `${kind}:${i.where || ''}:${i.name}`;
      const on = ui.toolOpen.has(k);
      const toggle = () => { if (on) ui.toolOpen.delete(k); else ui.toolOpen.add(k); render(); };
      const short = i.short != null ? i.short : i.line || '';
      return h('div', { class: `br-tc2${on ? ' on' : ''}`, role: 'button', tabindex: '0', 'aria-expanded': on ? 'true' : 'false', 'data-name': i.name.toLowerCase(),
        onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
        h('div', { class: 'br-tn' }, h('b', { text: i.name }), mergeNames.has(i.name.toLowerCase()) ? h('span', { class: 'br-tagm', text: 'Merge?' }) : null, i.use && !i.use.d30 ? h('span', { class: 'br-tagu', text: 'Unused 30d' }) : null),
        short ? h('div', { class: 'br-tb2', text: `• ${on && i.long ? i.long : short}` }) : null,
        h('div', { class: 'br-tm', text: [kind === 'helper' && (i.model || i.effort) ? [i.model, i.effort].filter(Boolean).join(' · ') : null, useLine(i)].filter(Boolean).join(' · ') }),
        on ? h('div', { class: 'br-tx' }, [i.where ? `lives in: ${i.where}` : null, i.use ? `used ${i.use.d7} times in 7 days, ${i.use.d30} in 30${i.use.last ? `, last ${when(i.use.last)}` : ''}` : null,
          i.match ? `counted when a tool call names "${i.match}"` : null].filter(Boolean).map((t) => h('div', { text: t }))) : null);
    };
    const score = (i) => (i.use ? i.use.d30 : -1);
    const order = (list) => (sort === 'az' ? [...list].sort((p, q) => p.name.localeCompare(q.name))
      : sort === 'most' ? [...list].sort((p, q) => score(q) - score(p) || p.name.localeCompare(q.name))
        : sort === 'least' ? [...list].filter((i) => i.use).sort((p, q) => score(p) - score(q) || p.name.localeCompare(q.name))
          : [...list].filter((i) => i.use && !i.use.d30).sort((p, q) => p.name.localeCompare(q.name)));
    const grid = (kind, list) => { const l = order(list); return l.length ? h('div', { class: 'br-cgrid' }, l.map((i) => card(kind, i))) : empty(sort === 'never' ? 'Nothing unused here.' : 'None.'); };
    const byWhere = (kind, list) => {
      const groups = [...new Set(list.map((i) => i.where))].sort((a, b) => (a === 'user' ? -1 : b === 'user' ? 1 : a.localeCompare(b)));
      return groups.map((w) => h('div', { class: 'br-tcat' }, h('div', { class: 'br-tg', text: w }), grid(kind, list.filter((i) => i.where === w))));
    };
    const filter = (q) => {
      for (const r of document.querySelectorAll('.br-tc2, .br-ti')) r.hidden = !!q && !(r.dataset.name || '').includes(q.toLowerCase());
      for (const c of document.querySelectorAll('.br-tcat')) c.hidden = !!q && ![...c.querySelectorAll('.br-tc2')].some((r) => !r.hidden);
    };
    const search = h('input', { class: 'br-q', type: 'search', placeholder: 'Filter by name', 'aria-label': 'Filter by name', value: ui.toolQ, oninput: (e) => { ui.toolQ = e.target.value; filter(ui.toolQ); } });
    requestAnimationFrame(() => filter(ui.toolQ));
    const sortSw = h('div', { class: 'br-seg', role: 'group', 'aria-label': 'Order by use' }, SORTS.map(([k, l]) => h('button', { class: sort === k ? 'on' : null, type: 'button', 'aria-pressed': sort === k ? 'true' : 'false', onclick: () => { ui.toolSort = k; render(); } }, l)));
    const parts = [['skills', 'Skills', D.skills.length], ['helpers', 'Helpers', D.helpers.length], ['mcp', 'MCP', D.mcp.length], ['own', 'Your own', D.own.length]].filter((p) => p[2]);
    const total = parts.reduce((a, p) => a + p[2], 0) || 1;
    const sumBar = h('div', { class: 'br-sum', role: 'img', 'aria-label': parts.map((p) => `${p[1]} ${p[2]}`).join(', ') },
      h('div', { class: 'br-segbar' }, parts.map((p) => h('i', { class: `t-${p[0]}`, style: { 'flex-grow': String(p[2] / total) } }))),
      h('div', { class: 'br-segleg' }, parts.map((p) => h('span', { class: `t-${p[0]}` }, h('i', {}), `${p[1]} ${p[2]}`))));
    const tracked = [...D.skills, ...D.helpers, ...D.mcp, ...D.own].filter((i) => i.use);
    const barChart = (title, list) => {
      const max = Math.max(1, ...list.map((i) => i.use.d30));
      return h('div', { class: 'br-ubar' }, h('div', { class: 'br-tg', text: title }), list.map((i) => h('div', { class: 'br-urow', title: `${i.name}: ${i.use.d30} uses in 30 days, ${i.use.d7} in 7` },
        h('span', { class: 'br-un', text: i.name }), h('span', { class: 'br-ut' }, h('i', { style: { width: `${(100 * i.use.d30) / max}%` } })), h('span', { class: 'br-uv', text: String(i.use.d30) }))));
    };
    const charts = tracked.length ? frame('Use in the last 30 days', `${plural(tracked.length, 'item')} counted from the transcripts, numbers only`,
      h('div', { class: 'br-two' }, barChart('Most used (top 15)', [...tracked].sort((p, q) => q.use.d30 - p.use.d30).slice(0, 15)), barChart('Least used (bottom 15)', [...tracked].sort((p, q) => p.use.d30 - q.use.d30).slice(0, 15))))
      : frame('Use in the last 30 days', '', empty(pending ? 'Counting the uses in the transcripts…' : 'No use counted yet.'));
    const li = (name, rest) => h('div', { class: 'br-ti', 'data-name': name.toLowerCase() }, h('b', { text: name }), rest ? h('span', { text: `: ${rest}` }) : null);
    const lines = (list, none) => (list.length ? h('div', { class: 'br-tgrid' }, list) : empty(none));
    return [h('div', { class: 'br-tbar' }, search, sortSw, sumBar), charts,
      frame('Your own tools', 'tools-catalog.json', D.own.length ? grid('own', D.own) : empty('List your own scripts in tools-catalog.json (see tools-catalog.example.json).')),
      frame('Skills', `${D.skills.length}`, D.skills.length ? byWhere('skill', D.skills) : empty('No skills found.')),
      h('div', { class: 'br-two' },
        frame('Helpers', `${D.helpers.length}`, D.helpers.length ? byWhere('helper', D.helpers) : empty('No helper files found.')),
        frame('MCP servers', 'names only', D.mcp.length ? byWhere('mcp', D.mcp) : empty('No MCP servers in the settings files.'))),
      D.merges.length ? frame('Possible merges', 'the same name twice, or alike descriptions', h('div', { class: 'br-tgrid' }, D.merges.map((m) => li(m.names[0] === m.names[1] ? m.names[0] : `${m.names[0]} + ${m.names[1]}`, m.why)))) : null,
      h('div', { class: 'br-two' },
        frame('Hooks', 'script names only', lines(D.hooks.map((x) => li(`${x.event}${x.matcher ? ` (${x.matcher})` : ''}`, `${x.script} · ${x.where}`)), 'No hooks in the settings files.')),
        frame('Plugins', 'enabled in the settings', lines(D.plugins.map((p) => li(p)), 'None enabled.'))),
      frame('Slash commands and status line', '', lines([li('status line', D.statusLine || 'none'), ...D.commands.map((c) => li(c.name, c.where))], ''))];
  }

  // ---------------------------------------------------------------- Team
  async function teamSet(helper, set) {
    const r = await post('/api/team', { helper, ...set });
    feedback(`team-${helper}`, r.ok ? 'Saved: new runs use it' : `Not saved: ${r.error || 'failed'}`, !r.ok);
    load('team');
  }
  function renderTeam() {
    const D = data.team;
    if (!D) return [errors.team ? empty(`Could not read the helpers: ${errors.team}`) : empty('Reading the helper files…')];
    if (!D.helpers.length) return [frame('Helpers', '', empty('No helper files in ~/.claude/agents yet.'))];
    const label = (v) => (FAM[v] ? FAM[v][1] : v);
    const chipFor = (v) => (FAM[v] ? v : famOf((D.helpers.find((x) => x.modelRaw === v) || {}).model));
    const seg = (helper, key, list, cur) => h('div', { class: 'br-seg', role: 'group', 'aria-label': `${helper}: ${key}` }, list.map((v) => {
      const on = key === 'model' ? (list.includes(cur.modelRaw) ? v === cur.modelRaw : v === cur.model) : v === cur.effort;
      return h('button', { class: on ? 'on' : null, type: 'button', 'aria-pressed': on ? 'true' : 'false', title: `${helper}: ${key} ${v}`, onclick: () => { if (!on) teamSet(helper, { [key]: v }); } },
        key === 'model' ? [brChip(chipFor(v)), label(v)] : v);
    }));
    const changed = (x) => {
      const c = D.changes[x.name];
      if (!c) return null;
      const parts = [];
      if (c.from.model !== c.to.model) parts.push(`${label(c.from.model) || '–'} → ${label(c.to.model)}`);
      if (c.from.effort !== c.to.effort) parts.push(`${c.from.effort || '–'} → ${c.to.effort}`);
      return h('div', { class: 'br-chg', text: `changed ${when(c.at)}: ${parts.join(', ') || 'saved again'}` });
    };
    const rows = D.helpers.map((x) => h('div', { class: 'br-team' },
      h('div', { class: 'br-tw' }, h('b', { text: x.name }), h('span', { class: 'br-dm', text: x.description || (x.model ? '' : 'no frontmatter: add a --- block with model: and effort:') }), changed(x), fbNode(`team-${x.name}`)),
      h('div', { class: 'br-tc' }, seg(x.name, 'model', D.models, x), seg(x.name, 'effort', D.efforts, x))));
    const per = FAM_ORDER.map((m) => [m, D.helpers.filter((x) => x.model && famOf(x.model) === m).length]).filter((p) => p[1]);
    const strip = h('div', { class: 'br-sum', role: 'img', 'aria-label': per.map(([m, n]) => `${FAM[m][1]} ${n}`).join(', ') },
      h('div', { class: 'br-segbar' }, per.map(([m, n]) => h('i', { class: `m-${m}`, style: { 'flex-grow': String(n) } }))),
      h('div', { class: 'br-segleg' }, per.map(([m, n]) => h('span', {}, brChip(m), `${FAM[m][1]} ${n}`))));
    return [h('div', { class: 'br-tbar' }, strip), frame('Who runs what', 'a change applies at once: new runs read the helper file', rows)];
  }

  // ---------------------------------------------------------------- render and polling
  const RENDER = { brain: renderBrain, details: renderDetails, tools: renderTools, team: renderTeam };
  function render() {
    if (ui.dragging) { ui.pending = true; return; }
    const active = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('br-q');
    const body = RENDER[ui.view]();
    $('content').replaceChildren(h('div', { class: 'br' }, header(), body));
    if (ui.view === 'brain') { if (ui.brLayout === 'timeline') timelineInit(); else canvasInit(); }
    const ri = document.querySelector('.br-rename');
    if (ri) { ri.focus(); ri.setSelectionRange(ri.value.length, ri.value.length); }
    if (active) { const q = document.querySelector('.br-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
  }
  const visible = () => document.visibilityState !== 'hidden';
  setInterval(() => { if (visible()) load('brain'); }, 20000);
  setInterval(() => { if (visible() && ui.view !== 'brain') load(ui.view); }, 60000);
  document.addEventListener('visibilitychange', () => { if (visible()) { load('brain'); if (ui.view !== 'brain') load(ui.view); } });
  render();
  load('brain');
  if (ui.view !== 'brain') load(ui.view);
})();
