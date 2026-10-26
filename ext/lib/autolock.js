// How long codes stay open after you type your app password. Pure.
// Chrome clears session storage when it closes, so every choice also locks when Chrome closes.
export const DEFAULT_LOCK_MINUTES = 15;
export const LOCK_CHOICES = [
  { minutes: 1, label: '1 minute' },
  { minutes: 5, label: '5 minutes' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 0, label: 'Until Chrome closes' },
];

// The setting in effect: free plans (after the trial) always use the default.
export function lockMinutes(saved, canChoose) {
  if (!canChoose) return DEFAULT_LOCK_MINUTES;
  const m = Number(saved);
  return LOCK_CHOICES.some((c) => c.minutes === m) ? m : DEFAULT_LOCK_MINUTES;
}

// When an unlock made at `now` expires. 0 = until Chrome closes (no timer).
export function lockExpiry(now, minutes) {
  return minutes === 0 ? Number.MAX_SAFE_INTEGER : now + minutes * 60000;
}

export function lockLabel(minutes) {
  const c = LOCK_CHOICES.find((x) => x.minutes === minutes);
  return c ? c.label : `${minutes} minutes`;
}

// ---- the remembered unlock: { raw, exp, at } in chrome.storage.session ----
// Free plans (after the trial) can't keep codes open longer than the default, whatever was saved
// while a trial or Pro was active (for example "Until Chrome closes").
export function effectiveExpiry(s, canChoose) {
  // malformed or edited entries (no key, no start time) never count as an unlock
  if (!s || typeof s.raw !== 'string' || !s.raw || !Number.isFinite(s.exp) || !Number.isFinite(s.at)) return 0;
  if (canChoose) return s.exp;
  return Math.min(s.exp, lockExpiry(s.at, DEFAULT_LOCK_MINUTES));
}

export function unlockIsLive(s, canChoose, now = Date.now()) {
  return effectiveExpiry(s, canChoose) > now;
}

// When the background should check again and drop the key. null = only when Chrome closes.
// A trial that ends while "Until Chrome closes" is in effect is checked when the trial ends.
export function alarmTime(s, canChoose, trialEndsAt = null) {
  const e = effectiveExpiry(s, canChoose);
  if (!e) return null;
  if (e !== Number.MAX_SAFE_INTEGER) return e;
  return Number.isFinite(trialEndsAt) ? trialEndsAt : null;
}

// Changing the setting never makes an open unlock last longer (that would skip the password).
// A shorter choice applies right away; a longer one from your next unlock.
export function adjustedExpiry(s, minutes) {
  if (!s || !Number.isFinite(s.at)) return s ? s.exp : 0;
  return Math.min(s.exp, lockExpiry(s.at, minutes));
}

// Longest delay setTimeout accepts; longer waits are re-checked by the page's own interval.
export const MAX_TIMER = 2 ** 31 - 1;
