// Everything that knows where Claude Code keeps its files and how a transcript line looks. Another agent can be read by
// a module with these same exports, switched in ./index.mjs.
//
// What may leave this module (and so reach the page): numbers, times, model and effort words, tool / skill / helper /
// MCP server / hook event / plugin / command names, script and program file names, a frontmatter description line,
// project labels, a helper's own job label (its meta description, cleaned and cut to 48 characters).
// Never a prompt, a reply, a command, a path, a tool result, a title or any other text from a transcript.
import os from 'node:os';
import path from 'node:path';
import { ls, one, statSafe, readJson, sha256hex } from '../util.mjs';
import { frontmatter, famWord, readHead } from '../team.mjs';

export const LABEL = 'Claude Code';
export const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;
/** Claude Code names a project's transcript folder after its path, every other character a dash. */
export const folderOf = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-');

/**
 * extraDirs: more Claude Code folders to read sessions from (from the git-ignored config). Without --claude, the
 * default folder and CLAUDE_CONFIG_DIR are both read when they differ, so every instance on the machine shows.
 */
export function locate({ claudeDir, extraDirs = [] } = {}) {
  const home = path.join(os.homedir(), '.claude');
  const dir = path.resolve(claudeDir || process.env.CLAUDE_CONFIG_DIR || home);
  const roots = [dir];
  const add = (d) => { if (typeof d !== 'string' || !d) return; const r = path.resolve(d); if (!roots.includes(r)) roots.push(r); };
  if (!claudeDir) add(home);
  for (const d of Array.isArray(extraDirs) ? extraDirs : []) add(d);
  return {
    claudeDir: dir,
    projectsDir: path.join(dir, 'projects'),
    projectsDirs: roots.map((r) => path.join(r, 'projects')),
    agentsDir: path.join(dir, 'agents'),
    skillsDir: path.join(dir, 'skills'),
    commandsDir: path.join(dir, 'commands'),
    pluginsDir: path.join(dir, 'plugins'),
    settingsFiles: [path.join(dir, 'settings.json'), path.join(dir, 'settings.local.json')],
    userJsonFiles: [path.join(dir, '.claude.json'), path.join(path.dirname(dir), '.claude.json')],
  };
}

// ---------------------------------------------------------------- files
/** The main transcripts written since sinceMs, and how many exist at all. */
export async function listSessions(P, sinceMs) {
  const sessions = [];
  let total = 0;
  const seen = new Set();
  for (const root of P.projectsDirs || [P.projectsDir]) for (const d of await ls(root)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const e of await ls(dir)) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const session = e.name.slice(0, -6);
      if (!SESSION_ID.test(session) || seen.has(session)) continue;
      seen.add(session);
      total++;
      const file = path.join(dir, e.name);
      const st = await statSafe(file);
      if (!st || !st.isFile() || st.mtimeMs < sinceMs) continue;
      sessions.push({ folder: d.name, dir, session, file, st, subDir: path.join(dir, session, 'subagents') });
    }
  }
  return { sessions, total };
}

/** A session's helper transcripts: [{file, st}]. */
export async function listHelpers(subDir) {
  const out = [];
  for (const e of await ls(subDir)) {
    if (!e.isFile() || !/^agent-[\w-]+\.jsonl$/.test(e.name)) continue;
    const file = path.join(subDir, e.name);
    const st = await statSafe(file);
    if (st && st.isFile()) out.push({ file, st });
  }
  return out;
}

/**
 * A helper's meta file: only its type, its job label, whether it finished, and the call that started it. job is the
 * short description the lead session wrote for it: control characters removed, 48 characters at most. Nothing else
 * of the file is read (the tool-use id stays on the server, for matching only).
 */
export async function helperMeta(file) {
  const o = readJson(file.replace(/\.jsonl$/, '.meta.json')) || {};
  return {
    who: typeof o.agentType === 'string' && clip(o.agentType) !== 'tool' ? clip(o.agentType) : 'helper',
    job: typeof o.description === 'string' ? one(o.description, 48) : '',
    finished: o.finished === true,
    toolUseId: typeof o.toolUseId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(o.toolUseId) ? o.toolUseId : '',
  };
}

const HEAD_BYTES = 256 * 1024;
const heads = new Map(); // file -> {cwd, entry}
/** The kind of Claude Code instance, as one word: cli (a terminal), headless (-p or the SDK), desktop (the app), ide. */
export const entryWord = (e) => (e === 'cli' ? 'cli' : /^sdk/.test(e) ? 'headless' : /desktop/.test(e) ? 'desktop' : /vscode|jetbrains|cursor|windsurf/.test(e) ? 'ide' : '');
/** The working folder and the entry point of a transcript, from its first lines. */
export async function sessionHead(file) {
  const had = heads.get(file);
  if (had) return had;
  const text = await readHead(file, HEAD_BYTES);
  if (text == null) return { cwd: '', entry: '' };
  let cwd = '', entry = null;
  const end = text.lastIndexOf('\n');
  for (const line of (end >= 0 ? text.slice(0, end) : '').split('\n')) {
    if (cwd && entry != null) break;
    if (!line.includes('"cwd"') && !line.includes('"entrypoint"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (!cwd && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
    if (entry == null && typeof o.entrypoint === 'string') entry = entryWord(o.entrypoint);
  }
  const out = { cwd, entry: entry || '' };
  const st = await statSafe(file);
  if ((cwd && entry != null) || (st && st.size >= HEAD_BYTES)) {
    heads.set(file, out);
    if (heads.size > 2000) heads.delete(heads.keys().next().value);
  }
  return out;
}

/** The last segment of a working folder, as a project label. */
export const labelOfCwd = (cwd) => one(String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '', 40);

/** Every transcript under the projects folder: {file, folder, session, helper}. */
export async function* walkTranscripts(projectsDir) {
  async function* walk(dir, rel) {
    for (const e of await ls(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (rel.length < 4 && e.name !== 'tool-results' && e.name !== 'memory') yield* walk(p, [...rel, e.name]);
      } else if (e.isFile() && e.name.endsWith('.jsonl') && rel.length >= 1) {
        const folder = rel[0];
        const helper = rel.includes('subagents');
        const session = rel.length === 1 ? e.name.slice(0, -6) : rel[1];
        yield { file: p, folder, session, helper };
      }
    }
  }
  yield* walk(projectsDir, []);
}

// ---------------------------------------------------------------- lines
/** One transcript line -> [id, t, model, i, o, cw, cr, side, effort, cw1h], or null. Numbers and words only. */
export function usageOfLine(line, file) {
  if (!line || !line.includes('"usage"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || o.type !== 'assistant' || !o.message || !o.timestamp) return null;
  const m = o.message;
  const u = m.usage;
  if (!u || typeof u !== 'object' || m.model === '<synthetic>') return null;
  const t = Date.parse(o.timestamp);
  if (!Number.isFinite(t)) return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const cw = n(u.cache_creation_input_tokens);
  const cw1h = Math.min(cw, n(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens));
  const id = (typeof m.id === 'string' && m.id) || (typeof o.requestId === 'string' && o.requestId) || `${file}:${o.uuid}`;
  const effort = typeof o.effort === 'string' && /^[a-z]{1,12}$/.test(o.effort) ? o.effort : '';
  return [id, t, String(m.model || 'unknown').slice(0, 60), n(u.input_tokens), n(u.output_tokens), cw, n(u.cache_read_input_tokens), !!o.isSidechain, effort, cw1h];
}

const clip = (s) => String(s).replace(/\s+/g, ' ').replace(/[^A-Za-z0-9_.: -]/g, '').trim().slice(0, 24) || 'tool';
const skillName = (s) => clip(String(s).trim().toLowerCase().replace(/^[a-z0-9_-]+:/, '').replace(/[^a-z0-9_.:-]/g, ''));

/** A tool call -> its tag {k, name}: the skill it names, the helper it starts, the MCP server it calls, else the tool. */
export function toolLabel(name, input) {
  const n = typeof name === 'string' ? name : '';
  if (!n) return null;
  const inp = input && typeof input === 'object' ? input : {};
  if (n === 'Skill' && typeof inp.skill === 'string' && inp.skill.trim()) return { k: 'skill', name: skillName(inp.skill) };
  if ((n === 'Agent' || n === 'Task') && typeof inp.subagent_type === 'string' && inp.subagent_type.trim()) return { k: 'helper', name: clip(inp.subagent_type) };
  if (n === 'Agent' || n === 'Task') return { k: 'helper', name: 'helper' };
  const m = /^mcp__(.+?)__/.exec(n);
  if (m) return { k: 'mcp', name: clip(m[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ').trim()) };
  return { k: 'tool', name: clip(n) };
}

// A background job: a call with run_in_background, or one whose result says it went to the background. It ends with
// the queued notification that names its tool-use id. Result text is only compared here, never kept.
const NOTE = ['task', 'notification'].join('-');
const NOTE_OPEN = `<${NOTE}>`;
const NOTE_RE = new RegExp(`<${NOTE}>([\\s\\S]*?)</${NOTE}>`, 'g');
const BG_RESULT = /^\s*(Command running in background|Async agent launched)/;
const CLOSED = /^(completed|failed|killed|stopped|cancelled|canceled|error)$/i;

const NOT_A_RUN = new Set(['cd', 'pushd', 'popd', 'export', 'source', '.', 'set', 'unset', 'true', 'false', 'echo', 'printf', 'sleep', 'wait', 'disown', 'eval',
  'mkdir', 'rm', 'cp', 'mv', 'ls', 'cat', 'touch', 'chmod', 'test', '[', 'kill', 'pkill', 'lsof', 'ps', 'tee']);
const WRAPPERS = new Set(['nohup', 'env', 'time', 'timeout', 'exec', 'nice', 'caffeinate', 'command', 'builtin']);
const FILE_WORD = /^[A-Za-z0-9._+-]{1,40}$/;
/**
 * The program a command starts and the script file that same part of it names, as file names only: never a path, an argument or the
 * command. The command is only compared here. "cd x && nohup blender -b s.blend --python render_steps.py" -> blender, render_steps.py
 */
export function programOf(cmd) {
  const c = String(cmd || '');
  let prog = '', from = c;
  for (const seg of c.split(/&&|\|\||[;|&\n(){}]/)) {
    const words = seg.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (!words.length || NOT_A_RUN.has(words[0])) continue;
    let k = 0;
    while (k < words.length && (WRAPPERS.has(words[k]) || words[k].includes('=') || /^-/.test(words[k]) || (k > 0 && WRAPPERS.has(words[k - 1]) && /^\d+[smh]?$/.test(words[k])))) k++;
    if (k >= words.length) continue;
    const w = words[k].replace(/["']/g, '').split(/[\\/]/).pop();
    if (FILE_WORD.test(w)) { prog = w; from = seg; break; }
  }
  const m = from.match(/[\w.+-]+\.(?:mjs|cjs|js|ts|ps1|py|cmd|bat|sh|rb|pl|lua)\b/gi);
  const script = m ? one(m.at(-1), 40) : '';
  return { prog: one(prog, 40), script: script === prog ? '' : script };
}
/** What a background call is, names only: {k, tool, prog?, script?}. */
function bgName(name, input) {
  const tag = toolLabel(name, input);
  if (!tag) return { k: 'tool', tool: 'tool' };
  if (tag.k === 'helper') return { k: 'helper', tool: tag.name };
  const inp = input && typeof input === 'object' ? input : {};
  const P = typeof inp.command === 'string' ? programOf(inp.command) : { prog: '', script: '' };
  return { k: tag.k, tool: tag.name, ...(P.prog ? { prog: P.prog } : {}), ...(P.script ? { script: P.script } : {}) };
}

// What a transcript did, as names and counts only: each tool / skill / helper / MCP server name with how often it was
// called, the script file names its commands ran, how many different files it wrote (a path is hashed and counted,
// never kept) and how many calls came back as an error. The caps keep a long transcript's state small.
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const RUNNERS = /^(node|nodejs|python[\d.]*|bash|sh|zsh|blender|deno|bun|ruby|perl|lua|tsx|ts-node|pwsh|powershell|uv|npx)(\.exe)?$/i;
const SCRIPT_FILE = /\.(?:mjs|cjs|js|ts|ps1|py|cmd|bat|sh|rb|pl|lua)$/i;
const bump = (map, key, cap) => { if (map.has(key) || map.size < cap) map.set(key, (map.get(key) || 0) + 1); };
function countCall(S, c, tag) {
  if (!S.calls) return;
  if (tag) bump(S.calls, `${tag.k}\n${tag.name}`, 60);
  const inp = c.input && typeof c.input === 'object' ? c.input : {};
  if (c.name === 'Bash' && typeof inp.command === 'string') {
    // a script counts when the command runs it: a runner with a script file, or the script file itself
    const P = programOf(inp.command);
    const ran = RUNNERS.test(P.prog) ? P.script : SCRIPT_FILE.test(P.prog) ? P.prog : '';
    if (ran) bump(S.scripts, ran, 40);
  }
  const f = WRITES.has(c.name) ? inp.file_path || inp.notebook_path : null;
  if (typeof f === 'string' && f && S.files.size < 5000) S.files.add(sha256hex(f).slice(0, 16));
}

/**
 * Feeds one line into a state {side, tool, skill, launch: Map(id -> {t, k, tool, prog?, script?}), uses, closed: Set(id),
 * calls: Map("k\nname" -> n), scripts: Map(name -> n), files: Set(hash), errors: n}.
 */
export function feedLine(S, line) {
  if (!line || line.length < 20) return;
  const hasUse = line.includes('"tool_use"');
  const hasRes = line.includes('"tool_result"');
  const hasNote = line.includes(NOTE);
  if (!hasUse && !hasRes && !hasNote) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (!o || typeof o !== 'object') return;
  const t = Date.parse(o.timestamp) || 0;
  const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
  if (o.type === 'assistant' && content && (S.side || !o.isSidechain)) {
    for (const c of content) {
      if (!c || c.type !== 'tool_use') continue;
      const tag = toolLabel(c.name, c.input);
      if (tag) S.tool = { ...tag, t };
      if (tag && tag.k === 'skill') S.skill = tag.name;
      countCall(S, c, tag);
      if (typeof c.id !== 'string') continue;
      if (c.input && c.input.run_in_background === true) S.launch.set(c.id, { t, ...bgName(c.name, c.input) });
      else if (S.uses && (c.name === 'Bash' || c.name === 'Agent' || c.name === 'Task')) {
        S.uses.set(c.id, bgName(c.name, c.input));
        if (S.uses.size > 200) S.uses.delete(S.uses.keys().next().value);
      }
    }
    return; // an assistant line never ends a job, even one that quotes a notification
  }
  if (o.type === 'user' && content && hasRes) {
    for (const c of content) {
      if (!c || c.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
      if (c.is_error === true && S.calls) S.errors = (S.errors || 0) + 1;
      const first = typeof c.content === 'string' ? c.content : Array.isArray(c.content) && c.content[0] && typeof c.content[0].text === 'string' ? c.content[0].text : '';
      if (BG_RESULT.test(first) && !S.launch.has(c.tool_use_id)) S.launch.set(c.tool_use_id, { t, ...((S.uses && S.uses.get(c.tool_use_id)) || { k: 'tool', tool: 'tool' }) });
    }
  }
  if (!hasNote) return;
  // the notification itself: a queued message, or a user turn made only of text (never a tool result that shows one)
  let text = '';
  if (o.type === 'queue-operation' && typeof o.content === 'string') text = o.content;
  else if (o.type === 'user' && o.message && typeof o.message.content === 'string') text = o.message.content;
  else if (o.type === 'user' && content && content.every((c) => c && c.type === 'text')) text = content.map((c) => c.text).join('\n');
  else if (o.type === 'attachment' || (o.attachment && typeof o.attachment === 'object')) text = JSON.stringify(o.attachment && (o.attachment.prompt ?? o.attachment.content ?? ''));
  if (!text.includes(NOTE_OPEN)) return;
  for (const m of text.matchAll(NOTE_RE)) {
    const id = /<tool-use-id>\s*([A-Za-z0-9_-]+)\s*<\/tool-use-id>/.exec(m[1]);
    const st = /<status>\s*([A-Za-z]+)\s*<\/status>/.exec(m[1]);
    if (id && (!st || CLOSED.test(st[1]))) S.closed.add(id[1]);
  }
}

/** An MCP server name in a comparable form: "fixture-mcp" and "fixture_mcp" meet as "fixturemcp". */
export const mcpKey = (s) => String(s).toLowerCase().replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/[^a-z0-9]/g, '');

/** One line -> [[kind, key, t]]: skills, helpers and MCP servers called, and catalog matches found in a call's input. */
export function eventsOfLine(line, matches = []) {
  if (!line || !line.includes('"tool_use"')) return [];
  let o;
  try { o = JSON.parse(line); } catch { return []; }
  if (!o || o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) return [];
  const t = Date.parse(o.timestamp) || 0;
  const ev = [];
  for (const c of o.message.content) {
    if (!c || c.type !== 'tool_use' || typeof c.name !== 'string') continue;
    const inp = c.input && typeof c.input === 'object' ? c.input : null;
    if (c.name === 'Skill' && inp && typeof inp.skill === 'string' && inp.skill.trim()) {
      ev.push(['skill', inp.skill.trim().toLowerCase().replace(/^[a-z0-9_-]+:/, '').slice(0, 80), t]);
    }
    if ((c.name === 'Agent' || c.name === 'Task') && inp && typeof inp.subagent_type === 'string' && inp.subagent_type.trim()) {
      ev.push(['helper', inp.subagent_type.trim().toLowerCase().slice(0, 60), t]);
    }
    const m = /^mcp__(.+?)__/.exec(c.name);
    if (m) ev.push(['mcp', mcpKey(m[1]), t]);
    if (matches.length && inp) {
      const s = JSON.stringify(inp).toLowerCase();
      for (const x of matches) if (s.includes(x)) ev.push(['tool', x, t]);
    }
  }
  return ev;
}

// ---------------------------------------------------------------- what is installed
/** The script a command runs, as a file name only; else the command's first word without its folder. */
const scriptOf = (cmd) => {
  const m = String(cmd || '').match(/[\w.-]+\.(?:mjs|cjs|js|ts|ps1|py|cmd|bat|sh)\b/gi);
  return m ? one(m.at(-1), 60) : one(String(cmd || '').trim().split(/\s+/)[0].split(/[\\/]/).pop().replace(/["']/g, ''), 40);
};

async function skillsIn(dir, where) {
  const out = [];
  for (const e of await ls(dir)) {
    if (!e.isDirectory()) continue;
    const t = await readHead(path.join(dir, e.name, 'SKILL.md'));
    if (t == null) continue;
    const fm = frontmatter(t);
    out.push({ name: one(fm.name || e.name, 60), description: one(fm.description, 400), where });
  }
  return out;
}

const NOT_PLUGIN = /^v?\d|^[0-9a-f-]{8,}(_[0-9a-f-]{8,})?$|^(cache|plugins|marketplaces|external_plugins|synced|store|data|skills)$/i;
async function pluginSkills(dir, enabled) {
  const out = [];
  const seen = new Set();
  const go = async (d, depth, segs) => {
    if (depth > 7) return;
    for (const e of await ls(d)) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (segs.at(-1) === 'skills') {
        const t = await readHead(path.join(p, 'SKILL.md'));
        if (t == null) continue;
        let k = segs.length - 2;
        while (k >= 0 && NOT_PLUGIN.test(segs[k])) k--;
        const plugin = k >= 0 ? segs[k] : 'plugin';
        if (segs[0] === 'marketplaces' && !enabled.has(plugin)) continue;
        const fm = frontmatter(t);
        const name = one(fm.name || e.name, 60);
        const key = `${plugin}\n${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, description: one(fm.description, 400), where: `plugin ${one(plugin, 40)}` });
        continue;
      }
      await go(p, depth + 1, [...segs, e.name]);
    }
  };
  await go(dir, 0, []);
  return out;
}

async function helpersIn(dir, where) {
  const out = [];
  for (const e of await ls(dir)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const fm = frontmatter(await readHead(path.join(dir, e.name)));
    out.push({ name: one(e.name.slice(0, -3), 60), where, short: one(fm.description, 400), model: famWord(fm.model), effort: one(fm.effort, 12).toLowerCase() });
  }
  return out;
}

const mcpKeysOf = (o) => (o && o.mcpServers && typeof o.mcpServers === 'object' && !Array.isArray(o.mcpServers) ? Object.keys(o.mcpServers) : []);

/**
 * Names of what is installed, and the description line of each skill and helper. projectDirs: [{dir, label}].
 * -> {skills, helpers, mcp, hooks, commands, plugins, statusLine}
 */
export async function inventory(P, projectDirs = []) {
  const userSettings = P.settingsFiles.map(readJson).filter((o) => o && typeof o === 'object');
  const enabledKeys = new Set();
  for (const o of userSettings) for (const [k, v] of Object.entries(o.enabledPlugins || {})) if (v === true) enabledKeys.add(one(k, 80));
  const projSettings = [];
  for (const { dir, label } of projectDirs) {
    for (const f of ['settings.json', 'settings.local.json']) {
      const o = readJson(path.join(dir, '.claude', f));
      if (o && typeof o === 'object') projSettings.push({ o, where: `project ${label}` });
    }
  }
  for (const { o } of projSettings) for (const [k, v] of Object.entries(o.enabledPlugins || {})) if (v === true) enabledKeys.add(one(k, 80));
  const enabled = new Set([...enabledKeys].map((k) => k.split('@')[0]));

  const skills = [...await skillsIn(P.skillsDir, 'user')];
  for (const { dir, label } of projectDirs) skills.push(...await skillsIn(path.join(dir, '.claude', 'skills'), `project ${label}`));
  skills.push(...await pluginSkills(P.pluginsDir, enabled));

  const helpers = [...await helpersIn(P.agentsDir, 'user')];
  for (const { dir, label } of projectDirs) helpers.push(...await helpersIn(path.join(dir, '.claude', 'agents'), `project ${label}`));

  const mcp = [];
  const addMcp = (name, where) => { const n = one(name, 60); if (n && !mcp.some((x) => x.name === n)) mcp.push({ name: n, where }); };
  for (const o of userSettings) for (const k of mcpKeysOf(o)) addMcp(k, 'user');
  for (const f of P.userJsonFiles) {
    const o = readJson(f);
    if (!o || typeof o !== 'object') continue;
    for (const k of mcpKeysOf(o)) addMcp(k, 'user');
    if (o.projects && typeof o.projects === 'object') {
      for (const [p, v] of Object.entries(o.projects)) for (const k of mcpKeysOf(v)) addMcp(k, `project ${labelOfCwd(p) || 'folder'}`);
    }
  }
  for (const { dir, label } of projectDirs) for (const k of mcpKeysOf(readJson(path.join(dir, '.mcp.json')))) addMcp(k, `project ${label}`);

  const hooks = [];
  const hooksOf = (o, where) => {
    for (const [event, list] of Object.entries((o && o.hooks) || {})) {
      for (const g of Array.isArray(list) ? list : []) {
        for (const hk of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
          if (hk && typeof hk.command === 'string') hooks.push({ event: one(event, 40), matcher: one(g.matcher, 40), script: scriptOf(hk.command), where });
        }
      }
    }
  };
  for (const o of userSettings) hooksOf(o, 'user');
  for (const { o, where } of projSettings) hooksOf(o, where);

  const commands = [];
  const commandsIn = async (dir, where) => { for (const e of await ls(dir)) if (e.isFile() && e.name.endsWith('.md')) commands.push({ name: `/${one(e.name.slice(0, -3), 60)}`, where }); };
  await commandsIn(P.commandsDir, 'user');
  for (const { dir, label } of projectDirs) await commandsIn(path.join(dir, '.claude', 'commands'), `project ${label}`);

  let statusLine = '';
  for (const o of userSettings) if (!statusLine && o.statusLine && typeof o.statusLine.command === 'string') statusLine = scriptOf(o.statusLine.command);
  return { skills, helpers, mcp, hooks, commands, plugins: [...enabledKeys].sort(), statusLine };
}

/** Whether a folder exists (used for the working folders a transcript names). */
export async function isDir(p) { const st = await statSafe(p); return !!(st && st.isDirectory()); }
