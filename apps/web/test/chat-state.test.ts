import { describe, expect, it } from 'vitest';
import { chatReducer, initialChat, type ChatState } from '../src/lib/chat-state';

const run = (actions: Parameters<typeof chatReducer>[1][], state: ChatState = initialChat) => actions.reduce(chatReducer, state);

describe('chat state', () => {
  it('streams an answer with status, citations and scope', () => {
    const s = run([
      { type: 'send', text: 'Maria’s appointments', id: '1' },
      { type: 'event', event: 'status', data: { message: 'Looking up the customer…' } },
      { type: 'event', event: 'customer', data: { id: 'c1', name: 'Maria Lopez', number: 'C-10001', detail: null } },
      { type: 'event', event: 'citations', data: [{ n: 1, type: 'appointment', id: 'A-1', title: 'Haircut', url: null }] },
      { type: 'event', event: 'token', data: { text: 'Next: ' } },
      { type: 'event', event: 'token', data: { text: 'Haircut [1]' } },
      { type: 'event', event: 'done', data: { messageId: 'm-9' } },
    ]);
    expect(s.busy).toBe(false);
    expect(s.scope).toMatchObject({ kind: 'customer', name: 'Maria Lopez' });
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]).toMatchObject({ id: 'm-9', content: 'Next: Haircut [1]', streaming: false, status: undefined });
    expect(s.messages[1].citations[0].id).toBe('A-1');
  });

  it('shows disambiguation candidates', () => {
    const s = run([
      { type: 'send', text: 'Maria', id: '1' },
      { type: 'event', event: 'disambiguation', data: { candidates: [{ kind: 'customer', id: 'a', label: 'Maria Lopez', number: 'C-1', detail: null }] } },
    ]);
    expect(s.messages[1].candidates).toHaveLength(1);
  });

  it('handles stop and failures', () => {
    const stopped = run([{ type: 'send', text: 'q', id: '1' }, { type: 'aborted' }]);
    expect(stopped.messages[1]).toMatchObject({ content: 'Stopped.', streaming: false });
    expect(stopped.busy).toBe(false);
    const failed = run([{ type: 'send', text: 'q', id: '1' }, { type: 'failed', message: 'Request failed (500)' }]);
    expect(failed.messages[1].error).toBe('Request failed (500)');
  });
});
