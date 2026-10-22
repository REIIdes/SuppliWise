// The run of consecutive days ending today — or ending yesterday when today
// has not been written yet, because an unclaimed today has not broken a streak,
// it has simply not happened. Days are YYYY-MM-DD strings in the same local
// calendar the server used to key them, so plain date arithmetic is enough.
export function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function streakDays(days, now = new Date()) {
  const set = new Set(days || []);
  if (set.size === 0) return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (set.has(dayKey(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}
