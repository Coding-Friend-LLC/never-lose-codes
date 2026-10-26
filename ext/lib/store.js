// NLT storage engine. Design rule: nothing we write can destroy an earlier good copy.
//
// Layer 1 (primary): IndexedDB append-only journal ('events', keyed by seq) + verified
//   checkpoints ('checkpoints'). Every record is checksummed. Writes use durability 'strict'.
// Layer 2 (mirror): a full verified copy of state in a second, independent key-value store
//   (chrome.storage.local in the extension). On open, the two are compared and the newer valid
//   one wins; the other is repaired.
// Layer 3+ (off-extension backups) live in backup.js and use exportBackup()/importBackup().
//
// Compaction never deletes an event until it is covered by KEEP_CHECKPOINTS newer verified
// checkpoints. Corrupt records are never deleted: they are skipped, reported, and kept.

import { sealed, verify, canonical, crc32 } from './checksum.js';
import { emptyState, applyEvent, replay, mergeSessions } from './model.js';

export const DB_NAME = 'nlc';
export const DB_VERSION = 1;
export const KEEP_CHECKPOINTS = 3;
export const CHECKPOINT_EVERY = 200; // events
export const BACKUP_FORMAT = 'neverlosecodes-state';

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error || new Error('transaction error'));
    tx.onabort = () => rej(tx.error || new Error('transaction aborted'));
  });
}

export function openDb(indexedDB, name = DB_NAME) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      // Additive only. Future versions add stores/indexes; never drop or rewrite in place.
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'seq' });
      if (!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints', { keyPath: 'seq' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('database open blocked'));
  });
}

export class Store {
  // deps: { indexedDB, mirror: {get(key), set(key, value)}, now: () => ms, dbName }
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || (() => Date.now());
    this.db = null;
    this.state = emptyState();
    this.health = { ok: true, problems: [], recoveredFrom: null, openedAt: null };
    this.listeners = new Set();
    this._chain = Promise.resolve(); // serializes writes
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(this.state); } catch { /* listener bugs never break storage */ } } }
  _problem(msg) { this.health.ok = false; this.health.problems.push({ at: this.now(), msg }); }

  async open() {
    this.db = await openDb(this.deps.indexedDB, this.deps.dbName || DB_NAME);
    const fromDb = await this._loadFromDb();
    const fromMirror = await this._loadMirror();
    let state = fromDb;
    if (fromMirror && fromMirror.seq > fromDb.seq) {
      // Primary is behind (lost or damaged). Never discard the mirror: restore from it and
      // write it back into the primary as a checkpoint.
      state = fromMirror;
      this.health.recoveredFrom = 'mirror';
      this._problem(`Main storage was behind the backup copy (${fromDb.seq} < ${fromMirror.seq}); restored from the backup copy.`);
      await this._writeCheckpoint(state);
    }
    this.state = state;
    if (!fromMirror || fromMirror.seq !== state.seq) await this._writeMirror();
    this.health.openedAt = this.now();
    return this;
  }

  async _loadFromDb() {
    const tx = this.db.transaction(['checkpoints', 'events'], 'readonly');
    const cps = await req(tx.objectStore('checkpoints').getAll());
    const evs = await req(tx.objectStore('events').getAll());
    // newest checkpoint that verifies
    let base = null;
    for (const cp of cps.sort((a, b) => b.seq - a.seq)) {
      if (verify(cp)) { base = cp; break; }
      this._problem(`A saved checkpoint (#${cp.seq}) failed its integrity check and was skipped (kept on disk).`);
    }
    let state = base ? JSON.parse(JSON.stringify(base.state)) : emptyState();
    const startSeq = base ? base.seq : 0;
    let expected = startSeq + 1;
    for (const ev of evs.sort((a, b) => a.seq - b.seq)) {
      if (ev.seq <= startSeq) continue;
      if (!verify(ev)) {
        this._problem(`Change #${ev.seq} failed its integrity check; later changes were not applied. Nothing was deleted.`);
        break;
      }
      if (ev.seq !== expected) {
        this._problem(`Changes are missing between #${expected - 1} and #${ev.seq}.`);
        // still apply: a gap means a lost event, not a reason to drop later good data
      }
      applyEvent(state, ev);
      expected = ev.seq + 1;
    }
    // If a damaged change stopped the replay, later changes still exist on disk. Continue numbering
    // after the highest one so new writes never collide with them (they stay on disk for recovery).
    const maxKey = evs.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0);
    if (maxKey > state.seq) state.seq = maxKey;
    return state;
  }

  async _loadMirror() {
    if (!this.deps.mirror) return null;
    try {
      const m = await this.deps.mirror.get('nlt_mirror');
      if (!m) return null;
      if (!verify(m)) { this._problem('The backup copy failed its integrity check and was ignored.'); return null; }
      return m.state;
    } catch (e) {
      this._problem('Could not read the backup copy: ' + (e && e.message));
      return null;
    }
  }

  async _writeMirror() {
    if (!this.deps.mirror) return;
    try {
      await this.deps.mirror.set('nlt_mirror', sealed({ seq: this.state.seq, at: this.now(), state: this.state }));
    } catch (e) {
      this._problem('Could not update the backup copy: ' + (e && e.message));
    }
  }

  async _writeCheckpoint(state) {
    const cp = sealed({ seq: state.seq, at: this.now(), state });
    const tx = this.db.transaction(['checkpoints'], 'readwrite', { durability: 'strict' });
    tx.objectStore('checkpoints').put(cp);
    await txDone(tx);
    // read back and verify before trusting it
    const tx2 = this.db.transaction(['checkpoints'], 'readonly');
    const back = await req(tx2.objectStore('checkpoints').get(cp.seq));
    if (!verify(back) || canonical(back.state) !== canonical(state)) throw new Error('checkpoint verify failed');
    return cp;
  }

  // Append one change. Resolves only after the change is durably committed AND mirrored.
  append(type, payload) {
    const run = async () => {
      const ev = sealed({ seq: this.state.seq + 1, ts: this.now(), type, payload });
      const tx = this.db.transaction(['events'], 'readwrite', { durability: 'strict' });
      tx.objectStore('events').add(ev); // add (not put): never overwrite an existing seq
      await txDone(tx);
      applyEvent(this.state, ev);
      await this._writeMirror();
      if (this.state.seq % CHECKPOINT_EVERY === 0) await this.compact().catch((e) => this._problem('Compaction skipped: ' + e.message));
      this._emit();
      return ev;
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  // Write a verified checkpoint; delete only events covered by KEEP_CHECKPOINTS newer checkpoints.
  async compact() {
    await this._writeCheckpoint(this.state);
    const tx = this.db.transaction(['checkpoints'], 'readonly');
    const cps = (await req(tx.objectStore('checkpoints').getAll())).filter(verify).sort((a, b) => b.seq - a.seq);
    if (cps.length < KEEP_CHECKPOINTS) return { deletedEvents: 0, deletedCheckpoints: 0 };
    // An event may be deleted only when KEEP_CHECKPOINTS verified checkpoints already contain it,
    // i.e. its seq <= the KEEP_CHECKPOINTS-th newest checkpoint. Events after that stay, so we can
    // always fall back to any of the kept checkpoints and replay forward.
    const floor = cps[KEEP_CHECKPOINTS - 1].seq;
    const tx2 = this.db.transaction(['events', 'checkpoints'], 'readwrite', { durability: 'strict' });
    const evStore = tx2.objectStore('events');
    let deletedEvents = 0;
    let deletedCheckpoints = 0;
    const keys = await req(evStore.getAllKeys());
    for (const k of keys) if (k <= floor) { evStore.delete(k); deletedEvents++; }
    // keep KEEP_CHECKPOINTS + 1 checkpoints (one spare beyond the floor)
    for (const cp of cps.slice(KEEP_CHECKPOINTS + 1)) { tx2.objectStore('checkpoints').delete(cp.seq); deletedCheckpoints++; }
    await txDone(tx2);
    return { deletedEvents, deletedCheckpoints };
  }

  // ---------- convenience operations ----------
  saveSession(session) { return this.append('session.save', { session }); }
  rename(id, name) { return this.append('session.rename', { id, name }); }
  update(id, fields) { return this.append('session.update', { id, fields }); }
  trash(id) { return this.append('session.trash', { id }); }
  untrash(id) { return this.append('session.untrash', { id }); }
  purge(id) { return this.append('session.purge', { id }); }
  setMeta(key, value) { return this.append('meta.set', { key, value }); }

  sessions({ includeTrash = false } = {}) {
    return Object.values(this.state.sessions)
      .filter((s) => includeTrash || !s.trashedAt)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  // ---------- backups ----------
  exportBackup(meta = {}) {
    const body = { format: BACKUP_FORMAT, version: 1, createdAt: this.now(), seq: this.state.seq, meta, state: this.state };
    return sealed(body);
  }

  // Merge a backup in. Never deletes or overwrites newer local data. Returns counts.
  async importBackup(backup) {
    if (!backup || backup.format !== BACKUP_FORMAT) throw new Error('Not a Never Lose Codes backup');
    if (!verify(backup)) throw new Error('Backup file is damaged (integrity check failed); nothing was changed');
    const toWrite = mergeSessions(this.state.sessions, backup.state.sessions || {});
    for (const s of toWrite) await this.saveSession(s);
    return { added: toWrite.length, total: Object.keys(backup.state.sessions || {}).length };
  }

  async close() { await this._chain; if (this.db) this.db.close(); }
}

export { crc32 };
