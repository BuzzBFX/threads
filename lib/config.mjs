// Command-line flags, and the local settings file (config.json, git-ignored): project display names and more
// Claude Code folders to read.
import { readJson, one, writeFileAtomic } from './util.mjs';

const FLAGS_WITH_VALUE = { '--port': 'port', '--claude': 'claudeDir', '--data': 'dataDir', '--catalog': 'catalogFile', '--config': 'configFile' };
const SWITCHES = { '--open': 'open', '--read-only': 'readOnly', '--help': 'help', '-h': 'help', '--version': 'version' };

export const USAGE = `usage: node server.mjs [options]
  --port <n>        listen on this port only (default: the first free one of 4848-4858)
  --open            open the page in your browser
  --claude <dir>    Claude Code's folder (default: CLAUDE_CONFIG_DIR, else ~/.claude)
  --data <dir>      where Got it, Park and the live files are kept (default: ./data)
  --catalog <file>  your own tools list (default: ./tools-catalog.json)
  --config <file>   local settings: project names, job groups, more Claude folders (default: ./config.json)
  --read-only       write nothing
  --help, --version`;

export function parseArgs(argv) {
  const out = { port: null, open: false, claudeDir: null, dataDir: null, catalogFile: null, configFile: null, readOnly: false, help: false, version: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in SWITCHES) { out[SWITCHES[a]] = true; continue; }
    if (a in FLAGS_WITH_VALUE) {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) { out.error = `${a} needs a value`; break; }
      i++;
      if (a === '--port') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) { out.error = 'the port is a number from 1 to 65535'; break; }
        out.port = n;
      } else out[FLAGS_WITH_VALUE[a]] = v;
      continue;
    }
    out.error = `unknown option ${String(a).slice(0, 40)}`;
    break;
  }
  return out;
}


/**
 * config.json -> {projectNames: {label: name}, claudeDirs: [dir], jobGroups: {description: job}}. projectNames maps a
 * project label (the last folder name) to the name the page shows; claudeDirs lists more Claude Code folders whose
 * sessions are read; jobGroups puts a helper with exactly that description (its first 48 characters) under the job
 * card of that name (control characters removed, 48 characters at most), for helpers not named "<Job>: <step>".
 */
export function readConfig(file) {
  const o = (file && readJson(file)) || {};
  const projectNames = {};
  if (o.projectNames && typeof o.projectNames === 'object' && !Array.isArray(o.projectNames)) {
    for (const [k, v] of Object.entries(o.projectNames)) { const name = one(v, 40); if (typeof v === 'string' && name && one(k, 40)) projectNames[one(k, 40)] = name; }
  }
  const claudeDirs = Array.isArray(o.claudeDirs) ? o.claudeDirs.filter((d) => typeof d === 'string' && d).slice(0, 20) : [];
  const jobGroups = {};
  if (o.jobGroups && typeof o.jobGroups === 'object' && !Array.isArray(o.jobGroups)) {
    for (const [k, v] of Object.entries(o.jobGroups).slice(0, 500)) { const job = one(v, 48); if (typeof v === 'string' && job && one(k, 48)) jobGroups[one(k, 48)] = job; }
  }
  return { projectNames, claudeDirs, jobGroups };
}

/**
 * body: {label, name}: shows the project with that label as name ('' goes back to the label). labels: the project
 * labels on the page now; only those can be named. Other keys of the file are kept. -> {status, body}
 */
export async function setProjectName(file, body, labels) {
  const bad = (status, error) => ({ status, body: { ok: false, error } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(400, 'expected {label, name}');
  const extra = Object.keys(body).find((k) => k !== 'label' && k !== 'name');
  if (extra) return bad(400, `unknown key ${one(extra, 20)}`);
  if (typeof body.label !== 'string' || !labels.has(body.label)) return bad(400, 'which project? (its label)');
  if (typeof body.name !== 'string') return bad(400, 'name must be text');
  const name = one(body.name, 40);
  const o = readJson(file);
  const out = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  const names = out.projectNames && typeof out.projectNames === 'object' && !Array.isArray(out.projectNames) ? out.projectNames : {};
  if (name && name !== body.label) names[body.label] = name; else delete names[body.label];
  out.projectNames = names;
  await writeFileAtomic(file, JSON.stringify(out, null, 2) + '\n');
  return { status: 200, body: { ok: true, label: body.label, name: name || body.label } };
}
