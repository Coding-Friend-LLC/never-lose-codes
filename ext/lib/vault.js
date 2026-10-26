// The encrypted vault: accounts sealed with the vault key (VK), stored in the crash-safe journal.
// The journal only ever holds ciphertext + wrapped keys, never a readable secret.
import { Store } from './store.js';
import { newVaultKey, seal, open, wrapWithSecret, unwrapWithSecret, newDeviceKey, wrapWithDevice, unwrapWithDevice, newRecoveryKey } from './crypto.js';
import { sealed, verify } from './checksum.js';
import { validateAccount } from './otp.js';

export const BACKUP_FORMAT = 'nlc-backup';
const KEY_DB = 'nlc-keys';

// The device key is a non-extractable CryptoKey kept in its own IndexedDB store.
function keyDb(indexedDB) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(KEY_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kget(indexedDB, name) {
  const db = await keyDb(indexedDB);
  return new Promise((res, rej) => { const t = db.transaction('k').objectStore('k').get(name); t.onsuccess = () => { res(t.result); db.close(); }; t.onerror = () => rej(t.error); });
}
async function kdel(indexedDB, name) {
  const db = await keyDb(indexedDB);
  return new Promise((res, rej) => { const tx = db.transaction('k', 'readwrite', { durability: 'strict' }); tx.objectStore('k').delete(name); tx.oncomplete = () => { res(); db.close(); }; tx.onerror = () => rej(tx.error); });
}
async function kput(indexedDB, name, value) {
  const db = await keyDb(indexedDB);
  return new Promise((res, rej) => { const tx = db.transaction('k', 'readwrite', { durability: 'strict' }); tx.objectStore('k').put(value, name); tx.oncomplete = () => { res(); db.close(); }; tx.onerror = () => rej(tx.error); });
}

let idc = 0;
const newId = () => `a-${Date.now().toString(36)}-${(++idc).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export class Vault {
  constructor(deps) { this.deps = deps; this.store = new Store(deps); this.vk = null; }

  async open() { await this.store.open(); return this; }
  get keys() { return this.store.state.meta.keys || null; }
  get isSetUp() { return !!(this.keys && this.keys.recovery); }
  get locked() { return !this.vk; }
  get hasPassword() { return !!(this.keys && this.keys.password && !this.keys.device); }

  // First run: make the vault key, the device key and the recovery key. Returns the recovery key
  // (shown to the user exactly once).
  async setup() {
    if (this.isSetUp) throw new Error('Already set up');
    const vk = await newVaultKey();
    const dk = await newDeviceKey();
    await kput(this.deps.indexedDB, 'device', dk);
    const rk = newRecoveryKey();
    const keys = { device: await wrapWithDevice(vk, dk), recovery: await wrapWithSecret(vk, rk, 'recovery'), createdAt: this.store.now() };
    await this.store.setMeta('keys', keys);
    this.vk = vk;
    return rk;
  }

  // Unlock with the device key (no password needed unless the user asked for one).
  async unlock({ password } = {}) {
    if (!this.isSetUp) throw new Error('Not set up');
    if (!this.keys.device) { // a password is set: there is no device wrap at all (nothing opens without it)
      if (!this.keys.password) throw new Error('DEVICE_KEY_MISSING');
      if (!password) throw new Error('Password required');
      this.vk = await unwrapWithSecret(this.keys.password, password);
      return this;
    }
    const dk = await kget(this.deps.indexedDB, 'device');
    if (!dk) throw new Error('DEVICE_KEY_MISSING'); // browser data was cleared: unlock with the recovery key
    this.vk = await unwrapWithDevice(this.keys.device, dk);
    return this;
  }

  // Lost device key or forgotten password: the recovery key always works. Re-creates the device wrap.
  async unlockWithRecovery(recoveryKey) {
    this.vk = await unwrapWithSecret(this.keys.recovery, recoveryKey);
    // Recovery means the password (if any) is forgotten or this browser lost its key: go back to
    // device unlock. The user can set a new password in Settings.
    const dk = await newDeviceKey();
    const keys = { ...this.keys, device: await wrapWithDevice(this.vk, dk) };
    delete keys.password; delete keys.requirePassword;
    await this.store.setMeta('keys', keys); // write the wrap first, then the key it needs
    await kput(this.deps.indexedDB, 'device', dk);
    return this;
  }

  async setPassword(password, { require = true } = {}) {
    this.mustBeOpen();
    if (String(password).length < 8) throw new Error('Use at least 8 characters.');
    // With a password, the device wrap and device key are REMOVED: nothing on disk opens the vault
    // without the password (or the recovery key).
    const keys = { ...this.keys, password: await wrapWithSecret(this.vk, password, 'password') };
    delete keys.device; delete keys.requirePassword;
    await this.store.setMeta('keys', keys);
    await kdel(this.deps.indexedDB, 'device');
    void require;
  }
  async removePassword() {
    this.mustBeOpen();
    const dk = await newDeviceKey();
    const keys = { ...this.keys, device: await wrapWithDevice(this.vk, dk) };
    delete keys.password; delete keys.requirePassword;
    await this.store.setMeta('keys', keys);
    await kput(this.deps.indexedDB, 'device', dk);
  }

  // New recovery key (old one stops working). Returns it for one-time display.
  async newRecoveryKey() {
    this.mustBeOpen();
    const rk = newRecoveryKey();
    await this.store.setMeta('keys', { ...this.keys, recovery: await wrapWithSecret(this.vk, rk, 'recovery') });
    return rk;
  }

  // Re-check the app password before showing secrets (export). Without a password there is nothing to check.
  async verifyPassword(password) {
    if (!this.hasPassword) return true;
    try { await unwrapWithSecret(this.keys.password, String(password || '')); return true; } catch { return false; }
  }

  lock() { this.vk = null; }
  mustBeOpen() { if (!this.vk) throw new Error('Locked'); }

  // ---- accounts ----
  async addAccount(acct) {
    this.mustBeOpen();
    acct = validateAccount(acct);
    const id = acct.id || newId();
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') throw new Error('Bad id');
    const box = await seal(this.vk, { ...acct, id }, 'acct:' + id);
    await this.store.saveSession({ id, kind: 'account', box, windows: [] });
    return id;
  }
  async updateAccount(id, fields) {
    const cur = (await this.accounts({ includeTrash: true })).find((a) => a.id === id);
    if (!cur) throw new Error('Not found');
    if (cur.broken) throw new Error('This account can’t be opened, so it won’t be changed. Restore it from a backup.');
    const { trashedAt, createdAt, updatedAt, broken, ...rest } = cur;
    await this.addAccount({ ...rest, ...fields, id });
    if (trashedAt) await this.trash(id); // editing never pulls an account out of Trash
    return id;
  }
  // Several edits at once (drag-to-reorder): decrypts the list ONCE, then writes each changed account.
  // fields: { id: { ...fields } }. Unknown ids and broken records are skipped. Returns how many changed.
  async updateAccounts(changes) {
    const all = await this.accounts({ includeTrash: true });
    let n = 0;
    for (const [id, fields] of Object.entries(changes || {})) {
      const cur = all.find((a) => a.id === id);
      if (!cur || cur.broken) continue;
      const { trashedAt, createdAt, updatedAt, broken, ...rest } = cur;
      await this.addAccount({ ...rest, ...fields, id });
      if (trashedAt) await this.trash(id);
      n++;
    }
    return n;
  }
  trash(id) { return this.store.trash(id); }
  untrash(id) { return this.store.untrash(id); }

  async accounts({ includeTrash = false } = {}) {
    this.mustBeOpen();
    const out = [];
    for (const r of this.store.sessions({ includeTrash })) {
      if (r.kind !== 'account' || !r.box) continue;
      try { out.push({ ...(await open(this.vk, r.box, 'acct:' + r.id)), createdAt: r.createdAt, updatedAt: r.updatedAt, trashedAt: r.trashedAt || null }); }
      catch { out.push({ id: r.id, broken: true, createdAt: r.createdAt, trashedAt: r.trashedAt || null }); }
    }
    return out;
  }

  // ---- encrypted backups (open on any computer with the recovery key) ----
  // Needs NO unlock: every record is already sealed with the vault key, so the background can write
  // backups even when the app is locked. Only the recovery wrap of the vault key is included: no
  // device wrap (useless elsewhere) and no password wrap (nothing extra to guess offline).
  exportBackup(meta = {}) {
    const st = JSON.parse(JSON.stringify(this.store.state));
    st.meta = { keys: { recovery: this.keys.recovery } };
    const count = Object.values(st.sessions).filter((r) => r.kind === 'account' && !r.trashedAt).length;
    return sealed({ format: BACKUP_FORMAT, v: 1, createdAt: this.store.now(), count, state: st, meta });
  }

  // Restore a backup into this vault. Never deletes or overwrites newer local data. Accounts from the
  // backup are re-sealed with THIS vault's key, so old and new codes open with one key.
  async restoreBackup(backup, recoveryKey) {
    if (!backup || backup.format !== BACKUP_FORMAT) throw new Error('That isn’t a Never Lose Codes backup file.');
    if (!verify(backup)) throw new Error('That backup file is damaged or was altered. Nothing was changed. Try an older backup.');
    const rwrap = backup.state && backup.state.meta && backup.state.meta.keys && backup.state.meta.keys.recovery;
    if (!rwrap) throw new Error('That backup file is damaged. Nothing was changed. Try an older backup.');
    const bvk = await unwrapWithSecret(rwrap, recoveryKey);
    const records = Object.values(backup.state.sessions || {}).filter((r) => r.kind === 'account' && r.box);
    // decrypt everything first: a bad record aborts before anything is written
    const plain = [];
    for (const r of records) plain.push({ r, acct: await open(bvk, r.box, 'acct:' + r.id) });
    if (!this.isSetUp) { // fresh install: adopt the backup's vault key and recovery wrap
      this.vk = bvk;
      const dk = await newDeviceKey();
      await kput(this.deps.indexedDB, 'device', dk);
      await this.store.setMeta('keys', { device: await wrapWithDevice(bvk, dk), recovery: rwrap, createdAt: this.store.now(), restoredAt: this.store.now() });
    }
    this.mustBeOpen();
    // Restore only ADDS. It never overwrites, rolls back or trashes an account you already have:
    // timestamps and Trash marks in a backup file are not authenticated, so they are not trusted.
    const mine = await this.accounts({ includeTrash: true });
    const same = (a, b) => a.secret === b.secret && (a.issuer || '') === (b.issuer || '') && (a.account || '') === (b.account || '');
    let added = 0;
    for (const { r, acct } of plain) {
      if (mine.some((m) => same(m, acct))) continue; // already have this exact account
      const clash = mine.some((m) => m.id === r.id);
      await this.addAccount({ ...acct, id: clash ? undefined : r.id }); // id clash: add as a separate copy
      added++;
    }
    return { added, total: records.length };
  }

  // Integrity drill: structure of the recovery wrap + every record decrypts with the live key.
  // (The recovery key itself can only be tested by the user typing it: see testRecoveryKey.)
  async selfTest() {
    const w = this.keys && this.keys.recovery;
    if (!w || w.kdf !== 'PBKDF2-SHA256' || !(w.iterations >= 600000 && w.iterations <= 5000000) || !w.salt || !w.iv || !w.ct) return { ok: false, error: 'recovery wrap invalid' };
    const recs = this.store.sessions({ includeTrash: true }).filter((r) => r.kind === 'account');
    if (!this.vk) return { ok: true, partial: true, count: recs.length };
    let n = 0;
    for (const r of recs) {
      try { await open(this.vk, r.box, 'acct:' + r.id); n++; } catch { return { ok: false, error: 'record ' + r.id + ' does not decrypt', count: recs.length, decrypted: n }; }
    }
    return { ok: true, count: recs.length, decrypted: n };
  }
  async testRecoveryKey(recoveryKey) {
    try { await unwrapWithSecret(this.keys.recovery, recoveryKey); return true; } catch { return false; }
  }

  close() { return this.store.close(); }
}
