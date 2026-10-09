/** Incremental parser for text/event-stream (event + data lines, blank line ends an event). */
export interface SseEvent {
  event: string;
  data: unknown;
}

export function createSseParser(onEvent: (e: SseEvent) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue; // comment / keep-alive
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length === 0) continue;
      const text = data.join('\n');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // plain text data
      }
      onEvent({ event, data: parsed });
    }
  };
}

/** Reads a fetch Response body as server-sent events. */
export async function readSse(res: Response, onEvent: (e: SseEvent) => void): Promise<void> {
  if (!res.body) return;
  const feed = createSseParser(onEvent);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    feed(value);
  }
}
