// Backup rotation (pure). Decides which off-extension backup files to keep.
// Policy: always keep the newest MIN_KEEP; plus newest per hour for 24 h, per day for 14 days,
// per week for 8 weeks. A backup that has not been verified never causes older ones to be deleted.

const H = 3600000, D = 24 * H, W = 7 * D;
export const MIN_KEEP = 3;
export const POLICY = [
  { span: 24 * H, bucket: H },
  { span: 14 * D, bucket: D },
  { span: 8 * W, bucket: W },
];

// backups: [{ id, at, verified: bool }]; returns { keep: [...ids], remove: [...ids] }
export function planRotation(backups, now) {
  const sorted = [...backups].sort((a, b) => b.at - a.at);
  const verified = sorted.filter((b) => b.verified);
  if (verified.length === 0) return { keep: sorted.map((b) => b.id), remove: [] }; // nothing trusted yet: delete nothing
  const keep = new Set();
  // unverified files are never deleted by rotation (they may be the only copy of something)
  for (const b of sorted) if (!b.verified) keep.add(b.id);
  for (const b of verified.slice(0, MIN_KEEP)) keep.add(b.id);
  for (const { span, bucket } of POLICY) {
    const seen = new Set();
    for (const b of verified) {
      const age = now - b.at;
      if (age < 0 || age > span) continue;
      const k = Math.floor(b.at / bucket);
      if (!seen.has(k)) { seen.add(k); keep.add(b.id); }
    }
  }
  return { keep: sorted.filter((b) => keep.has(b.id)).map((b) => b.id), remove: sorted.filter((b) => !keep.has(b.id)).map((b) => b.id) };
}

export function backupFileName(at, folder = 'NeverLoseTabs', prefix = 'nlt-backup') {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${folder}/${prefix}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
}
