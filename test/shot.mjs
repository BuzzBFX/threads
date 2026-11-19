// Pictures of the four tabs (the Brain as Tree and Timeline, wide and phone, with a finished job's "what it did" drawer open, a job that needs you and a done job with an output) on the synthetic home, for a person to look at. Not part of npm test.
//   node test/shot.mjs   -> test/out/<name>.png
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpDir, startServer, until, freePort, REPO } from './helpers.mjs';
import { makeHome } from './fixtures.mjs';
import { nodeId } from '../lib/states.mjs';

function findBrowser() {
  const env = process.env.THREADS_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const list = [];
  if (process.platform === 'win32') {
    for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
      const base = process.env[k];
      if (!base) continue;
      list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      list.push(path.join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'), path.join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(base, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
    }
  } else {
    const dirs = [...String(process.env.PATH || '').split(path.delimiter).filter(Boolean), '/usr/bin', '/usr/local/bin', '/snap/bin'];
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) for (const dir of dirs) list.push(path.join(dir, name));
  }
  return list.find((p) => fs.existsSync(p)) || null;
}

const browser = findBrowser();
if (!browser) { console.log('no browser found; skipped'); process.exit(0); }
const out = path.join(REPO, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const root = tmpDir();
const h = makeHome(root, Date.now(), { twin: true, marks: true }); // marks: a job that needs you, and outputs to open
// one done line, so the strip shows a count
fs.writeFileSync(path.join(h.dataDir, 'seen.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), id: nodeId('aaaaaaaa-0000-4000-8000-999999999999'), name: 'beta · earlier' })}\n`);
const catalog = JSON.stringify({ items: [{ name: 'resize-images', line: 'Batch-resizes a folder of images', match: 'resize-images.mjs' }, { name: 'deploy', line: 'Builds and uploads the site' }] });
const s = await startServer({ ...h, catalogText: catalog, configText: JSON.stringify({ projectNames: { beta: 'Bob' }, jobGroups: { 'Blender recreation, 6 variations': 'Mint video' } }) });
// name, hash, width, height, and a click before the picture. Chrome's window has a minimum width, so the phone pictures need the DevTools protocol.
const SHOTS = [['brain', 'brain/tree', 1440, 900], ['brain-timeline', 'brain/timeline', 1440, 900], ['details', 'details', 1440, 900], ['tools', 'tools', 1440, 900], ['team', 'team', 1440, 900],
  ['brain-phone', 'brain/tree', 390, 844], ['brain-timeline-phone', 'brain/timeline', 390, 844], ['brain-drawer-phone', 'brain/tree', 390, 844, '.br-c[data-id]'],
  ['brain-job', 'brain/tree', 1440, 900, '.br-job.s-done[data-id]'], ['brain-timeline-job', 'brain/timeline', 1440, 900, '.tl-help.s-done[data-id]'], ['brain-job-phone', 'brain/tree', 390, 844, '.br-job.s-done[data-id]'],
  ['brain-needs', 'brain/tree', 1440, 900, '.br-job.s-await[data-id]'], ['brain-needs-phone', 'brain/tree', 390, 844, '.br-job.s-await[data-id]'],
  ['brain-output', 'brain/tree', 1440, 900, '.br-job.s-done[data-id]', 'output'], ['brain-output-phone', 'brain/tree', 390, 844, '.br-job.s-done[data-id]', 'output']];
const report = (name, file, extra = '') => console.log(`${name}: ${fs.existsSync(file) ? path.relative(REPO, file) : 'failed'}${extra}`);

/** Screenshots through the DevTools protocol (Node 22+ has WebSocket): exact sizes, and the page width is measured. */
async function viaDevTools() {
  const port = await freePort();
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${tmpDir()}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    const list = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return null; } });
    const target = list && list.find((t) => t.type === 'page');
    if (!target) throw new Error('no page target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    let n = 0;
    const waiting = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result || {}); waiting.delete(m.id); } });
    const send = (method, params = {}) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    for (const [name, hash, width, height, click] of SHOTS) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url: `http://127.0.0.1:${s.port}/#${hash}` });
      await new Promise((r) => setTimeout(r, 2500));
      // a fresh view for each picture: the page keeps its pan, zoom and layout for the visit
      await send('Runtime.evaluate', { expression: 'sessionStorage.clear(); localStorage.clear(); location.reload()' });
      await new Promise((r) => setTimeout(r, 2500));
      if (click) {
        await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(click)}).click()` });
        await new Promise((r) => setTimeout(r, 800));
      }
      const w = (await send('Runtime.evaluate', { expression: '[innerWidth, document.documentElement.scrollWidth].join(",")', returnByValue: true })).result.value;
      const file = path.join(out, `${name}.png`);
      fs.writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      const [inner, scroll] = w.split(',').map(Number);
      report(name, file, ` (${width}x${height}, page ${scroll}px wide${scroll > inner ? ': SCROLLS SIDEWAYS' : ''})`);
    }
  } finally { try { if (ws) ws.close(); } catch { /* closed */ } child.kill(); }
}
/** Without WebSocket: Chrome's own --screenshot, wide pictures only. */
function viaFlag() {
  for (const [name, hash, width, height] of SHOTS.filter((x) => x[2] >= 600 && !x[4])) {
    const file = path.join(out, `${name}.png`);
    spawnSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${tmpDir()}`, `--window-size=${width},${height}`, '--virtual-time-budget=5000',
      `--screenshot=${file}`, `http://127.0.0.1:${s.port}/#${hash}`], { stdio: 'ignore', timeout: 60000 });
    report(name, file);
  }
  console.log('phone pictures skipped: they need Node 22 or newer');
}
try {
  await until(async () => (await s.get('/api/tools')).json.usage === 'ready');
  await until(async () => !(await s.get('/api/details')).json.pending);
  if (typeof WebSocket === 'function') await viaDevTools(); else viaFlag();
} finally { await s.stop(); }
