import { describe, expect, it } from 'vitest';
import { createSseParser, type SseEvent } from '../src/lib/sse';

describe('SSE parser', () => {
  it('parses events split across chunks, skipping keep-alive comments', () => {
    const events: SseEvent[] = [];
    const feed = createSseParser((e) => events.push(e));
    feed('event: status\ndata: {"message":"Look');
    feed('ing up…"}\n\n: keep-alive\n\nevent: token\r\ndata: {"text":"Hi"}\r\n\r\n');
    feed('event: done\ndata: {"messageId":"m1"}\n\n');
    expect(events).toEqual([
      { event: 'status', data: { message: 'Looking up…' } },
      { event: 'token', data: { text: 'Hi' } },
      { event: 'done', data: { messageId: 'm1' } },
    ]);
  });

  it('keeps non-JSON data as text and defaults the event name', () => {
    const events: SseEvent[] = [];
    createSseParser((e) => events.push(e))('data: plain text\n\n');
    expect(events).toEqual([{ event: 'message', data: 'plain text' }]);
  });
});
