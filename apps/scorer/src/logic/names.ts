/**
 * Short chip labels: the last name, unless a teammate shares it; then the first initial too
 * ("K. Mensah", "A. Mensah"), and if that still clashes, the full name.
 */
export function chipLabels(players: readonly { id: string; name: string; team: string }[]): Map<string, string> {
  const words = (name: string) => name.trim().split(/\s+/);
  const last = (name: string) => words(name).at(-1) ?? name;
  const initialed = (name: string) => {
    const w = words(name);
    return w.length > 1 ? `${w[0]![0]}. ${w.at(-1)}` : name;
  };
  const labels = new Map<string, string>();
  for (const short of [last, initialed]) {
    const pending = players.filter((p) => !labels.has(p.id));
    const key = (p: (typeof players)[number]) => `${p.team}|${short(p.name)}`;
    const count = new Map<string, number>();
    for (const p of pending) count.set(key(p), (count.get(key(p)) ?? 0) + 1);
    for (const p of pending) if (count.get(key(p)) === 1) labels.set(p.id, short(p.name));
  }
  for (const p of players) if (!labels.has(p.id)) labels.set(p.id, p.name.trim());
  return labels;
}

/** "Mensah, Kofi" -> "Kofi Mensah"; anything else as typed (spaces tidied). */
export const firstLast = (name: string) => name.replace(/^([^,]+),\s*([^,]+)$/, '$2 $1').trim().replace(/\s+/g, ' ');
