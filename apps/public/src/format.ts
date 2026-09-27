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
