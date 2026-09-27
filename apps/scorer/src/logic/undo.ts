import type { GameLog, PlayBody } from '@stats/core';

export type UndoBody = { type: 'void'; payload: { targetId: string } } | { type: 'amend'; payload: { targetId: string; body: PlayBody } };
const SESSION = new Set(['roleClaim', 'roleRelease', 'roleTransfer', 'adminLock']);

/**
 * The correction that undoes this device's most recent action, or null. Undoing a correction
 * restores what it replaced (core ignores corrections aimed at corrections).
 * `undone` holds ids already undone plus the undo markers themselves, so repeated undo walks back.
 */
export function undoLast(log: GameLog, deviceId: string, undone: ReadonlySet<string> = new Set()): { undoes: string; body: UndoBody } | null {
  for (let i = log.events.length - 1; i >= 0; i--) {
    const e = log.events[i]!;
    if (e.deviceId !== deviceId || SESSION.has(e.type) || undone.has(e.id)) continue;
    if (e.type !== 'amend' && e.type !== 'void') return { undoes: e.id, body: { type: 'void', payload: { targetId: e.id } } };

    const targetId = e.payload.targetId;
    const previous = log.correctionsFor(targetId).filter((c) => c.id !== e.id && !undone.has(c.id)).at(-1);
    if (previous?.type === 'void') return { undoes: e.id, body: { type: 'void', payload: { targetId } } };
    const target = log.get(targetId);
    const body = previous?.type === 'amend' ? previous.payload.body : target && ({ type: target.type, payload: target.payload } as PlayBody);
    if (body) return { undoes: e.id, body: { type: 'amend', payload: { targetId, body } } };
  }
  return null;
}
