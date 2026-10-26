// Pure helpers for organizing accounts: groups, pins, custom order, color badges. Nothing here does I/O.
// These fields live inside each sealed (encrypted) account record, next to the secret.

export const GROUP_MAX = 40;
export const BADGE_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#c026d3', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#475569', '#0891b2'];

// Common services get their usual color so the list is easy to scan. Colors only: no logos, no network.
const KNOWN = {
  github: '#24292f', google: '#4285f4', gmail: '#ea4335', microsoft: '#0078d4', outlook: '#0078d4', apple: '#333333',
  amazon: '#ff9900', aws: '#ff9900', dropbox: '#0061ff', facebook: '#1877f2', instagram: '#c13584', twitter: '#1d9bf0',
  x: '#111111', linkedin: '#0a66c2', discord: '#5865f2', slack: '#611f69', coinbase: '#0052ff', binance: '#f0b90b',
  kraken: '#5741d9', paypal: '#003087', stripe: '#635bff', reddit: '#ff4500', twitch: '#9146ff', steam: '#1b2838',
  epic: '#313131', gitlab: '#fc6d26', bitbucket: '#0052cc', cloudflare: '#f38020', digitalocean: '#0080ff',
  heroku: '#430098', npm: '#cb3837', proton: '#6d4aff', protonmail: '#6d4aff', bitwarden: '#175ddc', '1password': '#0094f5',
  lastpass: '#d32d27', zoom: '#2d8cff', shopify: '#7ab55c', wordpress: '#21759b', godaddy: '#1bdbdb', namecheap: '#de3723',
  okta: '#007dc1', salesforce: '#00a1e0', hubspot: '#ff7a59', atlassian: '#0052cc', notion: '#000000', figma: '#a259ff',
};

export function cleanGroup(g) {
  return String(g || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, GROUP_MAX);
}

// Only these fields may be set by the organize UI; anything else is dropped.
export function cleanOrganize(fields = {}) {
  const out = {};
  if ('group' in fields) out.group = cleanGroup(fields.group);
  if ('pinned' in fields) out.pinned = fields.pinned === true;
  if ('order' in fields) { const n = Number(fields.order); out.order = Number.isFinite(n) ? n : null; }
  if ('color' in fields) out.color = BADGE_COLORS.includes(fields.color) ? fields.color : null;
  return out;
}

const name = (a) => a.issuer || a.account || 'Unnamed account';

// Pinned first, then your custom order (if set), then alphabetical.
export function sortAccounts(list) {
  return [...list].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    const ao = Number.isFinite(a.order) ? a.order : null, bo = Number.isFinite(b.order) ? b.order : null;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (bo != null && ao == null) return 1;
    return name(a).localeCompare(name(b));
  });
}

export function groupNames(list) {
  return [...new Set(list.map((a) => cleanGroup(a.group)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function filterAccounts(list, { query = '', group = '' } = {}) {
  const q = String(query).toLowerCase().trim();
  return list.filter((a) => (!group || cleanGroup(a.group) === group) && (!q || `${name(a)} ${a.account || ''} ${a.group || ''}`.toLowerCase().includes(q)));
}

// Drag-and-drop: move `id` to just before `beforeId` (or to the end if beforeId is null), within the
// list as currently shown. Returns { id: order } for every account whose order changes.
export function moveAccount(shown, id, beforeId) {
  const ids = shown.map((a) => a.id);
  const from = ids.indexOf(id);
  if (from < 0 || id === beforeId) return {};
  ids.splice(from, 1);
  const to = beforeId == null ? ids.length : ids.indexOf(beforeId);
  ids.splice(to < 0 ? ids.length : to, 0, id);
  const changes = {};
  ids.forEach((x, i) => { const cur = shown.find((a) => a.id === x); if (!cur || cur.order !== i) changes[x] = i; });
  return changes;
}

// Badge for an account: first letter (or digit) of the service, and a color.
export function badge(a, { colored = true } = {}) {
  const n = name(a).trim();
  const m = n.match(/[\p{L}\p{N}]/u);
  const letter = (m ? m[0] : '?').toUpperCase();
  if (!colored) return { letter, color: null };
  if (a.color && BADGE_COLORS.includes(a.color)) return { letter, color: a.color };
  const key = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, c] of Object.entries(KNOWN)) if (key === k || key.startsWith(k)) return { letter, color: c };
  let h = 0; for (const ch of n.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return { letter, color: BADGE_COLORS[h % BADGE_COLORS.length] };
}
