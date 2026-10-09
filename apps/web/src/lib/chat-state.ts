/** Chat conversation state, driven by the API's server-sent events (plan.md §5.2). */

export interface Citation {
  n: number;
  type: string;
  id: string;
  title: string;
  url: string | null;
}

export interface Candidate {
  kind: 'customer' | 'organization';
  id: string;
  label: string;
  number: string;
  detail: string | null;
}

export interface ScopeCard {
  kind: 'customer' | 'organization';
  id: string;
  name: string;
  number: string;
  detail: string | null;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  status?: string;
  streaming?: boolean;
  error?: string;
  candidates?: Candidate[];
}

export interface ChatState {
  messages: Message[];
  scope?: ScopeCard;
  busy: boolean;
}

export type ChatAction =
  | { type: 'load'; messages: Message[] }
  | { type: 'send'; text: string; id: string }
  | { type: 'event'; event: string; data: any }
  | { type: 'aborted' }
  | { type: 'failed'; message: string }
  | { type: 'scope'; scope?: ScopeCard };

export const initialChat: ChatState = { messages: [], busy: false };

function updateLast(state: ChatState, patch: (m: Message) => Message): ChatState {
  const messages = [...state.messages];
  const i = messages.length - 1;
  if (i < 0 || messages[i].role !== 'assistant') return state;
  messages[i] = patch(messages[i]);
  return { ...state, messages };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'load':
      return { ...state, messages: action.messages, busy: false };
    case 'send':
      return {
        ...state,
        busy: true,
        messages: [
          ...state.messages,
          { id: `u-${action.id}`, role: 'user', content: action.text, citations: [] },
          { id: `a-${action.id}`, role: 'assistant', content: '', citations: [], streaming: true, status: 'Thinking…' },
        ],
      };
    case 'scope':
      return { ...state, scope: action.scope };
    case 'aborted':
      return { ...updateLast(state, (m) => ({ ...m, streaming: false, status: undefined, content: m.content || 'Stopped.' })), busy: false };
    case 'failed':
      return { ...updateLast(state, (m) => ({ ...m, streaming: false, status: undefined, error: action.message })), busy: false };
    case 'event': {
      const d = action.data;
      switch (action.event) {
        case 'status':
          return updateLast(state, (m) => ({ ...m, status: d.message }));
        case 'customer':
        case 'organization':
          return { ...state, scope: { kind: action.event, id: d.id, name: d.name, number: d.number, detail: d.detail } };
        case 'disambiguation':
          return updateLast(state, (m) => ({ ...m, candidates: d.candidates }));
        case 'citations':
          return updateLast(state, (m) => ({ ...m, citations: d }));
        case 'token':
          return updateLast(state, (m) => ({ ...m, content: m.content + d.text, status: undefined }));
        case 'error':
          return updateLast(state, (m) => ({ ...m, error: d.message, status: undefined }));
        case 'done':
          return { ...updateLast(state, (m) => ({ ...m, id: d.messageId ?? m.id, streaming: false, status: undefined })), busy: false };
        default:
          return state;
      }
    }
  }
}
