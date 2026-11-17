import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../Layout';
import type { Invoice } from '../InvoiceDocument';
import { useApi } from '../../lib/api';
import type { Audience } from '../../lib/auth';
import { date, money } from '../../lib/format';
import { useMe, useSearchOnly } from '../../lib/me';
import { clockIn, dayLabel, downloadIcs, isRequest, upcomingOf, useMyAppointments } from '../../routes/portal/appointments';
import type { Ticket } from '../../routes/portal/TicketPages';
import type { Candidate, Citation, Message, ScopeCard, SuggestedAction } from '../../lib/chat-state';
import { Badge, Button, ErrorBanner, Select, Spinner } from '../ui';
import { useChat, type Conversation } from './useChat';

const SUGGESTIONS: Record<Audience, string[]> = {
  customer: ['When is my next appointment?', 'Did my last payment go through?', 'How much do I owe?', 'What services do you offer?'],
  employee: ["What's on my schedule this week?", 'Any overdue bank transfers?', 'Show unmatched Stripe payments', 'Show me Maria Lopez’s appointments'],
};

/** Without a model: short searches the rules answer well. */
const SEARCH_SUGGESTIONS: Record<Audience, string[]> = {
  customer: ['Next appointment', 'My payments', 'What do I owe?', 'Services and prices', 'Locations'],
  employee: ['My schedule this week', 'Overdue bank transfers', 'Unmatched Stripe payments', 'Maria Lopez'],
};

/** Chat for customers (portal) and employees (staff console); answers stream from the API (SSE). */
export function ChatPage({ audience }: { audience: Audience }) {
  return audience === 'customer' ? <CustomerChat /> : <StaffChat audience={audience} />;
}

/** The conversation, plus ?c=<id> (continue one from the dock) and ?q=<question> (ask it once). */
function useChatPage(audience: Audience) {
  const chat = useChat(audience);
  const { open, send } = chat;
  const [params, setParams] = useSearchParams();

  const requested = params.get('c');
  useEffect(() => {
    if (!requested) return;
    void open(requested);
    setParams({}, { replace: true });
  }, [requested, open, setParams]);

  const asked = params.get('q');
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!asked || askedRef.current === asked) return;
    askedRef.current = asked;
    setParams({}, { replace: true });
    void send(asked);
  }, [asked, send, setParams]);
  return chat;
}

function StaffChat({ audience }: { audience: Audience }) {
  const api = useApi();
  const { conversationId, state, open, send, choose, clearScope, remove, stop } = useChatPage(audience);
  const searchOnly = useSearchOnly();
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<Conversation[]>('/conversations') });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.messages]);

  return (
    <div className="grid h-[calc(100dvh-4rem)] grid-cols-1 md:grid-cols-[16rem_1fr]">
      <aside className="hidden flex-col border-r border-slate-200 md:flex dark:border-slate-800" aria-label={searchOnly ? 'Recent searches' : 'Conversations'}>
        <div className="p-3">
          <Button className="w-full" onClick={() => void open(null)}>
            {searchOnly ? 'New search' : 'New chat'}
          </Button>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.data?.map((c) => (
            <li key={c.id} className="group flex items-center">
              <button
                onClick={() => void open(c.id)}
                className={`press flex-1 truncate rounded-lg px-3 py-2 text-left text-sm ${
                  c.id === conversationId ? 'bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100' : 'hover:bg-slate-100 dark:hover:bg-slate-900'
                }`}
              >
                {c.title ?? (searchOnly ? 'New search' : 'New conversation')}
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
                audience={audience}
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

const railBox = 'rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900';
const railLabel = 'text-xs font-semibold tracking-wider text-slate-500 uppercase';
const railButton =
  'press inline-flex min-h-10 flex-1 items-center justify-center rounded-lg border border-slate-300 px-3 text-sm font-semibold hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800';

/** Customers: the conversation in a card, with their next appointment, balance and support beside it. */
function CustomerChat() {
  const api = useApi();
  const { me } = useMe();
  const { conversationId, state, open, send, choose, remove, stop } = useChatPage('customer');
  const searchOnly = useSearchOnly();
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.get<Conversation[]>('/conversations') });
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.messages]);
  const first = me?.profile.first_name;
  const suggestions = (searchOnly ? SEARCH_SUGGESTIONS : SUGGESTIONS).customer;
  const past = conversations.data ?? [];

  return (
    <Page>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="flex min-h-[32rem] flex-col rounded-xl border border-slate-200 bg-white shadow-xs lg:h-[calc(100dvh-8rem-var(--dock-gap,0px))] dark:border-slate-800 dark:bg-slate-900">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-6 py-5 dark:border-slate-800">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight">{searchOnly ? 'Search your account' : `Hi${first ? ` ${first}` : ''}, how can we help?`}</h1>
              <p className="mt-1 text-sm text-slate-500">
                {searchOnly
                  ? 'Type a few words. Results come from your account and our help articles.'
                  : 'Ask about your appointments, invoices or our services. Answers come from your account and our help articles.'}
              </p>
            </div>
            {(past.length > 0 || state.messages.length > 0) && (
              <div className="flex shrink-0 items-center gap-2">
                {past.length > 0 && (
                  <div className="w-44">
                    <Select aria-label="Past conversations" value={conversationId ?? ''} onChange={(e) => void open(e.target.value || null)} className="py-1.5 text-sm">
                      <option value="">{searchOnly ? 'Past searches' : 'Past conversations'}</option>
                      {past.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title ?? 'Untitled'}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
                {conversationId && (
                  <Button size="sm" variant="ghost" onClick={() => window.confirm('Delete this conversation?') && void remove(conversationId)}>
                    Delete
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => void open(null)}>
                  New
                </Button>
              </div>
            )}
          </header>
          <div className="flex-1 overflow-y-auto px-6 py-6" aria-live="polite">
            <div className="space-y-6">
              {state.messages.map((m, i) => (
                <MessageView key={m.id} message={m} audience="customer" onChoose={(c) => void choose(c, state.messages[i - 1]?.content ?? '')} />
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
          <div className="border-t border-slate-100 px-6 pt-4 pb-5 dark:border-slate-800">
            <div className="mb-3 flex flex-wrap gap-2">
              {suggestions.slice(0, 4).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={state.busy}
                  onClick={() => void send(s)}
                  className="press rounded-full border border-slate-200 px-3 py-1.5 text-sm hover:border-brand-500 hover:text-brand-700 disabled:opacity-50 dark:border-slate-700 dark:hover:text-brand-100"
                >
                  {s}
                </button>
              ))}
            </div>
            <Composer busy={state.busy} onSend={(t) => void send(t)} onStop={stop} audience="customer" placeholder="Ask a question…" className="[&>div]:max-w-none" />
          </div>
        </section>
        <aside className="grid gap-4" aria-label="Your account">
          <NextAppointmentCard />
          <BalanceCard />
          <SupportCard />
        </aside>
      </div>
    </Page>
  );
}

function NextAppointmentCard() {
  const q = useMyAppointments();
  const next = upcomingOf(q.data)[0];
  return (
    <section className={railBox}>
      <h2 className={railLabel}>Next appointment</h2>
      {q.isLoading ? (
        <Spinner />
      ) : !next ? (
        <>
          <p className="mt-2 text-sm text-slate-500">Nothing booked.</p>
          <div className="mt-3 flex">
            <Link to="/portal/book" className={railButton}>
              Book an appointment
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-xl font-bold tracking-tight">
            {dayLabel(next.scheduled_start, next.time_zone)}, {clockIn(next.scheduled_start, next.time_zone)}
          </p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{[next.service_name, next.employee_name, next.location_name].filter(Boolean).join(' · ')}</p>
          {isRequest(next) && <p className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-400">Waiting for confirmation</p>}
          <div className="mt-4 flex gap-2">
            <Link to="/portal/appointments" className={railButton}>
              Details
            </Link>
            <button type="button" onClick={() => downloadIcs(next)} className={railButton}>
              Add to calendar
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function BalanceCard() {
  const api = useApi();
  const q = useQuery({ queryKey: ['invoices', 'mine'], queryFn: () => api.get<{ items: Invoice[] }>('/invoices?limit=200') });
  const open = (q.data?.items ?? [])
    .filter((i) => i.status === 'sent' && Number(i.balance) > 0)
    .sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999'));
  const first = open[0];
  const total = open.filter((i) => i.currency === first?.currency).reduce((sum, i) => sum + Number(i.balance), 0);
  return (
    <section className={railBox}>
      <h2 className={railLabel}>Balance due</h2>
      {q.isLoading ? (
        <Spinner />
      ) : !first ? (
        <p className="mt-2 text-sm text-slate-500">You're all paid up.</p>
      ) : (
        <>
          <p className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold tracking-tight tabular-nums">{money(total, first.currency)}</span>
            {first.due_on && <span className={`text-sm ${first.overdue ? 'font-semibold text-red-700 dark:text-red-400' : 'text-slate-500'}`}>{first.overdue ? 'Overdue' : `Due ${date(first.due_on)}`}</span>}
          </p>
          <Link
            to={`/portal/invoices/${first.id}`}
            className="press mt-4 flex min-h-11 items-center justify-center rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white hover:bg-brand-800"
          >
            Pay {first.invoice_number}
          </Link>
          {open.length > 1 && (
            <Link to="/portal/invoices" className="mt-2 block text-center text-xs font-semibold text-brand-700 hover:underline dark:text-brand-600">
              {open.length} open invoices
            </Link>
          )}
        </>
      )}
    </section>
  );
}

function SupportCard() {
  const api = useApi();
  const q = useQuery({ queryKey: ['tickets', 'self'], queryFn: () => api.get<Ticket[]>('/tickets') });
  const active = (q.data ?? []).filter((t) => t.status === 'open' || t.status === 'pending').sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))[0];
  return (
    <section className={railBox}>
      <h2 className={railLabel}>Support</h2>
      {q.isLoading ? (
        <Spinner />
      ) : !active ? (
        <p className="mt-2 text-sm text-slate-500">
          Need a person?{' '}
          <Link to="/portal/tickets" className="font-semibold text-brand-700 hover:underline dark:text-brand-600">
            Contact support
          </Link>
        </p>
      ) : (
        <Link to={`/portal/tickets/${active.id}`} className="group mt-2 block">
          <span className="block text-sm font-semibold group-hover:underline">{active.subject}</span>
          <span className={`mt-0.5 block text-sm font-semibold ${active.status === 'pending' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500'}`}>
            {active.status === 'pending' ? `${active.assigned_to_name ?? 'We'} replied · waiting on you` : "Open · we'll reply soon"}
          </span>
        </Link>
      )}
    </section>
  );
}

export function Welcome({ audience, onPick }: { audience: Audience; onPick: (q: string) => void }) {
  const searchOnly = useSearchOnly();
  const title = searchOnly
    ? audience === 'customer'
      ? 'Search your appointments, payments and help'
      : 'Search customers, payments and your schedule'
    : audience === 'customer'
      ? 'How can we help?'
      : 'Ask about customers, payments or your schedule';
  return (
    <div className="py-10 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">
        {searchOnly
          ? audience === 'customer'
            ? 'Type a few words. Results come from your records, with sources you can check.'
            : 'Type a name, an email, a number or a few words. Results come from your records, with sources you can check.'
          : 'Answers come from your records, with sources you can check.'}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {(searchOnly ? SEARCH_SUGGESTIONS : SUGGESTIONS)[audience].map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="press rounded-full border border-slate-300 px-3 py-1.5 text-sm hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700 dark:border-slate-700 dark:hover:bg-slate-800 dark:hover:text-brand-100"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ScopeBar({ scope, onClear }: { scope?: ScopeCard; onClear: () => void }) {
  const searchOnly = useSearchOnly();
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
        <span className="text-slate-500">{searchOnly ? 'No customer selected — search for one by name, email or number.' : 'No customer selected — name one in your question.'}</span>
      )}
    </div>
  );
}

export function MessageView({
  message,
  audience,
  onChoose,
  onAction,
}: {
  message: Message;
  audience: Audience;
  onChoose: (c: Candidate) => void;
  /** Called when a suggested action is followed (the dock minimizes so the page is clear). */
  onAction?: () => void;
}) {
  const searchOnly = useSearchOnly();
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p
          className={`max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm px-4 py-2 text-sm ${audience === 'customer' ? 'bg-brand-700 font-medium text-white' : 'btn-gradient'}`}
        >
          {message.content}
        </p>
      </div>
    );
  }
  // Search mode: the records found, as a list of links (the text only says when nothing was found).
  const results = searchOnly && !message.streaming && message.citations.length > 0;
  return (
    <div className="max-w-[92%] space-y-2">
      {message.status && (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <span className="size-2 animate-pulse rounded-full bg-brand-500" />
          {message.status}
        </p>
      )}
      {message.content && !results && (
        <div
          className={`prose-chat rounded-2xl rounded-bl-sm px-4 py-3 text-sm ${
            audience === 'customer' ? 'bg-slate-100 dark:bg-slate-800' : 'bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800'
          }`}
        >
          <AnswerText content={message.content} citations={message.citations} onFollow={onAction} />
          {message.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-slate-400 align-text-bottom" />}
        </div>
      )}
      {message.candidates && message.candidates.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a match">
          {message.candidates.map((c) => (
            <div key={c.id} className="flex items-stretch overflow-hidden rounded-lg border border-slate-300 text-sm transition-colors hover:border-brand-500 dark:border-slate-700">
              <button onClick={() => onChoose(c)} title={`Answer about ${c.label}`} className="press px-3 py-2 text-left hover:bg-brand-50 dark:hover:bg-slate-800">
                <span className="block font-medium">{c.label}</span>
                <span className="block text-xs text-slate-500">
                  {c.number}
                  {c.detail ? ` · ${c.detail}` : ''}
                </span>
              </button>
              {audience === 'employee' && c.kind === 'customer' && (
                <Link
                  to={`/staff/customers/${c.id}`}
                  onClick={onAction}
                  aria-label={`Open ${c.label}'s record`}
                  className="press flex items-center border-l border-slate-200 px-3 text-xs font-medium text-brand-600 hover:bg-brand-50 hover:underline dark:border-slate-800 dark:hover:bg-slate-800"
                >
                  Open
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
      {message.actions && message.actions.length > 0 && !message.streaming && <ActionButtons actions={message.actions} audience={audience} onFollow={onAction} />}
      {results ? <Results citations={message.citations} onFollow={onAction} /> : message.citations.length > 0 && <Sources citations={message.citations} onFollow={onAction} open={audience === 'customer'} />}
      {message.error && <ErrorBanner error={message.error} />}
    </div>
  );
}

/** Where a suggested action leads: the booking page (prefilled) or a help article, per audience. */
function actionHref(a: SuggestedAction, audience: Audience): string {
  const base = audience === 'customer' ? '/portal' : '/staff';
  if (a.type === 'article') return `${base}/help/${a.slug}`;
  if (audience === 'customer') return a.service_id ? `/portal/book?service=${a.service_id}` : '/portal/book';
  return a.service_id ? `/staff?book=${a.service_id}` : '/staff?book=';
}

function ActionButtons({ actions, audience, onFollow }: { actions: SuggestedAction[]; audience: Audience; onFollow?: () => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested actions">
      {actions.map((a) => (
        <Link
          key={`${a.type}:${a.type === 'book' ? a.service_id : a.slug}`}
          to={actionHref(a, audience)}
          onClick={onFollow}
          className="press btn-outline-gradient rounded-full px-3.5 py-1.5 text-sm font-semibold text-brand-700 dark:text-brand-600"
        >
          {a.label}
        </Link>
      ))}
    </div>
  );
}

const EXTERNAL_LABEL: Record<string, string> = { payment: 'receipt' };

/** What kind of record a source is, in words. */
const TYPE_LABEL: Record<string, string> = {
  customer: 'Customer',
  organization: 'Organization',
  appointment: 'Appointment',
  payment: 'Payment',
  balance: 'Balance',
  service: 'Service',
  location: 'Location',
  ticket: 'Ticket',
  product: 'Product',
  answer: 'Saved answer',
  article: 'Help article',
};
const typeLabel = (c: Citation) => TYPE_LABEL[c.type] ?? c.type;

/** The record number shown with a source (none for balances, saved answers and articles). */
function recordNumber(c: Citation): string | null {
  return c.type === 'balance' || c.type === 'answer' || c.type === 'article' ? null : c.id;
}

/** "Ticket #5001", "Service CODE-REVIEW", "Saved answer": the source's kind and number, for tooltips. */
const describe = (c: Citation) => [typeLabel(c), recordNumber(c)].filter(Boolean).join(' ') + `: ${c.title}`;

/** Markdown answer text whose [n] markers link to their sources. */
function AnswerText({ content, citations, onFollow }: { content: string; citations: Citation[]; onFollow?: () => void }) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const linked = content.replace(/\[(\d{1,2})\](?!\()/g, (m, n: string) => (byN.has(Number(n)) ? `[${n}](#source-${n})` : m));
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => {
          const c = href?.startsWith('#source-') ? byN.get(Number(href.slice(8))) : undefined;
          if (!c) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          const chip = 'mx-0.5 inline-block rounded bg-brand-50 px-1 align-baseline font-mono text-[0.7rem] leading-4 text-brand-700 no-underline dark:bg-slate-800 dark:text-brand-600';
          return c.link ? (
            <Link to={c.link} onClick={onFollow} title={describe(c)} aria-label={`Source ${c.n}: ${describe(c)}`} className={`${chip} hover:underline`}>
              {c.n}
            </Link>
          ) : (
            <span title={describe(c)} aria-label={`Source ${c.n}: ${describe(c)}`} className={chip}>
              {c.n}
            </span>
          );
        },
      }}
    >
      {linked}
    </ReactMarkdown>
  );
}

/** Search mode: every record found, with its kind, a link and its number. */
function Results({ citations, onFollow }: { citations: Citation[]; onFollow?: () => void }) {
  return (
    <div className="overflow-hidden rounded-2xl rounded-bl-sm bg-white text-sm shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <p className="border-b border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
        {citations.length} result{citations.length === 1 ? '' : 's'}
      </p>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {citations.map((c) => {
          const body = (
            <>
              <span className="flex items-baseline gap-2">
                <Badge>{typeLabel(c)}</Badge>
                <span className={`min-w-0 flex-1 font-medium ${c.link ? 'text-brand-600 group-hover:underline' : ''}`}>{c.title}</span>
                {recordNumber(c) && <span className="shrink-0 font-mono text-xs text-slate-500">{recordNumber(c)}</span>}
                {c.link && c.type === 'service' ? (
                  <span className="shrink-0 self-center rounded-full border border-brand-500/40 px-2 py-0.5 text-xs font-semibold text-brand-600 group-hover:border-brand-500">Book service</span>
                ) : (
                  c.link && <ChevronRight className="size-4 shrink-0 self-center text-slate-400 group-hover:text-brand-600" aria-hidden="true" />
                )}
              </span>
              {c.excerpt && <span className="mt-1 line-clamp-2 block text-slate-600 dark:text-slate-400">{c.excerpt}</span>}
            </>
          );
          return (
            <li key={`${c.type}-${c.id}`} className="flex items-start">
              {c.link ? (
                <Link to={c.link} onClick={onFollow} className="group block min-w-0 flex-1 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  {body}
                </Link>
              ) : (
                <div className="min-w-0 flex-1 px-4 py-2.5">{body}</div>
              )}
              {c.url && (
                <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 px-4 py-2.5 text-xs text-brand-600 underline">
                  {EXTERNAL_LABEL[c.type] ?? 'open'}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Sources({ citations, onFollow, open }: { citations: Citation[]; onFollow?: () => void; open?: boolean }) {
  // Customers: the sources listed under the answer, numbered like the markers in it.
  if (open)
    return (
      <ol className="space-y-0.5 text-xs text-slate-500">
        {citations.map((c) => (
          <li key={`${c.type}-${c.id}`}>
            {c.n} ·{' '}
            {c.link ? (
              <Link to={c.link} onClick={onFollow} className="hover:text-brand-700 hover:underline">
                {typeLabel(c)}: {c.title}
              </Link>
            ) : (
              <span>
                {typeLabel(c)}: {c.title}
              </span>
            )}
            {c.url && (
              <>
                {' · '}
                <a href={c.url} target="_blank" rel="noreferrer" className="text-brand-600 underline">
                  {EXTERNAL_LABEL[c.type] ?? 'open'}
                </a>
              </>
            )}
          </li>
        ))}
      </ol>
    );
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
              {c.link ? (
                <Link to={c.link} onClick={onFollow} className="text-brand-600 hover:underline dark:text-brand-100">
                  {c.title}
                </Link>
              ) : (
                <span className="text-slate-700 dark:text-slate-300">{c.title}</span>
              )}{' '}
              <span className="text-slate-400">
                · {typeLabel(c)}
                {recordNumber(c) ? ` ${recordNumber(c)}` : ''}
              </span>
              {c.url && (
                <>
                  {' · '}
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-brand-600 underline">
                    {EXTERNAL_LABEL[c.type] ?? 'open'}
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
  const searchOnly = useSearchOnly();
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
          placeholder={
            placeholder ??
            (searchOnly
              ? audience === 'customer'
                ? 'Search your appointments, payments and help…'
                : 'Search customers, payments, your schedule and help…'
              : audience === 'customer'
                ? 'Ask about your appointments or payments…'
                : 'Ask about a customer, payments or your schedule…')
          }
          className="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"
        />
        {busy ? (
          <Button type="button" variant="secondary" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!text.trim()}>
            {searchOnly ? 'Search' : 'Send'}
          </Button>
        )}
      </div>
    </form>
  );
}
