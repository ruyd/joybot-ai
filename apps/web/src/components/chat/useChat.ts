import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useReducer, useRef, useState } from 'react';
import { useApi } from '../../lib/api';
import type { Audience } from '../../lib/auth';
import { chatReducer, initialChat, type Candidate, type Citation, type ScopeCard, type SuggestedAction } from '../../lib/chat-state';
import { readSse } from '../../lib/sse';

export interface Conversation {
  id: string;
  title: string | null;
  active_customer_id: string | null;
  active_organization_id: string | null;
  updated_at: string;
}

/**
 * One chat conversation: loading, sending (answers stream from the API as SSE), disambiguation and
 * scope. Shared by the Assistant page and the assistant dock at the bottom of every other page.
 */
export function useChat(audience: Audience) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const abortRef = useRef<AbortController | null>(null);
  const openSeq = useRef(0); // the latest open() wins when conversations are switched quickly

  const open = useCallback(
    async (id: string | null) => {
      abortRef.current?.abort();
      const seq = ++openSeq.current;
      setConversationId(id);
      dispatch({ type: 'scope', scope: undefined });
      if (!id) {
        dispatch({ type: 'load', messages: [] });
        return;
      }
      // Employees: also restore the customer or organization the conversation is pinned to.
      const [rows, pinned] = await Promise.all([
        api.get<{ id: string; role: 'user' | 'assistant'; content: string; citations: Citation[]; actions?: SuggestedAction[] }[]>(`/conversations/${id}/messages`),
        audience === 'employee' ? api.get<{ scope: ScopeCard | null }>(`/conversations/${id}/scope`) : Promise.resolve({ scope: null }),
      ]);
      if (seq !== openSeq.current) return;
      dispatch({ type: 'load', messages: rows.map((r) => ({ ...r, citations: r.citations ?? [], actions: r.actions ?? [] })) });
      dispatch({ type: 'scope', scope: pinned.scope ?? undefined });
    },
    [api, audience],
  );

  const send = useCallback(
    async (text: string, forConversation?: string) => {
      const question = text.trim();
      if (!question || state.busy) return;
      let id = forConversation ?? conversationId;
      try {
        if (!id) {
          id = (await api.post<Conversation>('/conversations', {})).id;
          setConversationId(id);
        }
        dispatch({ type: 'send', text: question, id: crypto.randomUUID() });
        const controller = new AbortController();
        abortRef.current = controller;
        const res = await api.fetch(`/conversations/${id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ content: question }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? (res.status === 429 ? 'Too many messages — please wait a moment.' : `Request failed (${res.status})`));
        }
        await readSse(res, (e) => dispatch({ type: 'event', event: e.event, data: e.data }));
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      } catch (err) {
        if ((err as Error).name === 'AbortError') dispatch({ type: 'aborted' });
        else dispatch({ type: 'failed', message: (err as Error).message });
      } finally {
        abortRef.current = null;
      }
    },
    [api, conversationId, queryClient, state.busy],
  );

  /** Disambiguation: pin the chosen record, then ask the same question again. */
  const choose = useCallback(
    async (candidate: Candidate, question: string) => {
      if (!conversationId) return;
      await api.put(`/conversations/${conversationId}/scope`, {
        customer_id: candidate.kind === 'customer' ? candidate.id : null,
        organization_id: candidate.kind === 'organization' ? candidate.id : null,
      });
      dispatch({ type: 'scope', scope: { kind: candidate.kind, id: candidate.id, name: candidate.label, number: candidate.number, detail: candidate.detail } });
      await send(question, conversationId);
    },
    [api, conversationId, send],
  );

  const clearScope = useCallback(async () => {
    if (!conversationId) return;
    await api.put(`/conversations/${conversationId}/scope`, { customer_id: null, organization_id: null });
    dispatch({ type: 'scope', scope: undefined });
  }, [api, conversationId]);

  const remove = useCallback(
    async (id: string) => {
      await api.del(`/conversations/${id}`);
      if (id === conversationId) void open(null);
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    [api, conversationId, open, queryClient],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { conversationId, state, open, send, choose, clearScope, remove, stop };
}
