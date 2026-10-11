import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/api';
import { useSession } from '../../lib/auth';
import { fullName } from '../../lib/format';
import type { Me } from '../../lib/me';
import { initials, ROLE_LABEL } from '../HeaderControls';
import { Button, ErrorBanner, Input, Spinner } from '../ui';

interface LastMessage {
  id: string;
  body: string;
  created_at: string;
  sender_id: string | null;
  sender_name: string | null;
  link: string | null;
}

interface Channel {
  id: string;
  kind: 'everyone' | 'direct' | 'group' | 'notifications';
  name: string | null;
  members: { id: string; name: string | null }[] | null;
  last_message: LastMessage | null;
  unread: number;
}

interface Message extends LastMessage {
  channel_id: string;
}

interface Person {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

type View = { kind: 'list' } | { kind: 'channel'; id: string } | { kind: 'new-direct' } | { kind: 'new-group' };

interface Toast {
  key: string;
  channelId: string;
  title: string;
  body: string;
}

const personName = (p: Person) => [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Colleague';

/**
 * The staff avatar opens this drawer from the right: the account links that used to be its menu, then
 * team chat (everyone, direct messages, group channels and the notifications channel). Channels are
 * polled; new messages can chime and pop up a toast (the employee's preferences).
 */
export function TeamDrawer({ me, base }: { me: Me; base: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);

  const channels = useQuery({
    queryKey: ['team', 'channels'],
    queryFn: () => api.get<Channel[]>('/team/channels'),
    refetchInterval: open ? 4000 : 10_000,
    // Keep checking in a background tab, so the chime still plays while working elsewhere.
    refetchIntervalInBackground: true,
  });
  const unread = (channels.data ?? []).reduce((n, c) => n + c.unread, 0);
  const notifications = channels.data?.find((c) => c.kind === 'notifications');
  const openChannel = view.kind === 'channel' && open ? view.id : null;

  // New messages since the last poll: chime and toast, unless that conversation is on screen.
  const lastSeen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!channels.data) return;
    const seen = new Map(channels.data.map((c) => [c.id, c.last_message?.id ?? '']));
    const previous = lastSeen.current;
    lastSeen.current = seen;
    if (!previous) return; // first load: nothing is "new"
    const fresh = channels.data.filter(
      (c) => c.last_message && previous.get(c.id) !== c.last_message.id && c.last_message.sender_id !== me.profile.id && c.unread > 0 && c.id !== openChannel,
    );
    if (!fresh.length) return;
    if (me.profile.chat_sound !== false) chime();
    if (me.profile.chat_toast !== false) {
      setToasts((list) =>
        [
          ...list,
          ...fresh.map((c) => ({
            key: c.last_message!.id,
            channelId: c.id,
            title: channelTitle(c),
            body: preview(c, me.profile.id),
          })),
        ].slice(-3),
      );
    }
  }, [channels.data, me.profile.id, me.profile.chat_sound, me.profile.chat_toast, openChannel]);

  // Close with Escape; focus moves into the drawer and back to the avatar.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const close = () => {
    setOpen(false);
    avatarRef.current?.focus();
  };
  const show = (channelId: string) => {
    setView({ kind: 'channel', id: channelId });
    setOpen(true);
  };

  const item =
    'press block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100 hover:text-brand-700 dark:hover:bg-slate-800 dark:hover:text-brand-600';
  return (
    <>
      <button
        ref={avatarRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Account and team chat for ${fullName(me.profile)}${unread ? `, ${unread} unread` : ''}`}
        className="press relative flex size-9 items-center justify-center rounded-full logo-accent text-sm font-semibold hover:ring-4 hover:ring-[#67d5df]/35"
      >
        {initials(me)}
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-semibold leading-5 text-white ring-2 ring-white dark:ring-slate-950">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* In <body>: the header's backdrop blur would otherwise be the box these fixed layers sit in. */}
      {createPortal(
        <>
          {/* Backdrop */}
          <div
            className={`fixed inset-0 z-40 bg-slate-950/30 transition-opacity duration-200 ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            onClick={close}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Account and team chat"
            inert={!open}
            className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none dark:border-slate-800 dark:bg-slate-900 ${
              open ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <header className="flex items-start gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full logo-accent text-sm font-semibold">
                {initials(me)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{fullName(me.profile)}</p>
                <p className="truncate text-xs text-slate-500">{[me.profile.email, ROLE_LABEL[me.role]].filter(Boolean).join(' · ')}</p>
              </div>
              <Button ref={closeRef} variant="ghost" size="sm" aria-label="Close" onClick={close}>
                <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </Button>
            </header>
            <nav aria-label="Account" className="grid border-b border-slate-200 p-2 pb-3 dark:border-slate-800">
              <Link to={`${base}/profile`} className={item} onClick={close}>
                Profile & preferences
              </Link>
              <Link to="/staff/schedule" className={item} onClick={close}>
                My hours & time off
              </Link>
              <button type="button" className={item} onClick={() => void session.signOut()}>
                Sign out
              </button>
            </nav>

            {/* Team chat: a box in the logo colours (a title bar in the logo gradient, a faint tint). */}
            <section
              aria-labelledby="team-chat-title"
              className="relative mx-3 mb-3 mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl rounded-t-md border border-[#1c9dab]/30 bg-[#67d5df]/[0.06] dark:border-[#67d5df]/25 dark:bg-[#67d5df]/[0.04]"
            >
              <h2 id="team-chat-title" className="logo-accent flex shrink-0 items-center gap-2 px-3 py-2 text-sm font-semibold">
                <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 4.5h9.5v6.5H7.5L4.5 13.5V11H3z" />
                  <path d="M12.5 7.5H17v6.5h-1.5v2.5L12.5 14H8.5v-3" />
                </svg>
                Team chat
              </h2>
              {view.kind === 'channel' && channels.data?.find((c) => c.id === view.id) ? (
                <ChannelView
                  channel={channels.data.find((c) => c.id === view.id)!}
                  myId={me.profile.id}
                  active={open}
                  onBack={() => setView({ kind: 'list' })}
                  onFollowLink={close}
                />
              ) : view.kind === 'new-direct' ? (
                <NewDirect onBack={() => setView({ kind: 'list' })} onOpened={(id) => setView({ kind: 'channel', id })} />
              ) : view.kind === 'new-group' ? (
                <NewGroup onBack={() => setView({ kind: 'list' })} onCreated={(id) => setView({ kind: 'channel', id })} />
              ) : (
                <ChannelList
                  channels={channels.data}
                  notifications={notifications}
                  myId={me.profile.id}
                  loading={channels.isLoading}
                  error={channels.error}
                  onOpen={(id) => setView({ kind: 'channel', id })}
                  onNewDirect={() => setView({ kind: 'new-direct' })}
                  onNewGroup={() => setView({ kind: 'new-group' })}
                />
              )}
            </section>
          </aside>

          <Toasts
            toasts={toasts}
            onOpen={(t) => {
              setToasts((list) => list.filter((x) => x.key !== t.key));
              show(t.channelId);
              void queryClient.invalidateQueries({ queryKey: ['team'] });
            }}
            onDismiss={(t) => setToasts((list) => list.filter((x) => x.key !== t.key))}
          />
        </>,
        document.body,
      )}
    </>
  );
}

/** The last message as a one-liner: "You: …", "Sam: …" in channels; no name in a direct message (its title is the sender). */
function preview(c: Channel, myId: string) {
  const m = c.last_message!;
  if (m.sender_id === myId) return `You: ${m.body}`;
  return c.kind !== 'direct' && m.sender_name ? `${m.sender_name}: ${m.body}` : m.body;
}

function channelTitle(c: Channel) {
  if (c.kind === 'everyone') return '# everyone';
  if (c.kind === 'group') return `# ${c.name ?? 'channel'}`;
  return c.name ?? 'Direct message';
}

// Notifications -----------------------------------------------------------------------------------

/** JoyBot's notices for you, at the top of team chat: the latest one, and a bell with the unread count. */
function NotificationsRow({ channel, onOpen }: { channel: Channel; onOpen: () => void }) {
  const unread = channel.unread;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      className="press mb-3 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
    >
      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${unread ? 'font-semibold' : 'font-medium'}`}>Notifications</span>
        <span className="block truncate text-xs text-slate-500">{channel.last_message ? channel.last_message.body : 'Nothing yet'}</span>
      </span>
      {channel.last_message && <span className="shrink-0 text-[11px] text-slate-500">{ago(channel.last_message.created_at)}</span>}
      <span className={`relative flex size-8 shrink-0 items-center justify-center rounded-full ${unread ? 'logo-accent' : 'text-slate-500'}`} aria-hidden="true">
        <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3a4.5 4.5 0 0 0-4.5 4.5c0 3.5-1.5 5-1.5 5h12s-1.5-1.5-1.5-5A4.5 4.5 0 0 0 10 3Z" />
          <path d="M8.5 15.5a1.5 1.5 0 0 0 3 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-4 text-white ring-2 ring-white dark:ring-slate-900">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </span>
    </button>
  );
}

// Channel list ------------------------------------------------------------------------------------

function ChannelList({
  channels,
  notifications,
  myId,
  loading,
  error,
  onOpen,
  onNewDirect,
  onNewGroup,
}: {
  channels?: Channel[];
  notifications?: Channel;
  myId: string;
  loading: boolean;
  error: unknown;
  onOpen: (id: string) => void;
  onNewDirect: () => void;
  onNewGroup: () => void;
}) {
  const sections: { title: string; kinds: Channel['kind'][]; action?: { label: string; onClick: () => void } }[] = [
    { title: 'Channels', kinds: ['everyone', 'group'], action: { label: 'New channel', onClick: onNewGroup } },
    { title: 'Direct messages', kinds: ['direct'], action: { label: 'New message', onClick: onNewDirect } },
  ];
  return (
    <div className="flex-1 overflow-y-auto px-2 pb-3 pt-2">
      {loading && <Spinner />}
      {error ? <ErrorBanner error={error} /> : null}
      {notifications && <NotificationsRow channel={notifications} onOpen={() => onOpen(notifications.id)} />}
      {channels &&
        sections.map((s) => {
          const list = channels.filter((c) => s.kinds.includes(c.kind));
          return (
            <div key={s.title} className="mb-3">
              <div className="flex items-center justify-between px-2 py-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{s.title}</h3>
                {s.action && (
                  <button
                    type="button"
                    onClick={s.action.onClick}
                    className="press rounded-full px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-600 dark:hover:bg-slate-800"
                  >
                    + {s.action.label}
                  </button>
                )}
              </div>
              {list.length === 0 && <p className="px-2 py-1 text-xs text-slate-500">{s.kinds.includes('direct') ? 'No conversations yet.' : 'None yet.'}</p>}
              <ul>
                {list.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(c.id)}
                      className="press flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${c.unread ? 'font-semibold' : 'font-medium'}`}>{channelTitle(c)}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {c.last_message ? preview(c, myId) : 'No messages yet'}
                        </span>
                      </span>
                      {c.last_message && <span className="shrink-0 pt-0.5 text-[11px] text-slate-500">{ago(c.last_message.created_at)}</span>}
                      {c.unread > 0 && (
                        <span
                          className="mt-0.5 shrink-0 rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold leading-5 text-on-brand"
                          aria-label={`${c.unread} unread`}
                        >
                          {c.unread > 99 ? '99+' : c.unread}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
    </div>
  );
}

// One conversation ------------------------------------------------------------------------------

function ChannelView({
  channel,
  myId,
  active,
  onBack,
  onFollowLink,
}: {
  channel: Channel;
  myId: string;
  active: boolean;
  onBack: () => void;
  onFollowLink: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = useQuery({
    queryKey: ['team', 'messages', channel.id],
    queryFn: () => api.get<Message[]>(`/team/channels/${channel.id}/messages?limit=100`),
    refetchInterval: active ? 3000 : false,
  });
  const newest = messages.data?.at(-1)?.id;

  // Reading the conversation marks it read (on open and as messages arrive).
  useEffect(() => {
    if (!active || !newest) return;
    void api.post(`/team/channels/${channel.id}/read`).then(() => queryClient.invalidateQueries({ queryKey: ['team', 'channels'] }));
  }, [active, newest, channel.id, api, queryClient]);
  // Braces: newer browsers return a promise from scrollIntoView, which must not become the effect's cleanup.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [newest]);

  const send = useMutation({
    mutationFn: (body: string) => api.post<Message>(`/team/channels/${channel.id}/messages`, { body }),
    onSuccess: () => {
      setText('');
      void queryClient.invalidateQueries({ queryKey: ['team'] });
    },
  });
  const leave = useMutation({
    mutationFn: () => api.post(`/team/channels/${channel.id}/leave`),
    onSuccess: () => {
      onBack();
      void queryClient.invalidateQueries({ queryKey: ['team'] });
    },
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (text.trim() && !send.isPending) send.mutate(text.trim());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const days = useMemo(() => groupByDay(messages.data ?? []), [messages.data]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 px-2 py-2 dark:border-slate-800">
        <Button variant="ghost" size="sm" aria-label="Back to conversations" onClick={onBack}>
          <svg
            viewBox="0 0 20 20"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{channelTitle(channel)}</p>
          {channel.kind === 'group' && channel.members && (
            <p className="truncate text-xs text-slate-500">{channel.members.map((m) => (m.id === myId ? 'You' : m.name)).join(', ')}</p>
          )}
          {channel.kind === 'everyone' && <p className="text-xs text-slate-500">All staff</p>}
          {channel.kind === 'notifications' && <p className="text-xs text-slate-500">Updates from JoyBot, just for you</p>}
        </div>
        {channel.kind === 'group' && (
          <Button variant="ghost" size="sm" disabled={leave.isPending} onClick={() => leave.mutate()}>
            Leave
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
        {messages.isLoading && <Spinner />}
        {messages.data?.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No messages yet. Say hello!</p>}
        {days.map(([day, list]) => (
          <div key={day}>
            <p className="my-2 text-center text-[11px] font-medium uppercase tracking-wide text-slate-500">{day}</p>
            <ul className="space-y-2">
              {list.map((m) => {
                const mine = m.sender_id === myId;
                return (
                  <li key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                    {!mine && m.sender_name && <span className="mb-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">{m.sender_name}</span>}
                    {m.link ? (
                      <Link
                        to={m.link}
                        onClick={onFollowLink}
                        className="press max-w-[85%] rounded-2xl rounded-bl-sm bg-brand-50 px-3 py-2 text-sm text-brand-900 hover:bg-brand-100 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                      >
                        {m.body} <span aria-hidden="true">→</span>
                      </Link>
                    ) : (
                      <p
                        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                          mine ? 'btn-gradient rounded-br-sm' : 'rounded-bl-sm bg-slate-100 dark:bg-slate-800'
                        }`}
                      >
                        {m.body}
                      </p>
                    )}
                    <span className="mt-0.5 text-[11px] text-slate-500">{clockOf(m.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {channel.kind !== 'notifications' && (
        <form onSubmit={submit} className="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
          <textarea
            rows={1}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={`Message ${channelTitle(channel)}`}
            placeholder={`Message ${channelTitle(channel)}`}
            className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
          />
          <Button type="submit" disabled={!text.trim() || send.isPending}>
            Send
          </Button>
        </form>
      )}
      {send.error && (
        <div className="px-3 pb-3">
          <ErrorBanner error={send.error} />
        </div>
      )}
    </div>
  );
}

// Starting conversations ------------------------------------------------------------------------

function usePeople() {
  const api = useApi();
  return useQuery({ queryKey: ['team', 'people'], queryFn: () => api.get<Person[]>('/team/people') });
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 px-2 py-2 dark:border-slate-800">
      <Button variant="ghost" size="sm" aria-label="Back to conversations" onClick={onBack}>
        <svg
          viewBox="0 0 20 20"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 4l-6 6 6 6" />
        </svg>
      </Button>
      <p className="text-sm font-semibold">{title}</p>
    </div>
  );
}

function NewDirect({ onBack, onOpened }: { onBack: () => void; onOpened: (id: string) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const people = usePeople();
  const [q, setQ] = useState('');
  const start = useMutation({
    mutationFn: (userId: string) => api.post<{ id: string }>('/team/direct', { user_id: userId }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['team', 'channels'] });
      onOpened(res.id);
    },
  });
  const list = (people.data ?? []).filter((p) => personName(p).toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SubHeader title="New message" onBack={onBack} />
      <div className="p-3">
        <Input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a colleague" aria-label="Find a colleague" />
      </div>
      <ul className="flex-1 overflow-y-auto px-2 pb-3">
        {people.isLoading && <Spinner />}
        {list.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              disabled={start.isPending}
              onClick={() => start.mutate(p.id)}
              className="press w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {personName(p)}
            </button>
          </li>
        ))}
        {people.data && !list.length && <p className="px-2 text-sm text-slate-500">Nobody matches.</p>}
      </ul>
      {start.error && <ErrorBanner error={start.error} />}
    </div>
  );
}

function NewGroup({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const people = usePeople();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/team/channels', { name: name.trim(), member_ids: [...picked] }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['team', 'channels'] });
      onCreated(res.id);
    },
  });
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <SubHeader title="New channel" onBack={onBack} />
      <div className="grid gap-1 p-3">
        <label htmlFor="team-channel-name" className="text-sm font-medium">
          Name
        </label>
        <Input id="team-channel-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. NYC front desk" />
      </div>
      <fieldset className="flex min-h-0 flex-1 flex-col px-3">
        <legend className="pb-1 text-sm font-medium">Members ({picked.size} chosen, plus you)</legend>
        <ul className="flex-1 overflow-y-auto">
          {people.isLoading && <Spinner />}
          {people.data?.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
                <input
                  type="checkbox"
                  checked={picked.has(p.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(p.id);
                    else next.delete(p.id);
                    setPicked(next);
                  }}
                />
                {personName(p)}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        {create.error && <ErrorBanner error={create.error} />}
        <Button type="submit" disabled={!name.trim() || picked.size === 0 || create.isPending}>
          Create channel
        </Button>
      </div>
    </form>
  );
}

// Toasts and sound -------------------------------------------------------------------------------

function Toasts({ toasts, onOpen, onDismiss }: { toasts: Toast[]; onOpen: (t: Toast) => void; onDismiss: (t: Toast) => void }) {
  // Each toast leaves after 6 seconds.
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => onDismiss(toasts[0]), 6000);
    return () => clearTimeout(t);
  }, [toasts, onDismiss]);
  return (
    <div className="pointer-events-none fixed bottom-24 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.key}
          className="pointer-events-auto flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <button type="button" onClick={() => onOpen(t)} className="press min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-semibold">{t.title}</span>
            <span className="line-clamp-2 block text-sm text-slate-600 dark:text-slate-300">{t.body}</span>
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => onDismiss(t)}
            className="press rounded-full p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/** A short two-note chime (no audio file). Browsers allow it once the page has had a click or key. */
function chime() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1320, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.34);
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // No audio available: stay quiet.
  }
}

// Formatting --------------------------------------------------------------------------------------

const clockOf = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

function ago(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

function groupByDay(list: Message[]): [string, Message[]][] {
  const out: [string, Message[]][] = [];
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const today = fmt.format(new Date());
  for (const m of list) {
    const day = fmt.format(new Date(m.created_at));
    const label = day === today ? 'Today' : day;
    if (out.at(-1)?.[0] === label) out.at(-1)![1].push(m);
    else out.push([label, [m]]);
  }
  return out;
}
