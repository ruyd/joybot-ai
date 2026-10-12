import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, Td } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, todayIn, zonedToIso } from '../../lib/format';
import { useMe } from '../../lib/me';
import { siteGet } from '../../lib/site';

interface SalesCall {
  id: string;
  name: string;
  email: string;
  starts_at: string;
  ends_at: string;
  time_zone: string | null;
  notes: string | null;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  created_at: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  appointment_number: string;
  outcome: 'follow_up' | 'conversion' | 'potential' | 'do_not_call' | null;
  outcome_notes: string | null;
  outcome_at: string | null;
}

interface HoursInterval {
  weekday: number;
  starts: string;
  ends: string;
}

interface Staff {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface SalesCallSettings {
  title: string;
  description: string | null;
  duration_minutes: number;
  meeting_url: string | null;
  updated_at: string;
  hours: HoursInterval[];
  host_ids: string[];
  /** Active staff, to pick hosts and assign calls. */
  staff: Staff[];
}
type SettingsForm = Omit<SalesCallSettings, 'updated_at' | 'staff'>;
const toForm = ({ updated_at: _u, staff: _s, ...rest }: SalesCallSettings): SettingsForm => rest;
const staffName = (s: Staff) => [s.first_name, s.last_name].filter(Boolean).join(' ') || 'Staff member';

function useSalesCallSettings() {
  const api = useApi();
  return useQuery({ queryKey: ['sales-call-settings'], queryFn: () => api.get<SalesCallSettings>('/website/sales-call-settings') });
}

const DURATIONS = [15, 20, 30, 45, 60, 90];
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const PAGE_SIZE = 25;
type SettableStatus = 'confirmed' | 'completed' | 'no_show';
/** Booked and still to happen (not completed, a no-show or cancelled). */
const isActive = (c: { status: string }) => c.status === 'scheduled' || c.status === 'confirmed';
const TABS = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Past' },
  { key: 'setup', label: 'Setup' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** Marketing › Sales calls: the booking page's setup, then the calls visitors booked on /book-a-call (searched, a page at a time). */
export function SalesCallsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const editable = can('update', 'website');
  const [params_, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.key === params_.get('tab')) ? (params_.get('tab') as Tab) : 'upcoming';
  const past = tab === 'past';
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ id: string; kind: 'reschedule' | 'outcome' } | null>(null);
  const isOpen = (id: string, kind: 'reschedule' | 'outcome') => panel?.id === id && panel.kind === kind;
  const toggle = (id: string, kind: 'reschedule' | 'outcome') => setPanel(isOpen(id, kind) ? null : { id, kind });

  // ?call=<id> (from the calendar or Home): open its tab, find the visitor and highlight the call.
  const focusId = params_.get('call');
  const [highlight, setHighlight] = useState<string | null>(null);
  const focus = useQuery({
    queryKey: ['sales-call', focusId],
    enabled: !!focusId,
    queryFn: () => api.get<SalesCall>(`/website/sales-calls/${focusId}`),
  });
  useEffect(() => {
    const c = focus.data;
    if (!c) return;
    const over = Date.parse(c.ends_at) <= Date.now() || c.status === 'completed' || c.status === 'no_show';
    setSearch(c.email);
    setQ(c.email);
    setHighlight(c.id);
    setParams(over ? { tab: 'past' } : {}, { replace: true });
  }, [focus.data, setParams]);

  // Search as they type, once they pause; a new search or tab starts from the first page.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setOffset(0), [q, past]);

  const params = new URLSearchParams({ when: past ? 'past' : 'upcoming', limit: String(PAGE_SIZE), offset: String(offset) });
  if (q) params.set('q', q);
  const calls = useQuery({
    queryKey: ['sales-calls', past, q, offset],
    enabled: tab !== 'setup',
    queryFn: () => api.get<{ items: SalesCall[]; total: number }>(`/website/sales-calls?${params}`),
    placeholderData: keepPreviousData,
  });
  const settings = useSalesCallSettings();
  const assign = useMutation({
    mutationFn: ({ id, user_id }: { id: string; user_id: string | null }) => api.put<SalesCall>(`/website/sales-calls/${id}/assign`, { user_id }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['sales-calls'] }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post<SalesCall>(`/website/sales-calls/${id}/cancel`),
    onSuccess: () => {
      setPanel(null);
      void queryClient.invalidateQueries({ queryKey: ['sales-calls'] });
      void queryClient.invalidateQueries({ queryKey: ['site', 'sales-call'] });
    },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SettableStatus }) => api.put<SalesCall>(`/website/sales-calls/${id}/status`, { status }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales-calls'] });
      void queryClient.invalidateQueries({ queryKey: ['site', 'sales-call'] });
    },
  });
  const items = calls.data?.items ?? [];
  const columns = past ? 6 : 5;
  useEffect(() => {
    if (highlight && items.some((c) => c.id === highlight)) document.getElementById(`call-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [highlight, items]);
  const rowTone = (c: SalesCall) => (highlight === c.id ? 'bg-brand-50 dark:bg-slate-800' : hovered === c.id ? 'bg-slate-50 dark:bg-slate-800/60' : '');
  const total = calls.data?.total ?? 0;

  return (
    <Page>
      <PageHeader
        title="Sales calls"
        description="Calls booked on the website's booking page; Setup sets its text, length, availability and hosts."
        actions={
          <a href="/book-a-call" target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-600">
            Open the booking page ↗
          </a>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Sales calls" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setParams(t.key === 'upcoming' ? {} : { tab: t.key }, { replace: true })}
              className={`press rounded-full px-3 py-1.5 text-sm ${tab === t.key ? 'btn-gradient font-medium' : 'hover:bg-slate-100 dark:hover:bg-slate-900'}`}
            >
              {t.label}
              {t.key === tab && tab !== 'setup' && calls.data && <span className="ml-1.5 opacity-80">{total.toLocaleString()}</span>}
            </button>
          ))}
        </div>
        {tab !== 'setup' && (
          <div className="relative ml-auto w-72 max-w-full">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <Input
              type="search"
              aria-label="Search calls"
              placeholder="Search name, email or notes"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        )}
      </div>
      {tab === 'setup' ? (
        <SetupCard editable={editable} />
      ) : (
        <Card>
          {focus.error && (
            <div className="mb-3">
              <ErrorBanner error={focus.error} />
            </div>
          )}
          {calls.isLoading ? (
            <Spinner />
          ) : calls.error ? (
            <ErrorBanner error={calls.error} />
          ) : !items.length ? (
            <EmptyState>{q ? `No calls match “${q}”.` : past ? 'No past calls.' : 'No upcoming calls.'}</EmptyState>
          ) : (
            <>
              <Table head={past ? ['When', 'Name', 'Email', 'Assigned to', 'Status', 'Outcome'] : ['When', 'Name', 'Email', 'Assigned to', 'Status']}>
                {items.map((c) => (
                  <Fragment key={c.id}>
                    <tr
                      id={`call-${c.id}`}
                      onMouseEnter={() => setHovered(c.id)}
                      onMouseLeave={() => setHovered(null)}
                      className={`scroll-mt-24 transition-colors ${rowTone(c)} ${c.status === 'cancelled' ? 'text-slate-400' : ''}`}
                    >
                      <Td className="whitespace-nowrap">
                        {dateTime(c.starts_at)}
                        {c.time_zone && c.time_zone !== browserZone && (
                          <span className="block text-xs text-slate-500">Their time: {dateTime(c.starts_at, c.time_zone)}</span>
                        )}
                      </Td>
                      <Td>{c.name}</Td>
                      <Td>
                        <a href={`mailto:${c.email}`} className="text-brand-700 hover:underline dark:text-brand-600">
                          {c.email}
                        </a>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {editable && !past && isActive(c) ? (
                          <div className="w-40">
                            <Select
                              aria-label={`Assigned to, call with ${c.name}`}
                              value={c.assigned_to ?? ''}
                              disabled={assign.isPending}
                              onChange={(e) => assign.mutate({ id: c.id, user_id: e.target.value || null })}
                              className="py-1"
                            >
                              <option value="">Unassigned</option>
                              {c.assigned_to && !settings.data?.staff.some((st) => st.id === c.assigned_to) && (
                                <option value={c.assigned_to}>{c.assigned_to_name ?? 'Inactive staff'}</option>
                              )}
                              {settings.data?.staff.map((st) => (
                                <option key={st.id} value={st.id}>
                                  {staffName(st)}
                                </option>
                              ))}
                            </Select>
                          </div>
                        ) : (
                          (c.assigned_to_name ?? <span className="text-slate-400">Unassigned</span>)
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {editable && c.status !== 'cancelled' ? (
                          <div className="w-36">
                            <Select
                              aria-label={`Status, call with ${c.name}`}
                              value={c.status === 'scheduled' ? 'confirmed' : c.status}
                              disabled={setStatus.isPending}
                              onChange={(e) => setStatus.mutate({ id: c.id, status: e.target.value as SettableStatus })}
                              className="py-1"
                            >
                              <option value="confirmed">Confirmed</option>
                              <option value="completed">Completed</option>
                              <option value="no_show" disabled={Date.parse(c.starts_at) > Date.now()}>
                                No show
                              </option>
                            </Select>
                          </div>
                        ) : (
                          <StatusBadge status={c.status} />
                        )}
                      </Td>
                      {past && (
                        <Td className="max-w-xs">
                          {c.outcome ? (
                            <>
                              <Badge tone={OUTCOME_TONE[c.outcome]}>{OUTCOME_LABEL[c.outcome]}</Badge>
                              {c.outcome_notes && <p className="mt-1 whitespace-pre-wrap text-slate-600 dark:text-slate-300">{c.outcome_notes}</p>}
                            </>
                          ) : (
                            <span className="text-slate-400">{c.status === 'cancelled' ? '—' : 'Not logged'}</span>
                          )}
                        </Td>
                      )}
                    </tr>
                    {/* Second line: the visitor's notes, and the actions. */}
                    <tr
                      onMouseEnter={() => setHovered(c.id)}
                      onMouseLeave={() => setHovered(null)}
                      className={`border-t-0! transition-colors ${rowTone(c)} ${c.status === 'cancelled' ? 'text-slate-400' : ''}`}
                    >
                      <td colSpan={columns} className="px-4 pt-1 pb-3.5">
                        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                          <p className="min-w-0 flex-1 text-sm whitespace-pre-wrap text-slate-600 dark:text-slate-300">
                            {c.notes ? (
                              <>
                                <span className="font-medium text-slate-500">Notes: </span>
                                {c.notes}
                              </>
                            ) : (
                              <span className="text-slate-400">No notes</span>
                            )}
                          </p>
                          {c.status !== 'cancelled' && editable && (
                            <span className="inline-flex shrink-0 gap-1">
                              {!past && isActive(c) && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-red-700! hover:bg-red-50! dark:text-red-400! dark:hover:bg-red-950!"
                                    disabled={cancel.isPending}
                                    onClick={() =>
                                      window.confirm(`Cancel the call with ${c.name}? The time opens up again. (They are not emailed.)`) && cancel.mutate(c.id)
                                    }
                                  >
                                    Cancel
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => toggle(c.id, 'reschedule')} aria-expanded={isOpen(c.id, 'reschedule')}>
                                    Reschedule
                                  </Button>
                                </>
                              )}
                              <Button size="sm" variant="ghost" onClick={() => toggle(c.id, 'outcome')} aria-expanded={isOpen(c.id, 'outcome')}>
                                Outcome
                              </Button>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {panel?.id === c.id && (
                      <tr>
                        <td colSpan={columns} className="bg-slate-50 px-4 py-3 dark:bg-slate-900/60">
                          {panel.kind === 'reschedule' ? (
                            <Reschedule call={c} onDone={() => setPanel(null)} />
                          ) : (
                            <OutcomeForm call={c} onDone={() => setPanel(null)} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </Table>
              <div className="mt-3 flex items-center justify-between gap-2 text-sm text-slate-500">
                <span aria-live="polite">
                  {offset + 1}–{offset + items.length} of {total.toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={offset === 0 || calls.isFetching} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={offset + PAGE_SIZE >= total || calls.isFetching}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
          {(assign.error || setStatus.error || cancel.error) && <ErrorBanner error={assign.error ?? setStatus.error ?? cancel.error} />}
        </Card>
      )}
    </Page>
  );
}

/** Pick a new day and open time for a call (in this browser's time zone); optionally email the visitor. */
function Reschedule({ call, onDone }: { call: SalesCall; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [day, setDay] = useState(() =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: browserZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(call.starts_at)),
  );
  const [start, setStart] = useState('');
  const [notify, setNotify] = useState(true);
  const open = useQuery({
    queryKey: ['site', 'sales-call', 'day', day],
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(day),
    queryFn: () => {
      const from = zonedToIso(day, '00:00', browserZone);
      const to = new Date(Date.parse(from) + 86_400_000).toISOString();
      return siteGet<{ slots: string[] }>(`/sales-call?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    },
  });
  useEffect(() => setStart(''), [day]);
  const move = useMutation({
    mutationFn: () =>
      api.post<SalesCall>(`/website/sales-calls/${call.id}/reschedule`, {
        start,
        notify,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales-calls'] });
      void queryClient.invalidateQueries({ queryKey: ['site', 'sales-call'] });
      onDone();
    },
  });
  const time = (iso: string) =>
    new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: browserZone,
    }).format(new Date(iso));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        move.mutate();
      }}
      className="grid gap-3"
    >
      <p className="text-sm font-medium">Move the call with {call.name} to:</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Day">
          <Input type="date" required min={todayIn(browserZone)} value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Your time">
          <Select
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
            disabled={open.isLoading}
            className="min-w-36"
            title={`In your time zone (${browserZone.replaceAll('_', ' ')})`}
          >
            <option value="">{open.isLoading ? 'Loading…' : open.data?.slots.length ? 'Choose a time' : 'No open times'}</option>
            {open.data?.slots.map((s) => (
              <option key={s} value={s}>
                {time(s)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        Email {call.email} the new time
      </label>
      {(move.error || open.error) && <ErrorBanner error={move.error ?? open.error} />}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!start || move.isPending}>
          Move call
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </form>
  );
}

const OUTCOMES = ['follow_up', 'conversion', 'potential', 'do_not_call'] as const;
type Outcome = (typeof OUTCOMES)[number];
const OUTCOME_LABEL: Record<Outcome, string> = { follow_up: 'Follow up', conversion: 'Conversion', potential: 'Potential', do_not_call: 'Do not call' };
const OUTCOME_TONE: Record<Outcome, 'amber' | 'green' | 'brand' | 'red'> = { follow_up: 'amber', conversion: 'green', potential: 'brand', do_not_call: 'red' };

/** Logs how a call went, with notes (again to change it). */
function OutcomeForm({ call, onDone }: { call: SalesCall; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome | ''>(call.outcome ?? '');
  const [notes, setNotes] = useState(call.outcome_notes ?? '');
  const save = useMutation({
    mutationFn: () => api.post<SalesCall>(`/website/sales-calls/${call.id}/outcome`, { outcome, notes: notes.trim() || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales-calls'] });
      onDone();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="grid max-w-2xl gap-3"
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium">How did the call with {call.name} go?</legend>
        <div className="flex flex-wrap gap-2">
          {OUTCOMES.map((o) => (
            <label
              key={o}
              className={`press flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                outcome === o
                  ? 'border-brand-600 bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100'
                  : 'border-slate-300 dark:border-slate-700'
              }`}
            >
              <input type="radio" name={`outcome-${call.id}`} value={o} checked={outcome === o} onChange={() => setOutcome(o)} className="sr-only" />
              {OUTCOME_LABEL[o]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Notes">
        <textarea
          rows={3}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was discussed, next steps…"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      {save.error && <ErrorBanner error={save.error} />}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!outcome || save.isPending}>
          Save outcome
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </form>
  );
}

/** The booking page's title, text, call length, meeting link (sent in emails), general hours and hosts. */
function SetupCard({ editable }: { editable: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const settings = useSalesCallSettings();
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data && !form) setForm(toForm(settings.data));
  }, [settings.data, form]);
  const save = useMutation({
    mutationFn: () => {
      const { title, description, duration_minutes, meeting_url, hours, host_ids } = form!;
      return api.put<SalesCallSettings>('/website/sales-call-settings', {
        title,
        description: description ?? '',
        duration_minutes,
        meeting_url: meeting_url ?? '',
        hours,
        host_ids,
      });
    },
    onSuccess: (s) => {
      queryClient.setQueryData(['sales-call-settings'], s);
      setForm(toForm(s));
      void queryClient.invalidateQueries({ queryKey: ['site', 'sales-call'] });
      setSaved(true);
    },
  });
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [k]: v } : f));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Card title="Booking page setup">
      {!form || !settings.data ? (
        settings.error ? (
          <ErrorBanner error={settings.error} />
        ) : (
          <Spinner />
        )
      ) : (
        <form onSubmit={submit} className="grid gap-6">
          <fieldset disabled={!editable} className="grid gap-6 lg:grid-cols-2">
            <div className="grid content-start gap-4">
              <Field label="Title">
                <Input required maxLength={80} value={form.title} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <Field label="Text" hint="Shown under the title on the booking page.">
                <textarea
                  rows={4}
                  maxLength={1000}
                  value={form.description ?? ''}
                  onChange={(e) => set('description', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Duration">
                  <Select value={form.duration_minutes} onChange={(e) => set('duration_minutes', Number(e.target.value))}>
                    {DURATIONS.map((d) => (
                      <option key={d} value={d}>
                        {d} minutes
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Meeting link" hint="Sent in the confirmation email, never shown on the page.">
                  <Input
                    type="url"
                    placeholder="https://"
                    maxLength={500}
                    value={form.meeting_url ?? ''}
                    onChange={(e) => set('meeting_url', e.target.value)}
                  />
                </Field>
              </div>
              <div>
                <p className="text-sm font-medium">Hosts</p>
                <p className="mb-2 text-xs text-slate-500">
                  Who takes the calls. A time is open while one of them is free (no appointment, other call or time off, and within their working hours when
                  set); each call goes to the free host with the fewest upcoming calls. With no hosts, calls are unassigned and one at a time.
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {settings.data.staff.map((st) => (
                    <label key={st.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.host_ids.includes(st.id)}
                        onChange={(e) => set('host_ids', e.target.checked ? [...form.host_ids, st.id] : form.host_ids.filter((h) => h !== st.id))}
                      />
                      {staffName(st)}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <HoursEditor hours={form.hours} onChange={(h) => set('hours', h)} />
          </fieldset>
          {save.error && <ErrorBanner error={save.error} />}
          {editable && (
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={save.isPending}>
                Save
              </Button>
              {saved && (
                <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
                  Saved
                </span>
              )}
              <span className="text-xs text-slate-500">A new duration applies to calls booked from now on.</span>
            </div>
          )}
        </form>
      )}
    </Card>
  );
}

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const quarterHours = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
const clockLabel = (t: string) => {
  if (t === '24:00') return 'midnight';
  const [h, m] = t.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
};

/** General availability: one or more intervals per weekday, in the business time zone. */
function HoursEditor({ hours, onChange }: { hours: HoursInterval[]; onChange: (h: HoursInterval[]) => void }) {
  const update = (i: number, patch: Partial<HoursInterval>) => onChange(hours.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  return (
    <div>
      <p className="text-sm font-medium">Availability</p>
      <p className="mb-3 text-xs text-slate-500">When calls can be booked, in the business time zone. Days without hours are closed.</p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {DAY_ORDER.map((day) => {
          const rows = hours.map((h, i) => ({ h, i })).filter((r) => r.h.weekday === day);
          return (
            <li key={day} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
              <label className="flex w-28 items-center gap-2 pt-1.5 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={rows.length > 0}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...hours, { weekday: day, starts: '09:00', ends: '17:00' }] : hours.filter((h) => h.weekday !== day))
                  }
                />
                {DAY_NAMES[day]}
              </label>
              <div className="grid flex-1 gap-2">
                {!rows.length && <span className="pt-1.5 text-sm text-slate-400">Closed</span>}
                {rows.map(({ h, i }, n) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <div className="w-28">
                      <Select aria-label={`${DAY_NAMES[day]} from`} value={h.starts} onChange={(e) => update(i, { starts: e.target.value })}>
                        {quarterHours.map((t) => (
                          <option key={t} value={t}>
                            {clockLabel(t)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <span className="text-sm text-slate-500">to</span>
                    <div className="w-28">
                      <Select aria-label={`${DAY_NAMES[day]} until`} value={h.ends} onChange={(e) => update(i, { ends: e.target.value })}>
                        {[...quarterHours.slice(1), '24:00'].map((t) => (
                          <option key={t} value={t}>
                            {clockLabel(t)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {n === rows.length - 1 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Add hours on ${DAY_NAMES[day]}`}
                        onClick={() => onChange([...hours, { weekday: day, starts: h.ends === '24:00' ? h.starts : h.ends, ends: '24:00' }])}
                      >
                        +
                      </Button>
                    ) : null}
                    {rows.length > 1 && (
                      <Button type="button" size="sm" variant="ghost" aria-label="Remove these hours" onClick={() => onChange(hours.filter((_, j) => j !== i))}>
                        ×
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
