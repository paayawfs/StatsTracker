export const minutes = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const pct = (made: number, att: number) => (att ? `${Math.round((made / att) * 100)}%` : '-');

export const signed = (n: number | null, digits = 0) => {
  if (n === null) return '-';
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
};

/**
 * Section heat colour: one violet, darker with FG% (pale 0% -> deep 100%), so it never reads as a
 * team colour (orange, blue) or make/miss (green, red). Strength by attempts so one lucky shot doesn't
 * look hot. Undefined with no attempts.
 */
export function heat(made: number, att: number): string | undefined {
  if (!att) return undefined;
  const p = made / att;
  const alpha = Math.round(Math.min(0.6, 0.25 + 0.07 * att) * 100) / 100;
  return `hsla(270, 60%, ${Math.round(85 - 45 * p)}%, ${alpha})`;
}
