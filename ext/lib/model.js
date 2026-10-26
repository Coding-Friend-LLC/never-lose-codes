// Pure state model. State is rebuilt by replaying events; nothing here does I/O.
//
// A session = one saved moment: { id, name, kind: 'manual'|'auto'|'import', createdAt, updatedAt,
//   windows: [{ tabs: [{url,title,pinned,groupId,favIconUrl}], groups: [{id,title,color,collapsed}],
//               bounds: {left,top,width,height,state}, focused }],
//   tags: [], note: '', trashedAt: null, source: null }
//
// Every change is an event { seq, ts, type, payload }. Deleting never removes data: it moves the
// session to Trash (trashedAt). Only 'session.purge' removes, and only for items trashed > 30 days.

export const TRASH_DAYS = 30;
const DAY = 86400000;

export function emptyState() {
  return { sessions: {}, meta: {}, seq: 0 };
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

export function applyEvent(state, ev) {
  const s = state;
  const p = ev.payload || {};
  const bad = (id) => id === '__proto__' || id === 'constructor' || id === 'prototype';
  if (bad(p.id) || (p.session && bad(p.session.id)) || bad(p.key)) return s;
  switch (ev.type) {
    case 'session.save': {
      const prev = s.sessions[p.session.id];
      const next = clone(p.session);
      next.updatedAt = ev.ts;
      if (!next.createdAt) next.createdAt = prev ? prev.createdAt : ev.ts;
      if (next.trashedAt === undefined) next.trashedAt = null;
      s.sessions[next.id] = next;
      break;
    }
    case 'session.rename': {
      const x = s.sessions[p.id];
      if (x) { x.name = p.name; x.updatedAt = ev.ts; }
      break;
    }
    case 'session.update': { // tags, note, collection, windows edits
      const x = s.sessions[p.id];
      if (x) { Object.assign(x, clone(p.fields)); x.updatedAt = ev.ts; }
      break;
    }
    case 'session.trash': {
      const x = s.sessions[p.id];
      if (x && !x.trashedAt) { x.trashedAt = ev.ts; x.updatedAt = ev.ts; }
      break;
    }
    case 'session.untrash': {
      const x = s.sessions[p.id];
      if (x) { x.trashedAt = null; x.updatedAt = ev.ts; }
      break;
    }
    case 'session.purge': {
      const x = s.sessions[p.id];
      // Refuse to purge anything not in Trash long enough. Guards against bugs elsewhere.
      if (x && x.trashedAt && ev.ts - x.trashedAt >= TRASH_DAYS * DAY) delete s.sessions[p.id];
      break;
    }
    case 'meta.set': {
      if (!s.meta) s.meta = {};
      s.meta[p.key] = clone(p.value);
      break;
    }
    default:
      // Unknown event types (from a newer version) are ignored, never fatal.
      break;
  }
  s.seq = Math.max(s.seq, ev.seq);
  return s;
}

export function replay(base, events) {
  const s = base ? clone(base) : emptyState();
  for (const ev of events) applyEvent(s, ev);
  return s;
}

// Merge two states without ever losing a session: union by id; same id keeps the newer copy.
// Used when importing a backup or syncing from another device.
export function mergeSessions(local, incoming) {
  const out = [];
  for (const [id, inc] of Object.entries(incoming)) {
    const cur = local[id];
    if (!cur || (inc.updatedAt || 0) > (cur.updatedAt || 0)) out.push(inc);
  }
  return out; // sessions to write via session.save
}

export function countTabs(session) {
  return (session.windows || []).reduce((n, w) => n + (w.tabs || []).length, 0);
}
