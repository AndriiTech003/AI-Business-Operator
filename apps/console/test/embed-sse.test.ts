import { describe, expect, it } from 'vitest';
import { encodeSse, parseSseChunk, type RunEvent } from '@aio/contracts';
import { parseSse } from '../src/embed/sse';

describe('embed SSE parser', () => {
  it('agrees with the contracts parser', () => {
    const ev: RunEvent = { type: 'text', runId: 'r', delta: 'a\nb', seq: null };
    const wire = `: ping\n\n${encodeSse(ev, 1)}${encodeSse(ev, 2)}event: text\ndata: {"partial`;
    expect(parseSse(wire)).toEqual(parseSseChunk(wire));
  });
});
