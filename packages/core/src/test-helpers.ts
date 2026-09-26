import type { Envelope, EventOf, EventType } from './events';

let n = 0;

/** Build an event with sensible envelope defaults. Each call advances seq, deviceSeq and the clock. */
export function ev<T extends EventType>(
  type: T,
  payload: EventOf<T>['payload'],
  env: Partial<Envelope> = {},
): EventOf<T> {
  n++;
  return {
    id: `e${n}`,
    gameId: 'g1',
    seq: n,
    deviceId: 'd1',
    deviceSeq: n,
    role: 'single',
    period: 1,
    gameClock: 600_000 - n,
    wallClock: n,
    ...env,
    type,
    payload,
  } as EventOf<T>;
}
