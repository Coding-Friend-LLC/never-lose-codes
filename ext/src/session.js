// Opening the vault from an extension page. States: 'setup' (first run), 'open', 'locked' (app password
// required), 'recovery' (this browser lost its device key: the recovery key gets everything back).
import { Vault } from '../lib/vault.js';
import { b64, unb64 } from '../lib/crypto.js';
import { verifyKey, entitlement } from '../lib/license.js';
import { lockMinutes, lockExpiry, unlockIsLive, alarmTime, effectiveExpiry } from '../lib/autolock.js';

export const mirror = {
  async get(k) { const r = await chrome.storage.local.get(k); return r[k]; },
  async set(k, v) { await chrome.storage.local.set({ [k]: v }); },
};

export async function openVault() {
  const vault = await new Vault({ indexedDB: self.indexedDB, mirror }).open();
  if (!vault.isSetUp) return { vault, state: 'setup' };
  if (!vault.keys.device && vault.keys.password) { // a password is set: nothing opens without it
    const s = await readUnlock();
    if (s) {
      try {
        vault.vk = await crypto.subtle.importKey('raw', unb64(s.raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
        return { vault, state: 'open' };
      } catch { await forgetUnlock(); vault.vk = null; } // damaged entry: drop it and ask for the password
    }
    return { vault, state: 'locked' };
  }
  try { await vault.unlock(); return { vault, state: 'open' }; }
  catch (e) { if (String(e.message).includes('DEVICE_KEY_MISSING')) return { vault, state: 'recovery' }; throw e; }
}

// Plan in effect right now: trial, free or pro (license keys are checked locally, offline).
export async function currentEntitlement() {
  const r = await chrome.storage.local.get(['nlc_license', 'nlc_installedAt']);
  let licensed = null;
  if (r.nlc_license && r.nlc_license.key) { const v = await verifyKey(r.nlc_license.key); if (v.ok) licensed = v.payload; }
  return entitlement({ installedAt: r.nlc_installedAt || null, licensed });
}

// How long a password unlock lasts: your choice on Pro (and during the trial), 15 minutes otherwise.
export async function autoLockMinutes(ent) {
  const e = ent || await currentEntitlement();
  const saved = (await chrome.storage.local.get('nlc_autoLock')).nlc_autoLock;
  return lockMinutes(saved, e.can('autoLockOptions'));
}

// keep a password unlock open for a while (session storage is cleared when Chrome closes)
export async function rememberUnlock(vault, minutes) {
  const m = minutes == null ? await autoLockMinutes() : minutes;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', vault.vk));
  const now = Date.now();
  const s = { raw: b64(raw), exp: lockExpiry(now, m), at: now };
  await chrome.storage.session.set({ nlc_vk: s });
  await scheduleAutoLock(s);
}

// The remembered unlock if it is still valid. An expired one is DELETED here, so the key never
// outlives the timer (editing the expiry in developer tools then has nothing to open).
export async function readUnlock(ent) {
  const s = (await chrome.storage.session.get('nlc_vk')).nlc_vk;
  if (!s) return null;
  const e = ent || await currentEntitlement();
  if (unlockIsLive(s, e.can('autoLockOptions'))) return s;
  await forgetUnlock();
  return null;
}

// When this unlock ends (ms since epoch), for the page's own exact timer. 0 = not unlocked.
export async function unlockEndsAt(ent) {
  const s = await readUnlock(ent);
  if (!s) return 0;
  const e = ent || await currentEntitlement();
  return effectiveExpiry(s, e.can('autoLockOptions'));
}

// Ask the background to drop the key when the timer runs out, even if no page is open.
export async function scheduleAutoLock(s, ent) {
  const e = ent || await currentEntitlement();
  const t = alarmTime(s, e.can('autoLockOptions'), e.trial && e.trial.inTrial ? e.trial.endsAt : null);
  if (t == null) { await chrome.alarms.clear('autolock'); return; }
  await chrome.alarms.create('autolock', { when: Math.max(t, Date.now() + 1000) });
}

// Background: on the alarm and whenever the worker starts. Drops an expired key, else re-arms.
export async function sweepUnlock() {
  const s = await readUnlock();
  if (s) await scheduleAutoLock(s); else await chrome.alarms.clear('autolock');
  return !!s;
}

export async function forgetUnlock() { await chrome.storage.session.remove('nlc_vk'); await chrome.alarms.clear('autolock').catch?.(() => {}); }

export function changed() { chrome.runtime.sendMessage({ type: 'changed' }).catch?.(() => {}); }
