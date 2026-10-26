import { el, toast, plural } from './common.js';
import { openVault, rememberUnlock, forgetUnlock, changed, autoLockMinutes, readUnlock, unlockEndsAt, scheduleAutoLock } from './session.js';
import { codeFor, prettyCode, secondsLeft, label, accountsFromText, qrFromImage, scanFromVideo } from './codes.js';
import { looksLikeRecoveryKey } from '../lib/crypto.js';
import { entitlement, verifyKey, PRICE_LABEL, BUY_URL } from '../lib/license.js';
import { timeAgo } from '../lib/status.js';
import { sortAccounts, filterAccounts, groupNames, moveAccount, cleanOrganize, badge, BADGE_COLORS } from '../lib/organize.js';
import { migrationBatches, singleUri, textExport, fitsOneQr } from '../lib/export.js';
import { LOCK_CHOICES, lockLabel, adjustedExpiry, MAX_TIMER } from '../lib/autolock.js';

const main = document.getElementById('main');
let V = null, STATE = null, ACCTS = [], STATUS = {}, LOCK_NOW = 15;
const view = () => (location.hash.replace('#', '') || 'codes');
const bg = (type) => new Promise((res) => chrome.runtime.sendMessage({ type }, (r) => res(r && r.ok ? r.result : null)));

async function load() {
  const r = await openVault();
  V = r.vault; STATE = r.state;
  STATUS = (await bg('status')) || {};
  ACCTS = STATE === 'open' ? (await V.accounts({ includeTrash: true })).filter((a) => !a.broken) : [];
  await route();
  await armAutoLock();
}
const live = () => ACCTS.filter((a) => !a.trashedAt);

async function license() { const l = (await chrome.storage.local.get('nlc_license')).nlc_license; if (!l) return null; const r = await verifyKey(l.key); return r.ok ? r.payload : null; }
let LIC = null;
const ENT = () => entitlement({ installedAt: STATUS.installedAt, licensed: LIC });

function nav() {
  for (const a of document.querySelectorAll('nav a[data-view]')) a.classList.toggle('on', a.dataset.view === view());
  document.getElementById('c-codes').textContent = live().length || '';
  document.getElementById('c-trash').textContent = ACCTS.filter((a) => a.trashedAt).length || '';
  const e = ENT(); document.getElementById('c-plan').textContent = e.tier === 'pro' ? 'Pro' : e.tier === 'trial' ? e.trial.daysLeft + 'd trial' : 'Free';
  const ok = !!STATUS.lastBackupOk && Date.now() - STATUS.lastBackupOk < 26 * 3600e3;
  document.getElementById('guard').replaceChildren(
    el('span', { class: 'pill ' + (STATE !== 'open' ? 'wait' : ok ? 'ok' : 'wait') }, el('span', { class: 'dot' }), STATE === 'setup' ? 'Setting up' : STATE === 'recovery' ? 'Needs recovery key' : STATE !== 'open' ? 'Locked' : ok ? 'Protected' : 'Backup pending'),
    el('div', { class: 'small muted', style: 'margin-top:8px' }, STATUS.lastBackupOk ? 'Last backup ' + timeAgo(STATUS.lastBackupOk) : 'First backup soon'));
}

// ---------------- first run ----------------
function setupView(step = 1, rk = null) {
  const steps = el('div', { class: 'steps' }, ...[1, 2, 3].map((n) => el('span', { class: n <= step ? 'on' : '' })));
  if (step === 1) {
    main.replaceChildren(steps, el('h2', {}, 'Your 2FA codes, encrypted, with backups you hold'),
      el('div', { class: 'stack' },
        el('div', { class: 'card pad' }, el('b', {}, 'No access to the websites you visit'), el('div', { class: 'muted small' }, 'This extension can’t read or change any web page. Chrome showed no website-access warning when you installed it.')),
        el('div', { class: 'card pad' }, el('b', {}, 'Locked out? Never.'), el('div', { class: 'muted small' }, 'You’ll get a recovery key. With it, your encrypted backup files open on any computer, even if this browser is wiped or you forget your password.')),
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, el('button', { class: 'btn primary big', onclick: async () => { const k = await V.setup(); changed(); setupView(2, k); } }, 'Create my encrypted vault'),
          el('button', { class: 'btn big', onclick: () => restoreView() }, 'I have a backup file'))));
    return;
  }
  if (step === 2) {
    const confirm = el('input', { class: 'f', placeholder: 'Type the last 4 characters', 'aria-label': 'Last 4 characters of your recovery key', maxlength: 6, style: 'max-width:260px' });
    const err = el('div', { class: 'err' });
    const saveFile = () => {
      const blob = new Blob([`Never Lose Codes recovery key\n\n${rk}\n\nKeep this somewhere safe (a password manager or printed). With it, your backup files in Downloads/NeverLoseCodes open on any computer.\nCreated ${new Date().toLocaleString()}\n`], { type: 'text/plain' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'never-lose-codes-RECOVERY-KEY.txt' }); document.body.append(a); a.click(); a.remove();
    };
    main.replaceChildren(steps, el('h2', {}, 'Save your recovery key'),
      el('div', { class: 'stack' },
        el('p', { class: 'muted', style: 'margin:0' }, 'This is the one thing that can never be recovered for you. Write it down, print it, or save it in your password manager. It is shown only once.'),
        el('div', { class: 'rk', id: 'rk' }, rk),
        el('div', { class: 'row', style: 'flex-wrap:wrap' }, el('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(rk); toast('Copied'); } catch { toast('Select the key and press Ctrl+C'); } } }, 'Copy'), el('button', { class: 'btn', onclick: saveFile }, 'Save as a file')),
        el('div', { class: 'card pad stack' }, el('b', {}, 'Confirm you saved it'), confirm, err,
          el('button', { class: 'btn primary', onclick: () => {
            if (confirm.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') !== rk.replace(/-/g, '').slice(-4)) { err.textContent = 'That doesn’t match the last 4 characters. Look at the key above.'; return; }
            chrome.storage.local.set({ nlc_rkConfirmedAt: Date.now() }); setupView(3);
          } }, 'I saved it'))));
    return;
  }
  main.replaceChildren(steps, el('h2', {}, 'Add your accounts'), el('p', { class: 'muted' }, 'Bring everything from Google Authenticator in one go, or add accounts one at a time.'), addOptions());
}

function restoreView() {
  const rkIn = el('input', { class: 'f', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX', 'aria-label': 'Recovery key' });
  const file = el('input', { type: 'file', accept: '.json', 'aria-label': 'Backup file' });
  const err = el('div', { class: 'err' });
  main.replaceChildren(el('h2', {}, 'Restore from a backup file'),
    el('div', { class: 'card pad stack' },
      el('div', { class: 'muted small' }, 'Pick a file from Downloads/NeverLoseCodes (the newest one), then enter your recovery key.'),
      el('label', { class: 'l' }, 'Backup file', file), el('label', { class: 'l' }, 'Recovery key', rkIn), err,
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          if (!file.files[0]) throw new Error('Choose a backup file first.');
          const r = await V.restoreBackup(JSON.parse(await file.files[0].text()), rkIn.value);
          changed(); toast(`Restored ${plural(r.added, 'account')}`); location.hash = '#codes'; load();
        } catch (e) { err.textContent = e.message; }
      } }, 'Restore')));
}

function recoverView() {
  const rkIn = el('input', { class: 'f', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX', 'aria-label': 'Recovery key' });
  const err = el('div', { class: 'err' });
  main.replaceChildren(el('h2', {}, 'Open your codes with your recovery key'),
    el('div', { class: 'card pad stack' },
      el('div', { class: 'muted' }, STATE === 'locked' ? 'Forgot your app password? Your recovery key opens the vault. You can set a new password afterwards in Settings.' : 'This browser’s key was cleared (for example after clearing browsing data). Your encrypted codes are still here.'),
      rkIn, err,
      el('button', { class: 'btn primary', onclick: async () => {
        try { if (!looksLikeRecoveryKey(rkIn.value)) throw new Error('A recovery key has 26 letters and numbers.'); await V.unlockWithRecovery(rkIn.value); await forgetUnlock(); changed(); toast('Unlocked'); location.hash = '#codes'; load(); }
        catch (e) { err.textContent = e.message; }
      } }, 'Open my codes'),
      el('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); restoreView(); } }, 'Restore from a backup file instead')));
}

function lockedView() {
  const pw = el('input', { class: 'f', type: 'password', placeholder: 'App password', 'aria-label': 'App password' });
  const err = el('div', { class: 'err' });
  const go = async () => { try { await V.unlock({ password: pw.value }); await rememberUnlock(V); load(); } catch (e) { err.textContent = e.message; } };
  pw.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  main.replaceChildren(el('h2', {}, 'Unlock your codes'), el('div', { class: 'card pad stack', style: 'max-width:420px' }, pw, err, el('button', { class: 'btn primary', onclick: go }, 'Unlock'), el('a', { href: '#recover', class: 'small' }, 'Forgot it? Use your recovery key')));
  setTimeout(() => pw.focus(), 30);
}

// ---------------- codes ----------------
let FILTER = { query: '', group: '' };

function proPrompt(what) {
  return el('div', { class: 'card pad pro-note' }, el('b', {}, what + ' is a Pro extra.'), ' ',
    el('span', { class: 'small muted' }, `Your codes, backups and recovery stay free forever. Pro is a one-time ${PRICE_LABEL}.`), ' ',
    el('a', { href: '#plan', class: 'small' }, 'See Pro'));
}

function badgeEl(a) {
  const b = badge(a, { colored: ENT().can('icons') });
  return el('span', { class: 'badge-av' + (b.color ? '' : ' plain'), style: b.color ? `background:${b.color}` : null, 'aria-hidden': 'true' }, b.letter);
}

function codesView(trash = false) {
  const can = ENT().can('organize');
  const all = trash ? ACCTS.filter((a) => a.trashedAt) : live();
  const groups = groupNames(all);
  if (FILTER.group && !groups.includes(FILTER.group)) FILTER.group = '';
  const list = el('div', { class: 'stack' });
  const search = el('input', { class: 'f', placeholder: 'Search accounts…', value: FILTER.query, 'aria-label': 'Search accounts', oninput: (e) => { FILTER.query = e.target.value; draw(); } });
  const chips = trash || !groups.length ? '' : el('div', { class: 'chips' }, ...['', ...groups].map((g) => el('button', { class: 'chip' + (FILTER.group === g ? ' on' : ''), onclick: () => { FILTER.group = g; codesView(false); } }, g || 'All')));
  main.replaceChildren(el('div', { class: 'row', style: 'margin-bottom:12px; flex-wrap:wrap' }, el('h2', { class: 'grow', style: 'margin:0' }, trash ? 'Trash' : 'Your codes'),
    trash ? null : el('a', { class: 'btn', href: '#export' }, 'Move to phone'), trash ? null : el('a', { class: 'btn primary', href: '#add' }, '+ Add account')),
  trash ? el('p', { class: 'muted' }, 'Deleted accounts stay here for 30 days.') : el('div', { class: 'stack', style: 'margin-bottom:12px' }, all.length > 1 ? search : '', chips,
    all.length > 1 && can ? el('div', { class: 'small muted' }, 'Drag accounts to reorder. Pin favorites to the top in Edit.') : ''), list);
  let dragId = null;
  async function draw() {
    const items = sortAccounts(filterAccounts(all, trash ? {} : FILTER));
    if (!all.length) { list.replaceChildren(el('div', { class: 'card pad', style: 'text-align:center' }, el('b', {}, trash ? 'Trash is empty' : 'No accounts yet'), trash ? '' : el('div', { style: 'margin-top:10px' }, addOptions()))); return; }
    if (!items.length) { list.replaceChildren(el('div', { class: 'card pad muted small' }, 'No matches')); return; }
    const now = Date.now();
    const rows = [];
    for (const a of items) {
      const code = await codeFor(a, now).catch(() => '------');
      const row = el('div', { class: 'card acc', 'data-id': a.id, draggable: !trash && can ? 'true' : null },
        badgeEl(a),
        el('div', { class: 'grow' }, el('b', {}, a.pinned ? '📌 ' : '', label(a)), el('div', { class: 'small muted' }, a.account || '', a.group ? ` · ${a.group}` : '', a.type === 'hotp' ? ' · counter-based' : ` · new code in ${secondsLeft(a.period || 30, now)}s`)),
        trash ? null : el('button', { class: 'code btn ghost', title: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(code); toast('Copied'); } catch { toast('Select and press Ctrl+C'); } } }, prettyCode(code)),
        trash ? el('button', { class: 'btn primary', onclick: async () => { await V.untrash(a.id); changed(); toast('Put back'); load(); } }, 'Put back')
          : el('button', { class: 'btn ghost', onclick: () => editView(a) }, 'Edit'),
        trash ? null : el('button', { class: 'btn ghost danger', onclick: async () => { await V.trash(a.id); changed(); toast('Moved to Trash', { label: 'Undo', fn: async () => { await V.untrash(a.id); changed(); load(); } }); load(); } }, 'Delete'));
      if (!trash && can) {
        row.addEventListener('dragstart', (e) => { dragId = a.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.id); });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('over'); });
        row.addEventListener('dragleave', () => row.classList.remove('over'));
        row.addEventListener('drop', async (e) => {
          e.preventDefault(); row.classList.remove('over');
          const id = dragId || e.dataTransfer.getData('text/plain'); dragId = null;
          // number against the WHOLE list (not just what this filter shows), so positions never clash
          const changes = moveAccount(sortAccounts(all), id, a.id);
          const n = await V.updateAccounts(Object.fromEntries(Object.entries(changes).map(([x, order]) => [x, cleanOrganize({ order })])));
          if (n) { changed(); toast('Order saved'); load(); }
        });
      }
      rows.push(row);
    }
    list.replaceChildren(...rows);
  }
  draw();
  if (!trash) { clearInterval(window.__t); window.__t = setInterval(() => { if (view() === 'codes' && !document.querySelector('.acc.dragging')) draw(); }, 1000); }
}

function editView(a) {
  const can = ENT().can('organize'), canIcons = ENT().can('icons'), canQr = ENT().can('exportQr');
  const iss = el('input', { class: 'f', value: a.issuer || '', 'aria-label': 'Service' });
  const acc = el('input', { class: 'f', value: a.account || '', 'aria-label': 'Account' });
  const grp = el('input', { class: 'f', value: a.group || '', 'aria-label': 'Group', list: 'groups', maxlength: 40, placeholder: 'For example Work', disabled: !can || null });
  const pin = el('input', { type: 'checkbox', 'aria-label': 'Pin to top', checked: a.pinned || null, disabled: !can || null });
  let color = a.color || null;
  const swatches = el('div', { class: 'swatches' }, ...[null, ...BADGE_COLORS].map((c) => el('button', { type: 'button', class: 'sw' + (color === c ? ' on' : ''), 'aria-label': c ? 'Badge color ' + c : 'Automatic color', style: c ? `background:${c}` : null, disabled: !canIcons || null,
    onclick: (e) => { color = c; for (const s of swatches.children) s.classList.remove('on'); e.currentTarget.classList.add('on'); } }, c ? '' : 'Auto')));
  main.replaceChildren(el('h2', {}, 'Edit account'), el('div', { class: 'card pad stack', style: 'max-width:560px' },
    el('label', { class: 'l' }, 'Service (for example GitHub)', iss), el('label', { class: 'l' }, 'Account', acc),
    el('datalist', { id: 'groups' }, ...groupNames(live()).map((g) => el('option', { value: g }))),
    el('label', { class: 'l' }, 'Group (optional)', grp),
    el('label', { class: 'row small', style: 'font-weight:600' }, pin, 'Pin to the top of the list'),
    el('div', { class: 'l' }, 'Badge color', swatches),
    !can || !canIcons ? proPrompt('Organizing (groups, pins, order and colors)') : '',
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => {
      const fields = { issuer: iss.value.trim(), account: acc.value.trim() };
      if (can) Object.assign(fields, cleanOrganize({ group: grp.value, pinned: pin.checked }));
      if (canIcons) Object.assign(fields, cleanOrganize({ color }));
      await V.updateAccount(a.id, fields); changed(); toast('Saved'); location.hash = '#codes'; load();
    } }, 'Save'), el('a', { class: 'btn ghost', href: '#codes' }, 'Cancel'),
    el('span', { class: 'grow' }), canQr ? el('button', { class: 'btn ghost', onclick: () => exportView([a.id], 'single') }, 'Show QR for a phone') : '')));
}

// ---------------- move to phone / export ----------------
function drawQr(text) {
  const q = window.qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount(), quiet = 4, scale = Math.max(3, Math.floor(300 / (n + quiet * 2)));
  const c = el('canvas', { width: (n + quiet * 2) * scale, height: (n + quiet * 2) * scale, class: 'qr', role: 'img', 'aria-label': 'QR code' });
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + quiet) * scale, (r + quiet) * scale, scale, scale);
  return c;
}

// A QR code that can't hold this much text: say so, and give that account's text link instead.
function qrOrFallback(text, accts) {
  try { if (!fitsOneQr(text)) throw new Error('too long'); return drawQr(text); }
  catch {
    return el('div', { class: 'card pad stack', style: 'max-width:320px' }, el('b', {}, 'Too long for one QR code'),
      el('div', { class: 'small muted' }, 'This account’s name or key is too long to fit. Copy its text link into your phone’s app instead.'),
      el('textarea', { class: 'f mono', rows: 3, readonly: true, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Text link' }, textExport(accts)));
  }
}

function exportView(preselect = null, presetFormat = null) {
  const e = ENT();
  const accts = sortAccounts(live());
  if (!accts.length) { main.replaceChildren(el('h2', {}, 'Move accounts to your phone'), el('div', { class: 'card pad' }, 'No accounts yet.')); return; }
  const pick = new Set(preselect || accts.map((a) => a.id));
  const boxes = accts.map((a) => { const cb = el('input', { type: 'checkbox', checked: pick.has(a.id) || null, 'data-id': a.id }); return el('label', {}, cb, badgeEl(a), el('span', { class: 'grow' }, el('b', {}, label(a)), ' ', el('span', { class: 'small muted' }, a.account || ''))); });
  const fmt = (v, t, d, pro) => el('label', { class: 'card opt fmt' }, el('input', { type: 'radio', name: 'fmt', value: v, checked: (presetFormat || 'google') === v || null }), el('b', {}, t, pro && !e.can('exportQr') ? el('span', { class: 'badge', style: 'margin-left:8px' }, 'PRO') : ''), el('span', { class: 'small muted' }, d));
  const pw = V.hasPassword ? el('input', { class: 'f', type: 'password', placeholder: 'Your app password', 'aria-label': 'App password to show codes' }) : null;
  const ack = el('input', { type: 'checkbox', 'aria-label': 'I understand' });
  const err = el('div', { class: 'err' });
  const out = el('div', { id: 'export-out' });
  main.replaceChildren(el('h2', {}, 'Move accounts to your phone'), el('div', { class: 'stack' },
    el('div', { class: 'banner warn' }, el('b', {}, 'These codes contain your secret keys.'), ' Anyone who sees or photographs them can add your accounts to their own app. Show them only to your own phone, somewhere private, then close them.'),
    el('div', { class: 'card pad stack' }, el('b', {}, '1. Pick accounts'), el('div', { class: 'preview' }, ...boxes)),
    el('div', { class: 'card pad stack' }, el('b', {}, '2. Pick how'), el('div', { class: 'opts' },
      fmt('google', 'Google Authenticator', 'Several accounts per QR code. On the phone: Transfer accounts → Import accounts.', true),
      fmt('single', 'Any authenticator app', 'One QR code per account. Scan each with your app’s “add account” camera.', true),
      fmt('text', 'Text links', 'otpauth:// links you can copy into apps that accept them. Free.', false))),
    el('div', { class: 'card pad stack' }, el('b', {}, '3. Confirm it’s you'), pw ? el('label', { class: 'l' }, 'App password', pw) : '', el('label', { class: 'row small', style: 'font-weight:600' }, ack, 'I understand these codes show my secret keys'), err,
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: show }, 'Show codes'))),
    out));
  async function show() {
    err.textContent = ''; out.replaceChildren();
    const ids = new Set(boxes.map((b) => b.querySelector('input')).filter((c) => c.checked).map((c) => c.dataset.id));
    const chosen = accts.filter((a) => ids.has(a.id));
    const f = main.querySelector('input[name=fmt]:checked').value;
    if (!chosen.length) { err.textContent = 'Pick at least one account.'; return; }
    if (!ack.checked) { err.textContent = 'Tick the box to confirm.'; return; }
    const pwOk = !pw || await V.verifyPassword(pw.value);
    if (pw) pw.value = '';
    if (!pwOk) { err.textContent = 'That password isn’t right.'; return; }
    if (f !== 'text' && !e.can('exportQr')) { out.replaceChildren(proPrompt('Moving accounts to a phone with QR codes')); return; }
    const hide = el('button', { class: 'btn', onclick: () => out.replaceChildren() }, 'Hide codes');
    if (f === 'google') {
      const batches = migrationBatches(chosen);
      out.replaceChildren(el('div', { class: 'card pad stack' }, el('div', { class: 'row' }, el('b', { class: 'grow' }, batches.length > 1 ? `${batches.length} codes: scan them in order` : 'Scan this code'), hide),
        el('div', { class: 'muted small' }, 'Google Authenticator on your phone: menu → Transfer accounts → Import accounts → Scan QR code.'),
        el('div', { class: 'qrgrid' }, ...batches.map((b) => el('figure', {}, qrOrFallback(b.uri, b.accounts), el('figcaption', { class: 'small' }, `Code ${b.index + 1} of ${b.total} · ${b.accounts.map(label).join(', ')}`))))));
    } else if (f === 'single') {
      out.replaceChildren(el('div', { class: 'card pad stack' }, el('div', { class: 'row' }, el('b', { class: 'grow' }, chosen.length > 1 ? `${chosen.length} codes, one per account` : 'Scan this code'), hide),
        el('div', { class: 'qrgrid' }, ...chosen.map((a) => el('figure', {}, qrOrFallback(singleUri(a), [a]), el('figcaption', { class: 'small' }, label(a) + (a.account ? ' · ' + a.account : '')))))));
    } else {
      const ta = el('textarea', { class: 'f mono', rows: Math.min(12, chosen.length + 1), readonly: true, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Exported links' }, textExport(chosen));
      out.replaceChildren(el('div', { class: 'card pad stack' }, el('div', { class: 'row' }, el('b', { class: 'grow' }, `${chosen.length} links`), hide), ta,
        el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(ta.value); clearClipboardLater(); toast('Copied. Paste it now: the clipboard is cleared in 45 seconds.'); } catch { toast('Select the text and press Ctrl+C'); } } }, 'Copy')),
        el('div', { class: 'small muted' }, 'Not saved anywhere by this extension. If you copy it, paste it right away: we clear the clipboard after 45 seconds while this page is open, but Windows clipboard history (Win+V), Mac Universal Clipboard and clipboard apps may keep their own copy. For a file that’s safe to keep, use Shield → Back up now (encrypted).')));
    }
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Copied secrets don't stay on the clipboard: 45 seconds later it is emptied, unless something else was
// copied from this page since. (Browsers can't read the clipboard without another permission, so a copy
// made in another app in those 45 seconds while this page has focus would be cleared too.)
let CLIP_GEN = 0;
document.addEventListener('copy', () => { CLIP_GEN++; });
function clearClipboardLater(ms = 45000) {
  const gen = ++CLIP_GEN;
  setTimeout(async () => {
    if (gen !== CLIP_GEN || !document.hasFocus()) return;
    try { await navigator.clipboard.writeText(''); toast('Clipboard cleared'); } catch { /* page not focused */ }
  }, ms);
}

// ---------------- add / import ----------------
function addOptions() {
  return el('div', { class: 'opts' },
    el('button', { class: 'card opt', onclick: () => addFrom('google') }, el('b', {}, 'From Google Authenticator'), el('span', { class: 'small muted' }, 'Moves all your accounts at once, from a photo or screenshot of its export code')),
    el('button', { class: 'card opt', onclick: () => addFrom('image') }, el('b', {}, 'From a QR image'), el('span', { class: 'small muted' }, 'Screenshot or photo of a site’s setup QR code')),
    el('button', { class: 'card opt', onclick: () => addFrom('camera') }, el('b', {}, 'Scan with webcam'), el('span', { class: 'small muted' }, 'Hold the QR code up to your camera')),
    el('button', { class: 'card opt', onclick: () => addFrom('manual') }, el('b', {}, 'Type a setup key'), el('span', { class: 'small muted' }, 'The text key a site shows under its QR code')),
    el('button', { class: 'card opt', onclick: () => restoreView() }, el('b', {}, 'Restore a backup file'), el('span', { class: 'small muted' }, 'From Downloads/NeverLoseCodes, with your recovery key')));
}

function addView() { main.replaceChildren(el('h2', {}, 'Add account'), addOptions(), el('p', { class: 'small muted', style: 'margin-top:14px' }, 'Tip: you can also paste a QR screenshot anywhere on this page with Ctrl+V.')); }

async function addFrom(kind) {
  const err = el('div', { class: 'err' });
  const result = el('div');
  const handleText = (text) => { try { const r = accountsFromText(text); if (!r.accounts.length) throw new Error('No accounts found in that code.'); preview(r, result); err.textContent = ''; } catch (e) { err.textContent = e.message; } };
  const handleImage = async (blob) => { try { handleText(await qrFromImage(blob)); } catch (e) { err.textContent = e.message; } };
  if (kind === 'google' || kind === 'image') {
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => e.target.files[0] && handleImage(e.target.files[0]) });
    const drop = el('div', { class: 'drop' }, el('b', {}, 'Drop the image here'), el('div', { class: 'muted small' }, 'or ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); input.click(); } }, 'choose a file'), ', or paste a screenshot with Ctrl+V. It is read on this computer only.'), input);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handleImage(e.dataTransfer.files[0]); };
    main.replaceChildren(el('h2', {}, kind === 'google' ? 'Move accounts from Google Authenticator' : 'Add from a QR image'),
      kind === 'google' ? el('ol', { class: 'muted' }, el('li', {}, 'On your phone, open Google Authenticator → menu (⋮ or ☰) → Transfer accounts → Export accounts.'), el('li', {}, 'Pick all accounts. It shows a QR code (sometimes several).'), el('li', {}, 'Take a photo or screenshot of it and send it to this computer, then drop it below.'), el('li', {}, 'Your phone keeps its copy. Nothing is removed there.')) : '',
      drop, err, result, el('a', { href: '#add', class: 'small' }, '← Other ways to add'));
  } else if (kind === 'camera') {
    const video = el('video', { autoplay: true, playsinline: true, muted: true });
    main.replaceChildren(el('h2', {}, 'Scan with webcam'), video, err, result, el('a', { href: '#add', class: 'small' }, '← Other ways to add'));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      scanFromVideo(video, (t) => { stream.getTracks().forEach((x) => x.stop()); handleText(t); });
    } catch { err.textContent = 'The camera isn’t available. Allow camera access, or use a photo or screenshot instead.'; }
  } else {
    const iss = el('input', { class: 'f', placeholder: 'GitHub', 'aria-label': 'Service' });
    const acc = el('input', { class: 'f', placeholder: 'you@example.com', 'aria-label': 'Account' });
    const sec = el('input', { class: 'f', placeholder: 'JBSW Y3DP EHPK 3PXP', 'aria-label': 'Setup key' });
    main.replaceChildren(el('h2', {}, 'Type a setup key'), el('div', { class: 'card pad stack', style: 'max-width:560px' },
      el('div', { class: 'row2' }, el('label', { class: 'l' }, 'Service', iss), el('label', { class: 'l' }, 'Account (optional)', acc)),
      el('label', { class: 'l' }, 'Setup key or otpauth:// link', sec), err,
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = accountsFromText(sec.value);
          const a = r.accounts[0];
          if (r.needsName) { if (!iss.value.trim()) throw new Error('Give it a name, like the website it’s for.'); a.issuer = iss.value.trim(); a.account = acc.value.trim(); }
          await V.addAccount(a); changed(); toast(`Added ${label(a)}`); location.hash = '#codes'; load();
        } catch (e) { err.textContent = e.message; }
      } }, 'Add account')), el('a', { href: '#add', class: 'small' }, '← Other ways to add'));
  }
}

function preview(r, into) {
  const have = new Set(live().map((a) => a.secret + '|' + (a.issuer || '')));
  const rows = r.accounts.map((a) => ({ a, dup: have.has(a.secret + '|' + (a.issuer || '')), cb: null }));
  const list = el('div', { class: 'preview' }, ...rows.map((x) => { x.cb = el('input', { type: 'checkbox', checked: !x.dup || null }); return el('label', {}, x.cb, el('span', { class: 'grow' }, el('b', {}, label(x.a)), ' ', el('span', { class: 'small muted' }, x.a.account || '')), x.dup ? el('span', { class: 'badge' }, 'ALREADY ADDED') : ''); }));
  const batch = r.batch && r.batch.batchSize > 1 ? el('div', { class: 'banner' }, `This is export code ${r.batch.batchIndex + 1} of ${r.batch.batchSize}. Add these, then add the next code the same way.`) : '';
  into.replaceChildren(el('div', { class: 'card pad stack', style: 'margin-top:14px' }, el('b', {}, `Found ${plural(r.accounts.length, 'account')}`), batch, list,
    el('button', { class: 'btn primary', onclick: async () => {
      let n = 0; for (const x of rows) if (x.cb.checked) { await V.addAccount(x.a); n++; }
      changed(); toast(`Added ${plural(n, 'account')}`); location.hash = '#codes'; load();
    } }, 'Add selected')));
}

document.addEventListener('paste', async (e) => {
  if (STATE !== 'open') return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); location.hash = '#add'; await addFrom('image'); const f = item.getAsFile(); try { const t = await qrFromImage(f); preview(accountsFromText(t), main.querySelector('.err').nextSibling); } catch (err) { main.querySelector('.err').textContent = err.message; } }
});

// ---------------- shield / settings / plan ----------------
function shieldView() {
  const t = STATUS.selfTest;
  const ok = (c) => el('span', { class: 'check ' + (c ? 'ok' : 'wait') }, c ? '✓' : '…');
  const confirmed = !!STATUS.rkConfirmed;
  main.replaceChildren(el('h2', {}, 'Shield'), el('div', { class: 'stack' },
    el('div', { class: 'card pad row' }, ok(true), el('div', {}, el('b', {}, 'Encrypted on this computer'), el('div', { class: 'small muted' }, 'Every account is encrypted (AES-256). Nothing readable is stored.'))),
    el('div', { class: 'card pad row' }, ok(!!STATUS.lastBackupOk), el('div', {}, el('b', {}, 'Encrypted backup file in Downloads/NeverLoseCodes'), el('div', { class: 'small muted' }, STATUS.lastBackupOk ? `Verified ${timeAgo(STATUS.lastBackupOk)} · ${plural(STATUS.backups || 0, 'file')} kept. Survives uninstalling or clearing Chrome.` : 'Written after every change.'))),
    el('div', { class: 'card pad row' }, ok(confirmed), el('div', {}, el('b', {}, 'Recovery key saved'), el('div', { class: 'small muted' }, confirmed ? 'Opens your backups on any computer. Keep it somewhere safe.' : 'Make a new one in Settings and keep it safe.'))),
    el('div', { class: 'card pad row' }, ok(t && t.ok), el('div', {}, el('b', {}, 'Weekly integrity test'), el('div', { class: 'small muted' }, t ? (t.ok ? `Passed ${timeAgo(t.at)}${t.decrypted != null ? `: all ${t.decrypted} accounts decrypt` : ''}` : 'Failed. Contact support.') : 'Runs automatically'))),
    el('div', { class: 'row', style: 'flex-wrap:wrap' },
      el('button', { class: 'btn primary', onclick: async () => { await bg('backupNow'); toast('Encrypted backup written to Downloads/NeverLoseCodes'); setTimeout(load, 1500); } }, 'Back up now'),
      el('button', { class: 'btn', onclick: async () => { const r = await bg('selfTest'); toast(r && r.ok ? 'Integrity test passed' : 'Integrity test failed'); load(); } }, 'Run integrity test'),
      el('button', { class: 'btn', onclick: () => restoreView() }, 'Restore a backup file'))));
}

function settingsView() {
  const e = ENT();
  const pw1 = el('input', { class: 'f', type: 'password', placeholder: 'New app password (8+ characters)', 'aria-label': 'New app password' });
  const err = el('div', { class: 'err' });
  const rkOut = el('div');
  const lockSel = el('select', { class: 'f', 'aria-label': 'Auto-lock', style: 'max-width:240px', disabled: !e.can('autoLockOptions') || null },
    ...LOCK_CHOICES.map((c) => el('option', { value: String(c.minutes), selected: c.minutes === LOCK_NOW || null }, c.label)));
  lockSel.onchange = async () => {
    const m = Number(lockSel.value);
    await chrome.storage.local.set({ nlc_autoLock: m }); LOCK_NOW = m;
    // a shorter time applies now; a longer one from your next unlock (never longer without your password)
    const s = await readUnlock();
    if (s) { const exp = adjustedExpiry(s, m); if (exp < s.exp) { const t = { ...s, exp }; await chrome.storage.session.set({ nlc_vk: t }); await scheduleAutoLock(t); } }
    toast('Auto-lock: ' + lockLabel(m) + (s && adjustedExpiry(s, m) >= s.exp ? ', from your next unlock' : '')); await armAutoLock(); settingsView();
  };
  main.replaceChildren(el('h2', {}, 'Settings'), el('div', { class: 'stack' },
    el('div', { class: 'card pad stack' }, el('b', {}, 'App password'), el('div', { class: 'small muted' }, V.hasPassword ? `Your codes need your password after Chrome restarts, or after ${LOCK_NOW === 0 ? 'Chrome closes' : lockLabel(LOCK_NOW)}.` : 'Optional. Without it, codes open on this computer without typing anything.'),
      pw1, err, el('div', { class: 'row', style: 'flex-wrap:wrap' },
        el('button', { class: 'btn primary', onclick: async () => { try { await V.setPassword(pw1.value); await rememberUnlock(V); changed(); toast('Password set. Keep your recovery key: it opens your codes if you forget the password'); load(); } catch (e) { err.textContent = e.message; } } }, V.hasPassword ? 'Change password' : 'Set password'),
        V.hasPassword ? el('button', { class: 'btn', onclick: async () => { await forgetUnlock(); V.lock(); toast('Locked'); load(); } }, 'Lock now') : '',
        V.hasPassword ? el('button', { class: 'btn ghost', onclick: async () => { await V.removePassword(); await forgetUnlock(); changed(); toast('Password removed'); load(); } }, 'Remove password') : '')),
    V.hasPassword ? el('div', { class: 'card pad stack' }, el('b', {}, 'Auto-lock'), el('div', { class: 'small muted' }, 'How long your codes stay open after you type your password. Every choice also locks when Chrome closes.'),
      lockSel, e.can('autoLockOptions') ? '' : proPrompt('Choosing the auto-lock time')) : '',
    el('div', { class: 'card pad stack' }, el('b', {}, 'Recovery key'), el('div', { class: 'small muted' }, 'Lost your recovery key? Make a new one. The old one stops working for this vault and for new backups. Backup files made before today still need the OLD key, so keep it if you still have it.'),
      el('button', { class: 'btn', onclick: async () => { const k = await V.newRecoveryKey(); changed(); await chrome.storage.local.set({ nlc_rkConfirmedAt: Date.now() }); rkOut.replaceChildren(el('div', { class: 'rk' }, k), el('div', { class: 'small muted' }, 'Save it now. It won’t be shown again.')); } }, 'Make a new recovery key'), rkOut)));
}

async function planView() {
  const e = ENT();
  const keyIn = el('input', { class: 'f', placeholder: 'Paste your key (starts with NLT1.)', 'aria-label': 'License key' });
  const err = el('div', { class: 'err' });
  main.replaceChildren(el('h2', {}, 'Plan'), el('div', { class: 'stack' },
    el('div', { class: 'card pad stack' }, el('b', {}, e.tier === 'pro' ? 'Pro: unlocked forever. Thank you!' : e.tier === 'trial' ? `Free trial: ${e.trial.daysLeft} days left with everything unlocked` : 'Free plan'),
      el('div', { class: 'small' }, el('b', {}, 'Free forever: '), 'your codes, adding and importing accounts, encrypted backups, restore, your recovery key, an app password, and export as text links. You are never locked out of your own codes.'),
      el('div', { class: 'small' }, el('b', {}, `Pro (one-time ${PRICE_LABEL}): `), 'move accounts to your phone with QR codes (Google Authenticator or any app), groups, pinned favorites and drag-to-reorder, color badges, and choosing the auto-lock time.')),
    e.tier !== 'pro' ? el('a', { class: 'btn primary big', href: BUY_URL, target: '_blank', rel: 'noopener noreferrer' }, `Unlock Pro forever for ${PRICE_LABEL}`) : '',
    e.tier !== 'pro' ? el('div', { class: 'card pad stack' }, el('b', {}, 'Already bought?'), keyIn, err, el('button', { class: 'btn', onclick: async () => {
      const r = await verifyKey(keyIn.value); if (!r.ok) { err.textContent = r.reason; return; }
      await chrome.storage.local.set({ nlc_license: { key: keyIn.value.trim(), at: Date.now() } }); toast('Pro unlocked'); LIC = r.payload; route();
    } }, 'Activate')) : ''));
}

// ---------------- routing ----------------
async function route() {
  LIC = await license();
  STATUS.rkConfirmed = !!(await chrome.storage.local.get('nlc_rkConfirmedAt')).nlc_rkConfirmedAt;
  LOCK_NOW = await autoLockMinutes(ENT());
  if (STATE !== 'open') { clearInterval(window.__t); ACCTS = []; }
  nav();
  const v = view();
  if (STATE === 'setup') return v === 'restore' ? restoreView() : setupView(1);
  if (STATE === 'recovery' || v === 'recover') return recoverView();
  if (STATE === 'locked') return lockedView();
  if (v === 'setup') return setupView(3);
  if (v === 'add') return addView();
  if (v === 'shield') return shieldView();
  if (v === 'trash') return codesView(true);
  if (v === 'settings') return settingsView();
  if (v === 'plan') return planView();
  if (v === 'export') return exportView();
  return codesView(false);
}

window.addEventListener('hashchange', () => load());
// Auto-lock: the moment a password unlock expires, drop the key and close the codes on this page.
async function lockNow() {
  await forgetUnlock();
  clearInterval(window.__t); ACCTS = [];
  if (V) V.lock();
  load();
}
let LOCK_TIMER = null;
async function armAutoLock() {
  clearTimeout(LOCK_TIMER);
  if (STATE !== 'open' || !V || !V.hasPassword) return;
  const ends = await unlockEndsAt(ENT());
  if (!ends) return lockNow();
  if (ends !== Number.MAX_SAFE_INTEGER) LOCK_TIMER = setTimeout(lockNow, Math.min(MAX_TIMER, Math.max(0, ends - Date.now())));
}
// backstop (sleep/wake, clock changes): readUnlock deletes an expired key
setInterval(async () => {
  if (STATE !== 'open' || !V || !V.hasPassword) return;
  if (!(await readUnlock(ENT()))) lockNow();
}, 10000);
load().catch((e) => main.replaceChildren(el('div', { class: 'card pad' }, 'Something went wrong: ' + e.message)));
