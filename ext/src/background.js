// Never Lose Codes: background service worker. It never needs to decrypt anything: backups are made
// from records that are already encrypted. No network access of any kind.
import { Vault } from '../lib/vault.js';
import { planRotation, backupFileName } from '../lib/rotation.js';
import { sweepUnlock } from './session.js';

const mirror = {
  async get(k) { const r = await chrome.storage.local.get(k); return r[k]; },
  async set(k, v) { await chrome.storage.local.set({ [k]: v }); },
};
async function local(key, fallback) { const r = await chrome.storage.local.get(key); return r[key] ?? fallback; }
async function setLocal(obj) { await chrome.storage.local.set(obj); }

// open a fresh vault view each time (pages are the writers; this always reads the latest journal)
async function freshVault() { return new Vault({ indexedDB: self.indexedDB, mirror }).open(); }

async function writeBackupFile(reason = 'scheduled') {
  const v = await freshVault();
  try {
    if (!v.isSetUp) return { skipped: 'not set up' };
    const lastSeq = await local('nlc_backupSeq', -1);
    if (reason === 'scheduled' && v.store.state.seq === lastSeq) return { skipped: 'no changes' };
    const backup = v.exportBackup({ reason, app: chrome.runtime.getManifest().version });
    const json = JSON.stringify(backup);
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const at = Date.now();
    try { await chrome.downloads.setUiOptions({ enabled: false }); } catch { /* bubble shows on old Chrome */ }
    let downloadId;
    try {
      downloadId = await chrome.downloads.download({ url: 'data:application/json;base64,' + btoa(bin), filename: backupFileName(at, 'NeverLoseCodes', 'nlc-backup'), saveAs: false, conflictAction: 'uniquify' });
    } finally { setTimeout(() => chrome.downloads.setUiOptions({ enabled: true }).catch(() => {}), 3000); }
    const list = await local('nlc_backups', []);
    list.push({ id: downloadId, at, seq: v.store.state.seq, count: backup.count, size: bytes.length, verified: false });
    await setLocal({ nlc_backups: list, nlc_backupSeq: v.store.state.seq });
    return { downloadId, count: backup.count };
  } finally { await v.close(); }
}

chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state || d.state.current !== 'complete') return;
  const list = await local('nlc_backups', []);
  const b = list.find((x) => x.id === d.id);
  if (!b) return;
  const [item] = await chrome.downloads.search({ id: d.id });
  b.verified = !!(item && item.exists && item.fileSize === b.size);
  b.file = item && item.filename;
  await setLocal({ nlc_backups: list, ...(b.verified ? { nlc_lastBackupOk: b.at } : {}) });
  if (b.verified) {
    const { keep, remove } = planRotation(list, Date.now());
    for (const id of remove) { await chrome.downloads.removeFile(id).catch(() => {}); await chrome.downloads.erase({ id }).catch(() => {}); }
    await setLocal({ nlc_backups: list.filter((x) => keep.includes(x.id)) });
  }
});

async function selfTest() {
  const v = await freshVault();
  try {
    if (!v.isSetUp) return null;
    await v.unlock().catch(() => {}); // works unless an app password is required; then structure-only
    const r = await v.selfTest();
    await setLocal({ nlc_selfTest: { at: Date.now(), ...r } });
    return r;
  } finally { v.lock(); await v.close(); }
}

let changeTimer = null;
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  const run = async () => {
    if (msg.type === 'changed') { clearTimeout(changeTimer); changeTimer = setTimeout(() => writeBackupFile('change').catch(() => {}), 8000); return true; }
    if (msg.type === 'backupNow') return writeBackupFile('manual');
    if (msg.type === 'selfTest') return selfTest();
    if (msg.type === 'status') return { lastBackupOk: await local('nlc_lastBackupOk', null), backups: (await local('nlc_backups', [])).length, selfTest: await local('nlc_selfTest', null), installedAt: await local('nlc_installedAt', null) };
    throw new Error('unknown');
  };
  run().then((r) => reply({ ok: true, result: r }), (e) => reply({ ok: false, error: e.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(async (info) => {
  chrome.alarms.create('backup', { periodInMinutes: 24 * 60 });
  chrome.alarms.create('selftest', { periodInMinutes: 7 * 24 * 60 });
  chrome.runtime.setUninstallURL('https://codingfriendllc.com/never-lose-codes/uninstalled/').catch(() => {});
  if (info.reason === 'install') {
    await setLocal({ nlc_installedAt: Date.now() });
    chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html#setup') });
  }
  if (info.reason === 'update') await writeBackupFile('before-update').catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'backup') await writeBackupFile('scheduled').catch(() => {});
  if (a.name === 'selftest') await selfTest().catch(() => {});
  if (a.name === 'autolock') await sweepUnlock().catch(() => {});
});

// Auto-lock: whenever this worker starts, drop a password unlock whose time is up (and re-arm the
// alarm for one that isn't). The key never outlives the timer, with or without a page open.
sweepUnlock().catch(() => {});
