import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/api';
import type { Audience } from '../../lib/auth';
import type { Candidate, Citation, Message, ScopeCard } from '../../lib/chat-state';
import { Badge, Button, ErrorBanner } from '../ui';
import { useChat, type Conversation } from './useChat';

const SUGGESTIONS: Record<Audience, string[]> = {
  customer: ['When is my next appointment?', 'Did my last payment go through?', 'How much do I owe?', 'What services do you offer?'],
  employee: ["What's on my schedule this week?", 'Any overdue bank transfers?', 'Show unmatched Stripe payments', 'Show me Maria Lopez’s appointments'],
};

/** Chat for customers (portal) and employees (staff console); answers stream from the API (SSE). */
export function ChatPage({ audience }: { audience: Audience }) {
  const api = useApi();
  const { conversationId, state, open, send, choose, clearScope, remove, stop } = useChat(audience);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [params, setParams] = useSearchParams();

  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<Conversation[]>('/conversations') });

  // ?c=<id>: continue a conversation started in the assistant dock.
  const requested = params.get('c');
  useEffect(() => {
    if (!requested) return;
    void open(requested);
    setParams({}, { replace: true });
  }, [requested, open, setParams]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.messages]);

  return (
    <div className="grid h-[calc(100dvh-4rem)] grid-cols-1 md:grid-cols-[16rem_1fr]">
      <aside className="hidden flex-col border-r border-slate-200 md:flex dark:border-slate-800" aria-label="Conversations">
        <div className="p-3">
          <Button className="w-full" onClick={() => void open(null)}>
            New chat
          </Button>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.data?.map((c) => (
            <li key={c.id} className="group flex items-center">
              <button
                onClick={() => void open(c.id)}
                className={`flex-1 truncate rounded-lg px-3 py-2 text-left text-sm ${
                  c.id === conversationId ? 'bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100' : 'hover:bg-slate-100 dark:hover:bg-slate-900'
                }`}
              >
                {c.title ?? 'New conversation'}
              </button>
              <button
                aria-label={`Delete ${c.title ?? 'conversation'}`}
                onClick={() => void remove(c.id)}
                className="invisible rounded p-1 text-slate-400 hover:text-red-600 group-hover:visible"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-0 flex-col">
        {audience === 'employee' && <ScopeBar scope={state.scope} onClear={() => void clearScope()} />}
        <div className="flex-1 overflow-y-auto px-4 py-6" aria-live="polite">
          <div className="mx-auto max-w-3xl space-y-6">
            {state.messages.length === 0 && <Welcome audience={audience} onPick={(q) => void send(q)} />}
            {state.messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                onChoose={(c) => void choose(c, state.messages[i - 1]?.content ?? '')}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
        <Composer busy={state.busy} onSend={(t) => void send(t)} onStop={stop} audience={audience} />
      </section>
    </div>
  );
}

export function Welcome({ audience, onPick }: { audience: Audience; onPick: (q: string) => void }) {
  return (
    <div className="py-10 text-center">
      <h2 className="text-lg font-semibold">{audience === 'customer' ? 'How can we help?' : 'Ask about customers, payments or your schedule'}</h2>
      <p className="mt-1 text-sm text-slate-500">Answers come from your records, with sources you can check.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS[audience].map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-full border border-slate-300 px-3 py-1.5 text-sm hover:border-brand-500 hover:text-brand-700 dark:border-slate-700 dark:hover:text-brand-100"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ScopeBar({ scope, onClear }: { scope?: ScopeCard; onClear: () => void }) {
  return (
    <div className="flex min-h-11 items-center gap-2 border-b border-slate-200 px-4 py-2 text-sm dark:border-slate-800">
      {scope ? (
        <>
          <Badge tone="brand">{scope.kind}</Badge>
          <span className="whitespace-nowrap font-medium">{scope.name}</span>
          <span className="whitespace-nowrap text-slate-500">{scope.number}</span>
          {scope.detail && <span className="hidden min-w-0 truncate text-slate-500 sm:inline">· {scope.detail}</span>}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
            Clear
          </Button>
        </>
      ) : (
        <span className="text-slate-500">No customer selected — name one in your question.</span>
      )}
    </div>
  );
}

export function MessageView({ message, onChoose }: { message: Message; onChoose: (c: Candidate) => void }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2 text-sm text-white">{message.content}</p>
      </div>
    );
  }
  return (
    <div className="max-w-[92%] space-y-2">
      {message.status && (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <span className="size-2 animate-pulse rounded-full bg-brand-500" />
          {message.status}
        </p>
      )}
      {message.content && (
        <div className="prose-chat rounded-2xl rounded-bl-sm bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <ReactMarkdown>{message.content}</ReactMarkdown>
          {message.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-slate-400 align-text-bottom" />}
        </div>
      )}
      {message.candidates && message.candidates.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a match">
          {message.candidates.map((c) => (
            <button
              key={c.id}
              onClick={() => onChoose(c)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-left text-sm hover:border-brand-500 dark:border-slate-700"
            >
              <span className="block font-medium">{c.label}</span>
              <span className="block text-xs text-slate-500">
                {c.number}
                {c.detail ? ` · ${c.detail}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      {message.citations.length > 0 && <Sources citations={message.citations} />}
      {message.error && <ErrorBanner error={message.error} />}
    </div>
  );
}

function Sources({ citations }: { citations: Citation[] }) {
  return (
    <details className="text-xs text-slate-500">
      <summary className="cursor-pointer select-none">
        {citations.length} source{citations.length === 1 ? '' : 's'}
      </summary>
      <ol className="mt-2 space-y-1">
        {citations.map((c) => (
          <li key={`${c.type}-${c.id}`} className="flex gap-2">
            <span className="font-mono text-slate-400">[{c.n}]</span>
            <span>
              <span className="text-slate-700 dark:text-slate-300">{c.title}</span> <span className="text-slate-400">· {c.id}</span>
              {c.url && (
                <>
                  {' · '}
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-brand-600 underline">
                    receipt
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function Composer({
  busy,
  onSend,
  onStop,
  audience,
  inputRef,
  onFocus,
  placeholder,
  className = 'border-t border-slate-200 p-3 dark:border-slate-800',
}: {
  busy: boolean;
  onSend: (t: string) => void;
  onStop: () => void;
  audience: Audience;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  onFocus?: () => void;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    onSend(text);
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <form onSubmit={submit} className={className}>
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <label htmlFor={id} className="sr-only">
          Message
        </label>
        <textarea
          id={id}
          ref={inputRef}
          onFocus={onFocus}
          rows={1}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? (audience === 'customer' ? 'Ask about your appointments or payments…' : 'Ask about a customer, payments or your schedule…')}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"
        />
        {busy ? (
          <Button type="button" variant="secondary" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!text.trim()}>
            Send
          </Button>
        )}
      </div>
    </form>
  );
}
