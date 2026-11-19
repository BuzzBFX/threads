// The Brain tab's Timeline layout: today on one clock, one lane per session on the tree, its busy stretches as bars,
// and a thinner lane for each helper that ran today. Numbers, hashed ids, role, state and model words only.
import { startOfDay, dayKey } from './util.mjs';

/** Spans ([from, to] in ms) cut to the window; spans outside it are dropped. */
export function clipSpans(spans, from, to) {
  return (spans || []).filter(([a, b]) => b >= from && a <= to).map(([a, b]) => [Math.max(a, from), Math.min(b, to)]);
}

/**
 * The `today` block of the brain payload.
 * nodes and projects: the shown nodes and projects of the brain; lanes: Map(node id -> {spans, helpers: [{id, role, st, model, spans}]}), a helper being one job card.
 * A session with no span today is left out, and so is a project with no such session.
 */
export function todayTimeline({ nodes = [], projects = [], lanes = new Map(), now = Date.now() }) {
  const from = startOfDay(now), to = now;
  const rows = [];
  for (const p of projects) {
    const list = [];
    for (const n of nodes) {
      if (n.parent !== p.key) continue;
      const L = lanes.get(n.id);
      const spans = clipSpans(L && L.spans, from, to);
      if (!spans.length) continue;
      const helpers = ((L && L.helpers) || []).map((x) => ({ ...(x.id ? { id: x.id } : {}), role: x.role, st: x.st, model: x.model, spans: clipSpans(x.spans, from, to) })).filter((x) => x.spans.length);
      list.push({ id: n.id, spans, helpers });
    }
    if (!list.length) continue;
    list.sort((a, b) => a.spans[0][0] - b.spans[0][0]);
    rows.push({ key: p.key, lanes: list });
  }
  return { day: dayKey(now), from, to, rows };
}
