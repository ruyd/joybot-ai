import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Audience } from '../../lib/auth';
import { Button } from '../ui';
import { Composer, MessageView, ScopeBar, Welcome } from './ChatPage';
import { useChat } from './useChat';

const STORAGE_KEY = 'joybot.dock';

function remembered(audience: Audience): string | null {
  try {
    return sessionStorage.getItem(`${STORAGE_KEY}.${audience}`);
  } catch {
    return null;
  }
}

function remember(audience: Audience, conversationId: string | null) {
  try {
    if (conversationId) sessionStorage.setItem(`${STORAGE_KEY}.${audience}`, conversationId);
    else sessionStorage.removeItem(`${STORAGE_KEY}.${audience}`);
  } catch {
    // storage unavailable (private mode): the dock simply starts fresh after a reload
  }
}

/**
 * The assistant on every page: a prompt docked in the bottom-right corner that opens into a small
 * conversation panel, so questions can be asked without leaving (or covering) the work on screen.
 * It stays mounted across pages, so the conversation carries on while navigating.
 */
export function AssistantDock({ audience, fullView, hidden }: { audience: Audience; fullView: string; hidden: boolean }) {
  const { conversationId, state, open, send, choose, clearScope, stop } = useChat(audience);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Pick up the conversation from before a reload (collapsed), and remember the current one.
  useEffect(() => {
    const id = remembered(audience);
    if (id) open(id).catch(() => remember(audience, null));
  }, [audience, open]);
  useEffect(() => remember(audience, conversationId), [audience, conversationId]);

  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [expanded, state.messages]);

  const ask = (text: string) => {
    setExpanded(true);
    void send(text);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && expanded) {
      e.stopPropagation();
      setExpanded(false);
    }
  };

  if (hidden) return null;
  const summary = state.busy ? 'answering…' : state.messages.length ? `${state.messages.length} message${state.messages.length === 1 ? '' : 's'}` : '';

  return (
    <div onKeyDown={onKeyDown}>
      {expanded && (
        <section
          id="assistant-dock-panel"
          aria-label="Assistant conversation"
          className="fixed inset-x-2 bottom-[4.5rem] z-30 flex h-[min(60dvh,32rem)] flex-col rounded-xl border border-slate-200 bg-white shadow-xl sm:inset-x-auto sm:right-4 sm:w-[28rem] dark:border-slate-800 dark:bg-slate-950"
        >
          <header className="flex items-center gap-1 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <img src="/favicon.svg" alt="" className="size-5" />
            <h2 className="flex-1 pl-1 text-sm font-semibold">Assistant</h2>
            <Button size="sm" variant="ghost" onClick={() => void open(null)} disabled={state.busy}>
              New chat
            </Button>
            <Link
              to={conversationId ? `${fullView}?c=${conversationId}` : fullView}
              className="rounded-lg px-2 py-1 text-sm text-brand-600 hover:bg-slate-100 dark:hover:bg-slate-900"
            >
              Full view
            </Link>
            <Button size="sm" variant="ghost" aria-label="Minimize assistant" onClick={() => setExpanded(false)}>
              ▾
            </Button>
          </header>
          {audience === 'employee' && <ScopeBar scope={state.scope} onClear={() => void clearScope()} />}
          <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4" aria-live="polite">
            {state.messages.length === 0 ? (
              <Welcome audience={audience} onPick={ask} />
            ) : (
              state.messages.map((m, i) => (
                <MessageView key={m.id} message={m} onChoose={(c) => void choose(c, state.messages[i - 1]?.content ?? '')} />
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </section>
      )}

      <aside
        aria-label="Assistant"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"
      >
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-controls="assistant-dock-panel"
            className="flex shrink-0 items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-900"
          >
            <img src="/favicon.svg" alt="" className="size-5" />
            <span className="hidden font-medium sm:inline">Assistant</span>
            {summary && <span className="hidden text-slate-500 md:inline">· {summary}</span>}
            <span aria-hidden className="text-slate-500">{expanded ? '▾' : '▴'}</span>
          </button>
          <div className="min-w-0 flex-1">
            <Composer busy={state.busy} onSend={ask} onStop={stop} audience={audience} inputRef={inputRef} placeholder="Ask the assistant…" className="" />
          </div>
        </div>
      </aside>
    </div>
  );
}
