export type Sample = { kind: 'render' | 'peer'; ms: number };

/**
 * Buffers latency samples and uploads them in batches (the server takes at most 500 per call).
 * A failed upload keeps its samples for the next flush; the buffer drops the oldest past `cap`.
 */
export function latencyUploader(send: (batch: Sample[]) => Promise<void>, cap = 2000) {
  let buffer: Sample[] = [];
  let flushing = false;
  return {
    add(kind: Sample['kind'], ms: number) {
      buffer.push({ kind, ms: Math.round(ms * 10) / 10 });
      if (buffer.length > cap) buffer = buffer.slice(-cap);
    },
    async flush() {
      if (flushing) return;
      flushing = true;
      try {
        while (buffer.length) {
          const batch = buffer.slice(0, 500);
          await send(batch);
          buffer = buffer.slice(batch.length);
        }
      } catch {
        // keep the rest for the next flush
      } finally {
        flushing = false;
      }
    },
  };
}
