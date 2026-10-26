// Protection status shown to the user (pure). Honest: green only when every layer is verified.
const H = 3600000;

export function protection(st, now = Date.now()) {
  const checks = [];
  const integrity = st.health && st.health.ok;
  checks.push({ key: 'local', ok: !!integrity, label: 'Saved on this computer in two independent copies',
    detail: integrity ? 'Integrity check passed when Chrome started' : (st.health.problems.slice(-1)[0] || {}).msg || 'A problem was found' });

  const age = st.lastBackupOk ? now - st.lastBackupOk : null;
  const fresh = age !== null && age < 26 * H;
  const newInstall = st.installedAt && now - st.installedAt < 2 * H;
  checks.push({ key: 'file', ok: fresh, wait: !fresh && !!newInstall,
    label: 'Backup file in your Downloads folder (survives uninstall)',
    detail: st.lastBackupOk ? `Last verified backup ${timeAgo(st.lastBackupOk, now)} · ${st.backups} kept` : 'First backup is made within the hour' });

  const t = st.selfTest;
  checks.push({ key: 'drill', ok: !!(t && t.ok), wait: !t, label: 'Weekly restore test',
    detail: t ? (t.ok ? `Passed ${timeAgo(t.at, now)}: every saved session restored from the backup` : `Failed ${timeAgo(t.at, now)}. Use "Back up now" and "Run restore test"`) : 'Runs automatically once a week' });

  const bad = checks.some((c) => !c.ok && !c.wait);
  const level = bad ? 'bad' : checks.every((c) => c.ok) ? 'ok' : 'wait';
  const headline = level === 'ok' ? 'Protected' : level === 'wait' ? 'Protected · setting up' : 'Needs attention';
  return { level, headline, checks };
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}
