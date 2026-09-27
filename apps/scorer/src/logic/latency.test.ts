import { describe, expect, test } from 'vitest';
import { latencyUploader } from './latency';

describe('latencyUploader', () => {
  test('flush sends everything buffered, once', async () => {
    const sent: unknown[] = [];
    const u = latencyUploader(async (batch) => void sent.push(batch));
    u.add('render', 12);
    u.add('peer', 80);
    await u.flush();
    await u.flush();
    expect(sent).toEqual([[{ kind: 'render', ms: 12 }, { kind: 'peer', ms: 80 }]]);
  });

  test('a failed send keeps the samples for next time', async () => {
    let fail = true;
    const sent: unknown[] = [];
    const u = latencyUploader(async (batch) => {
      if (fail) throw new Error('offline');
      sent.push(batch);
    });
    u.add('render', 5);
    await u.flush();
    fail = false;
    u.add('render', 6);
    await u.flush();
    expect(sent).toEqual([[{ kind: 'render', ms: 5 }, { kind: 'render', ms: 6 }]]);
  });

  test('the buffer is capped (oldest dropped) and batches are at most 500', async () => {
    const sent: { kind: string; ms: number }[][] = [];
    const u = latencyUploader(async (batch) => void sent.push(batch), 600);
    for (let i = 0; i < 700; i++) u.add('render', i);
    await u.flush();
    expect(sent.map((b) => b.length)).toEqual([500, 100]);
    expect(sent[0]![0]!.ms).toBe(100);
  });
});
