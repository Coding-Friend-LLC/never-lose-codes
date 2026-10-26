import { el, toast } from './common.js';
import { openVault, rememberUnlock, forgetUnlock, readUnlock, unlockEndsAt, changed, currentEntitlement } from './session.js';
import { MAX_TIMER } from '../lib/autolock.js';
import { sortAccounts, filterAccounts, badge } from '../lib/organize.js';
import { codeFor, prettyCode, secondsLeft, label } from './codes.js';

const $ = (id) => document.getElementById(id);
const openPage = (hash = '') => chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html' + hash) });
$('open').onclick = () => openPage();
$('add').onclick = () => openPage('#add');

let accts = [], vault, query = '', colored = false, tick = null, lockTimer = null, ent = null;

function status(level, text) { $('status').className = 'pill ' + level; $('status').lastChild.textContent = text; }

async function start() {
  const r = await openVault();
  vault = r.vault;
  if (r.state === 'setup') { status('wait', 'Not set up'); $('body').replaceChildren(el('div', { class: 'center' }, el('b', {}, 'Set up takes one minute'), el('div', { class: 'small muted' }, 'You’ll get a recovery key, so you can never be locked out.'), el('button', { class: 'btn primary', onclick: () => openPage('#setup') }, 'Set up Never Lose Codes'))); return; }
  if (r.state === 'recovery') { status('bad', 'Needs recovery key'); $('body').replaceChildren(el('div', { class: 'center' }, el('b', {}, 'This browser’s key was cleared'), el('div', { class: 'small muted' }, 'Your codes are safe. Enter your recovery key once to open them.'), el('button', { class: 'btn primary', onclick: () => openPage('#recover') }, 'Enter recovery key'))); return; }
  ent = await currentEntitlement();
  colored = ent.can('icons');
  if (r.state === 'locked') return lockedView();
  status('ok', 'Protected');
  accts = (await vault.accounts()).filter((a) => !a.broken);
  render();
  armAutoLock();
}

// Auto-lock in the popup too: at the exact expiry, drop the key and the decrypted codes.
async function autoLock() {
  clearInterval(tick); clearTimeout(lockTimer);
  accts = [];
  await forgetUnlock();
  if (vault) vault.lock();
  lockedView();
}
async function armAutoLock() {
  clearTimeout(lockTimer);
  if (!vault || !vault.hasPassword) return;
  const ends = await unlockEndsAt(ent || undefined);
  if (!ends) return autoLock();
  if (ends !== Number.MAX_SAFE_INTEGER) lockTimer = setTimeout(autoLock, Math.min(MAX_TIMER, Math.max(0, ends - Date.now())));
}

function lockedView() {
  status('wait', 'Locked');
  const pw = el('input', { type: 'password', placeholder: 'App password', 'aria-label': 'App password', autofocus: true });
  const err = el('div', { class: 'small', style: 'color:var(--warn); min-height:16px' });
  const go = async () => {
    try { await vault.unlock({ password: pw.value }); pw.value = ''; await rememberUnlock(vault); accts = (await vault.accounts()).filter((a) => !a.broken); status('ok', 'Protected'); render(); armAutoLock(); }
    catch (e) { err.textContent = e.message; }
  };
  pw.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('body').replaceChildren(el('div', { class: 'center' }, el('b', {}, 'Unlock your codes'), pw, el('button', { class: 'btn primary', onclick: go }, 'Unlock'), err, el('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); openPage('#recover'); } }, 'Forgot it? Use your recovery key')));
  setTimeout(() => pw.focus(), 50);
}

function avatar(a) { const b = badge(a, { colored }); return el('span', { class: 'badge-av' + (b.color ? '' : ' plain'), style: b.color ? `background:${b.color}` : null, 'aria-hidden': 'true' }, b.letter); }

function render() {
  const search = el('input', { placeholder: 'Search accounts…', value: query, 'aria-label': 'Search accounts', oninput: (e) => { query = e.target.value.toLowerCase(); draw(); } });
  const list = el('div', { id: 'list' });
  $('body').replaceChildren(el('div', { class: 'searchbox' }, search), list);
  setTimeout(() => search.focus(), 30);
  async function draw() {
    const now = Date.now();
    const shown = sortAccounts(filterAccounts(accts, { query }));
    if (!accts.length) { list.replaceChildren(el('div', { class: 'center' }, el('b', {}, 'No accounts yet'), el('button', { class: 'btn primary', onclick: () => openPage('#add') }, 'Add your first account'))); return; }
    const rows = [];
    for (const a of shown) {
      const code = await codeFor(a, now).catch(() => '------');
      const left = secondsLeft(a.period || 30, now), frac = left / (a.period || 30);
      const ring = a.type === 'hotp' ? '' : el('span');
      if (ring) ring.innerHTML = `<svg class="ring${left <= 5 ? ' low' : ''}" viewBox="0 0 22 22" aria-label="${left} seconds left"><circle class="bg" cx="11" cy="11" r="8"/><circle class="fg" cx="11" cy="11" r="8" stroke-dasharray="${(2 * Math.PI * 8).toFixed(2)}" stroke-dashoffset="${((1 - frac) * 2 * Math.PI * 8).toFixed(2)}"/></svg>`;
      rows.push(el('button', { class: 'acct', title: 'Click to copy', onclick: async () => {
        try { await navigator.clipboard.writeText(code); toast(`Copied ${label(a)} code`); }
        catch { toast('Could not copy. Select the code and press Ctrl+C'); }
        if (a.type === 'hotp') { await vault.updateAccount(a.id, { counter: (a.counter || 0) + 1 }); changed(); accts = (await vault.accounts()).filter((x) => !x.broken); }
      } }, avatar(a), el('div', { class: 'who' }, el('div', { class: 'iss ellipsis' }, (a.pinned ? '📌 ' : '') + label(a)), el('div', { class: 'small muted ellipsis' }, a.account || '')), el('div', { class: 'code' }, prettyCode(code)), ring));
    }
    list.replaceChildren(...(rows.length ? rows : [el('div', { class: 'center muted small' }, 'No matches')]));
  }
  draw();
  clearInterval(tick);
  tick = setInterval(async () => {
    if (vault && vault.hasPassword && !(await readUnlock(ent || undefined))) return autoLock(); // backstop: expired key is deleted
    draw();
  }, 1000);
}

start().catch((e) => { status('bad', 'Error'); $('body').replaceChildren(el('div', { class: 'center small' }, e.message)); });
