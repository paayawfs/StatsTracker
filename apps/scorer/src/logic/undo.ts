import type { EventOf, GameEvent, GameLog, PlayBody } from '@stats/core';

export type UndoBody = { type: 'void'; payload: { targetId: string } } | { type: 'amend'; payload: { targetId: string; body: PlayBody } };
const SESSION = new Set(['roleClaim', 'roleRelease', 'roleTransfer', 'adminLock', 'starters']);
const FOLLOW_UPS = new Set(['assist', 'block', 'steal']);
/** One tap's events are stamped 1 ms apart; separate taps are human-time apart. */
// ponytail: grouping by wall clock, not an action id on the event; add one if taps ever emit slowly.
const SAME_TAP_MS = 5;

/** An amend that only adds an assist, block or steal: part of the play it amends. */
function isFollowUp(e: EventOf<'amend'>, previous: PlayBody | undefined): boolean {
  if (!previous || previous.type !== e.payload.body.type) return false;
  const before = previous.payload as Record<string, unknown>;
  const after = e.payload.body.payload as Record<string, unknown>;
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  return changed.length === 1 && FOLLOW_UPS.has(changed[0]!) && before[changed[0]!] === undefined;
}

/**
 * The corrections that undo this device's most recent action, or null. An action is one tap's
 * events (offensive foul + turnover), or a play with its follow-up (shot + assist): one undo
 * removes all of it. Undoing a correction restores what it replaced (core ignores corrections
 * aimed at corrections). `undone` holds ids already undone plus the undo markers themselves, so
 * repeated undo walks back.
 */
export function undoLast(log: GameLog, deviceId: string, undone: ReadonlySet<string> = new Set()): { undoes: string[]; bodies: UndoBody[] } | null {
  const mine = log.events.filter((e) => e.deviceId === deviceId && !SESSION.has(e.type) && !undone.has(e.id));
  const e = mine.at(-1);
  if (!e) return null;
  let anchor: GameEvent = e;
  const extra: string[] = [];

  if (e.type === 'amend' || e.type === 'void') {
    const targetId = e.payload.targetId;
    const previous = log.correctionsFor(targetId).filter((c) => c.id !== e.id && !undone.has(c.id)).at(-1);
    if (previous?.type === 'void') return { undoes: [e.id], bodies: [{ type: 'void', payload: { targetId } }] };
    const target = log.get(targetId);
    const body = previous?.type === 'amend' ? previous.payload.body : target && ({ type: target.type, payload: target.payload } as PlayBody);
    if (!body) return null;
    // My own play plus its follow-up: remove the play. Someone else's play: just take my follow-up off.
    if (e.type !== 'amend' || !isFollowUp(e, body) || target?.deviceId !== deviceId || undone.has(target.id) || !mine.some((m) => m.id === target.id)) {
      return { undoes: [e.id], bodies: [{ type: 'amend', payload: { targetId, body } }] };
    }
    extra.push(e.id);
    anchor = mine.find((m) => m.id === target.id)!;
  }

  // The anchor and anything recorded in the same tap just before it.
  const i = mine.indexOf(anchor);
  const group = [anchor];
  for (let j = i - 1; j >= 0 && Math.abs(group[0]!.wallClock - mine[j]!.wallClock) <= SAME_TAP_MS && mine[j]!.type !== 'amend' && mine[j]!.type !== 'void'; j--) group.unshift(mine[j]!);
  return { undoes: [...extra, ...group.map((g) => g.id)], bodies: group.map((g) => ({ type: 'void', payload: { targetId: g.id } })) };
}
