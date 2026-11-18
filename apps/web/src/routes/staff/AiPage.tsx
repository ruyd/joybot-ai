import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Search, ShieldAlert, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button, ErrorBanner, Field, Input, Select, Spinner, Tabs } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';

type Kind = 'openrouter' | 'openai_compatible' | 'ollama';
type Capability =
  | 'general'
  | 'embeddings'
  | 'reranker'
  | 'speech_to_text'
  | 'text_to_speech'
  | 'realtime_voice'
  | 'vision'
  | 'image_generation'
  | 'video_generation'
  | 'avatar'
  | 'moderation'
  | 'document_parsing';
type Transport = 'direct' | 'postgres' | 'bullmq' | 'redis_streams' | 'sqs' | 'durable_objects';

interface Connection {
  id: string;
  name: string;
  kind: Kind;
  base_url: string | null;
  private: boolean;
  active: boolean;
  monthly_cap_usd: string | null;
  spent_usd: string;
  calls: number;
  api_key_last4: string | null;
}

interface Model {
  id: string;
  connection_id: string;
  model: string;
  capability: Capability;
  label: string | null;
  tags: string[];
  description: string | null;
  context_tokens: number | null;
  input_price: string | null;
  output_price: string | null;
  options: { voice?: string };
}

interface Slot {
  capability: Capability;
  model_id: string | null;
  backup_model_id: string | null;
  transport: Transport;
  active: boolean;
}

interface Overview {
  connections: Connection[];
  models: Model[];
  slots: Slot[];
  usage: { capability: Capability; calls: number; spent_usd: string }[];
  server_default: string | null;
  encryption_available: boolean;
  available_transports: Transport[];
  /** The Postgres queue: waiting and running now, failed in the last day. */
  queue: { capability: Capability; queued: number; running: number; failed: number }[];
  queue_capabilities: Capability[];
}

type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string;
  capability: Capability;
  transport: Transport;
  status: JobStatus;
  audience: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
  model: string | null;
  connection_name: string | null;
  cost_usd: string;
  ms: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  input?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
}

interface Call {
  id: string;
  created_at: string;
  capability: Capability;
  model: string;
  audience: string | null;
  step: string | null;
  input_units: number | null;
  output_units: number | null;
  cost_usd: string;
  ms: number | null;
  ok: boolean;
  error: string | null;
  connection_name: string | null;
}

interface AssistantSettings {
  assistant_customers: boolean;
  assistant_employees: boolean;
}

const CAPABILITY: Record<Capability, { label: string; hint: string }> = {
  general: { label: 'General (MoE)', hint: 'Plans lookups and writes every answer' },
  embeddings: { label: 'Embeddings', hint: 'Finds knowledge by meaning' },
  reranker: { label: 'Reranker', hint: 'Orders the best matches first' },
  speech_to_text: { label: 'Speech to text', hint: 'Voice notes and calls to text' },
  text_to_speech: { label: 'Text to speech', hint: 'Speaks replies aloud' },
  realtime_voice: { label: 'Realtime voice', hint: 'Live voice conversations' },
  vision: { label: 'Vision', hint: 'Images, receipts, screenshots' },
  image_generation: { label: 'Image generation', hint: 'Website and marketing images' },
  video_generation: { label: 'Video generation', hint: 'Short marketing clips' },
  avatar: { label: 'Avatar', hint: 'A talking-head agent' },
  moderation: { label: 'Moderation', hint: 'Screens what goes in and out' },
  document_parsing: { label: 'Document parsing', hint: 'PDFs and scans to text' },
};
const CAPABILITIES = Object.keys(CAPABILITY) as Capability[];
const KIND_LABEL: Record<Kind, string> = { openrouter: 'OpenRouter', openai_compatible: 'OpenAI-compatible', ollama: 'Ollama' };
const TRANSPORT_LABEL: Record<Transport, string> = {
  direct: 'Direct',
  postgres: 'Postgres queue',
  bullmq: 'BullMQ (Redis)',
  redis_streams: 'Redis Streams',
  sqs: 'Amazon SQS',
  durable_objects: 'Durable Objects',
};
/** One line on what each delivery is good for, shown when choosing it. */
const TRANSPORT_HINT: Record<Transport, string> = {
  direct: 'Called while the person waits',
  postgres: 'Background jobs, nothing extra to run',
  bullmq: 'Retries, priorities and higher volume',
  redis_streams: 'Fast flows and several readers',
  sqs: 'Managed queue on AWS',
  durable_objects: 'Queue on the Cloudflare deploy',
};
/** The delivery we'd pick for each capability, and why. */
const RECOMMENDED: Record<Capability, { transport: Transport; why: string }> = {
  general: { transport: 'direct', why: 'Answers stream to the person asking.' },
  text_to_speech: { transport: 'direct', why: 'Replies are spoken as they arrive.' },
  realtime_voice: { transport: 'direct', why: 'A live conversation can’t wait in a queue.' },
  embeddings: { transport: 'direct', why: 'Search embeds the question while someone waits.' },
  reranker: { transport: 'direct', why: 'It orders search results before the answer.' },
  moderation: { transport: 'direct', why: 'It checks a message before it’s answered.' },
  vision: { transport: 'direct', why: 'Images in chat are read while the person waits.' },
  speech_to_text: { transport: 'postgres', why: 'Recordings can wait; failed calls retry.' },
  document_parsing: { transport: 'postgres', why: 'PDFs take a while; failed calls retry.' },
  image_generation: { transport: 'bullmq', why: 'Slow, paid and rate limited: BullMQ retries with backoff.' },
  video_generation: { transport: 'bullmq', why: 'Minutes per job: BullMQ retries with backoff.' },
  avatar: { transport: 'bullmq', why: 'Minutes per job: BullMQ retries with backoff.' },
};
/** Answers stream while the person waits, so these are always called directly. */
const DIRECT_ONLY: Capability[] = ['general', 'text_to_speech', 'realtime_voice'];
const QUEUED: Transport[] = ['postgres', 'bullmq', 'redis_streams'];
const TESTABLE: Capability[] = ['general', 'text_to_speech'];
/** A small job to try a queued capability with (the ones that need a file or link are tried from the API). */
const SAMPLE_JOB: Partial<Record<Capability, Record<string, unknown>>> = {
  embeddings: { texts: ['What are your opening hours?'] },
  reranker: { query: 'opening hours', documents: ['We are open 9 to 5 on weekdays.', 'Parking is behind the building.'] },
  moderation: { text: 'Can I move my appointment to Friday?' },
  image_generation: { prompt: 'A friendly robot waving, flat illustration, green accent' },
};

/** One-click models for the add form. */
const PRESETS: { label: string; model: string; capability: Capability; tags: string[]; input_price: number; output_price: number; voice?: string; description: string; context_tokens?: number; kinds: Kind[] }[] = [
  { label: 'Gemma 4 26B A4B', model: 'google/gemma-4-26b-a4b-it', capability: 'general', tags: ['MoE'], input_price: 0.1, output_price: 0.3, description: 'Mixture of experts; stronger planning and longer answers.', context_tokens: 256_000, kinds: ['openrouter'] },
  { label: 'HeyGen Voice Turbo (free)', model: 'heygen/heygen-voice-1-turbo:free', capability: 'text_to_speech', tags: [], input_price: 0, output_price: 0, voice: 'nadine', description: 'Natural voices with low delay. Free until Nov 30, 2026.', kinds: ['openrouter'] },
  { label: 'Gemma 4 E2B', model: 'gemma4:e2b', capability: 'general', tags: [], input_price: 0, output_price: 0, description: 'Small, fast model on your own server.', context_tokens: 128_000, kinds: ['ollama', 'openai_compatible'] },
];

const BADGE_COLORS = [
  'bg-[#E7F4EF] text-[#0B6E55]',
  'bg-[#EEF0FB] text-[#3B3F9E]',
  'bg-[#FEF3C7] text-[#8A4B05]',
  'bg-[#FCE7F3] text-[#9D174D]',
  'bg-[#E0F2FE] text-[#075985]',
];
const box = 'overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
const caps = 'text-[11px] font-semibold tracking-wider text-slate-500 uppercase';
const smallButton =
  'press inline-flex h-[30px] items-center rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium whitespace-nowrap hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800';
const th = 'border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-left text-[11px] font-semibold tracking-wider whitespace-nowrap text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-900/60';
const td = 'border-b border-slate-100 px-3 py-2.5 align-middle dark:border-slate-800';

const money = (v: number) => `$${v.toFixed(2)}`;
const initials = (name: string) => {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s\-_.]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
};
const isFree = (m: Model) => Number(m.input_price ?? 0) === 0 && Number(m.output_price ?? 0) === 0;
const priceLabel = (m: Model) => {
  if (m.input_price === null && m.output_price === null) return 'No price set';
  if (isFree(m)) return m.options.voice ? `Free · voice ${m.options.voice}` : 'Free';
  if (m.capability === 'text_to_speech') return `$${Number(m.input_price ?? 0)} /M chars`;
  return `$${Number(m.input_price ?? 0).toFixed(2)} in · $${Number(m.output_price ?? 0).toFixed(2)} out /M`;
};
const modelName = (m: Model) => m.label || m.model;
const contextLabel = (n: number | null) => (n === null ? null : `${n >= 1000 ? `${Math.round(n / 1000)}K` : n} context`);

function PrivacyPill({ isPrivate }: { isPrivate: boolean }) {
  return isPrivate ? (
    <span className="inline-flex items-center rounded-full bg-[#E7F4EF] px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-[#0B6E55] dark:bg-emerald-950 dark:text-emerald-300">Private</span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-[#FEF3C7] px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-[#8A4B05] dark:bg-amber-950 dark:text-amber-300">Not private</span>
  );
}

/** Settings › AI: the assistant, one model per capability (all running at once), connections, caps and usage. */
export function AiPage() {
  const api = useApi();
  const q = useQuery({ queryKey: ['ai'], queryFn: () => api.get<Overview>('/admin/ai') });
  const [picker, setPicker] = useState<Capability | null>(null);
  const [connectionDialog, setConnectionDialog] = useState<Connection | 'new' | null>(null);
  const [addModel, setAddModel] = useState<{ capability?: Capability; connectionId?: string } | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [jobs, setJobs] = useState<{ capability?: Capability } | null>(null);
  const [toast, setToast] = useState<{ msg: string; detail?: string; undo?: () => void; tone?: 'ok' | 'error' } | null>(null);
  const [test, setTest] = useState<{ model: Model } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 10_000 : 6_000);
    return () => clearTimeout(t);
  }, [toast]);

  const data = q.data;
  const waiting = (data?.queue ?? []).reduce((n, x) => n + x.queued + x.running, 0);
  // Wider than other pages (the design's 1280 px), so both tables fit without scrolling on a laptop.
  return (
    <main className="mx-auto max-w-[1344px] px-4 py-7 sm:px-8 lg:py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-xs text-slate-500">Settings</p>
          <h1 className="text-[1.65rem] leading-tight font-bold tracking-tight">AI</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setJobs({})}>
            Jobs{waiting > 0 && <span className="ml-1.5 rounded-full bg-brand-100 px-1.5 text-xs text-brand-800 tabular-nums">{waiting}</span>}
          </Button>
          <Button variant="secondary" onClick={() => setUsageOpen(true)}>
            Usage log
          </Button>
          <Button onClick={() => setConnectionDialog('new')}>Add connection</Button>
        </div>
      </header>
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !data ? (
        <ErrorBanner error={q.error} />
      ) : (
        <div className="grid gap-5">
          <SummaryStrip data={data} onPickGeneral={() => setPicker('general')} />
          <Capabilities data={data} onOpen={setPicker} onToast={setToast} onTest={(model) => setTest({ model })} onJobs={(capability) => setJobs({ capability })} />
          <Connections data={data} onEdit={setConnectionDialog} onToast={setToast} />
        </div>
      )}

      {data && picker && (
        <ModelPicker
          data={data}
          capability={picker}
          onClose={() => setPicker(null)}
          onAddModel={() => {
            setAddModel({ capability: picker });
            setPicker(null);
          }}
        />
      )}
      {data && connectionDialog && (
        <ConnectionDialog
          data={data}
          connection={connectionDialog === 'new' ? undefined : connectionDialog}
          onClose={() => setConnectionDialog(null)}
          onAddModel={(connectionId) => setAddModel({ connectionId })}
        />
      )}
      {data && addModel && <AddModelDialog data={data} preset={addModel} onClose={() => setAddModel(null)} />}
      {usageOpen && <UsageDialog onClose={() => setUsageOpen(false)} />}
      {jobs && <JobsDialog capability={jobs.capability} onClose={() => setJobs(null)} onToast={setToast} />}
      {test && <TestDialog model={test.model} onClose={() => setTest(null)} />}

      {toast && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3.5 rounded-xl bg-[#0F1720] py-3 pr-3.5 pl-4 text-sm text-white shadow-[0_12px_32px_rgba(15,23,32,.3)]"
        >
          <span className={`size-2 shrink-0 rounded-full ${toast.tone === 'error' ? 'bg-red-400' : 'bg-emerald-400'}`} aria-hidden="true" />
          <span>
            <strong>{toast.msg}</strong> {toast.detail && <span className="text-[#A9B4C0]">{toast.detail}</span>}
          </span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
              className="h-[30px] rounded-md bg-[#1E2A36] px-3 text-xs font-semibold hover:bg-[#2A3846]"
            >
              Undo
            </button>
          )}
          <button type="button" aria-label="Dismiss" onClick={() => setToast(null)} className="grid size-7 place-items-center text-[#A9B4C0] hover:text-white">
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </main>
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['ai'] });
    void queryClient.invalidateQueries({ queryKey: ['ai-calls'] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };
}

/** Connection badges: initials in a color that stays the same for that connection. */
function useBadges(connections: Connection[]) {
  const order = [...connections].sort((a, b) => a.id.localeCompare(b.id));
  return (id: string) => {
    const i = order.findIndex((c) => c.id === id);
    const c = order[i];
    return { text: c ? initials(c.name) : '?', className: BADGE_COLORS[(i < 0 ? 0 : i) % BADGE_COLORS.length] };
  };
}

function Badge2({ text, className, size = 'md' }: { text: string; className: string; size?: 'sm' | 'md' | 'lg' }) {
  const dims = size === 'lg' ? 'size-8 rounded-lg text-[11px]' : size === 'sm' ? 'size-5 rounded text-[9px]' : 'size-6 rounded-md text-[10px]';
  return (
    <span className={`grid shrink-0 place-items-center font-bold tracking-wide ${dims} ${className}`} aria-hidden="true">
      {text}
    </span>
  );
}

// Summary strip -------------------------------------------------------------------------------

function SummaryStrip({ data, onPickGeneral }: { data: Overview; onPickGeneral: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<AssistantSettings>('/settings') });
  const saveAssistant = useMutation({
    mutationFn: (patch: Partial<AssistantSettings>) => api.put<AssistantSettings>('/admin/settings', patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const general = data.slots.find((s) => s.capability === 'general')!;
  const generalModels = data.models.filter((m) => m.capability === 'general');
  const mode: 'model' | 'auto' | 'search' = !general.active ? 'search' : general.model_id ? 'model' : 'auto';
  const saveGeneral = useMutation({ mutationFn: (patch: Partial<Slot>) => api.put('/admin/ai/slots/general', patch), onSuccess: refresh });
  const pick = (m: typeof mode) => {
    if (m === 'search') return saveGeneral.mutate({ active: false });
    if (m === 'auto') return saveGeneral.mutate({ active: true, model_id: null, backup_model_id: null });
    if (general.model_id) return saveGeneral.mutate({ active: true });
    if (generalModels.length) return saveGeneral.mutate({ active: true, model_id: generalModels[0].id });
    onPickGeneral();
  };
  const current = data.models.find((m) => m.id === general.model_id);
  const MODES = {
    model: ['Model', current ? `${modelName(current)} writes every answer, then its backup. If both fail, chat lists what it found.` : 'A General model from your connections writes every answer, then its backup.'],
    auto: ['Auto', data.server_default ? `The server's model (${data.server_default}) writes answers, falling back to search results.` : 'No model on this server, so chat answers with search results.'],
    search: ['Search only', 'Answers with matching saved answers, passages and records. Nothing is sent to an AI provider.'],
  } as const;

  const spent = data.connections.reduce((sum, c) => sum + Number(c.spent_usd), 0);
  const capped = data.connections.filter((c) => c.monthly_cap_usd !== null);
  const capTotal = capped.reduce((sum, c) => sum + Number(c.monthly_cap_usd), 0);
  const calls = data.connections.reduce((sum, c) => sum + c.calls, 0);
  const month = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date());

  const toggle = (key: keyof AssistantSettings, label: string, hint: string) => (
    <label className="flex items-center justify-between gap-3 text-[13px]">
      <span>
        {label} <span className="text-slate-500">· {hint}</span>
      </span>
      <input type="checkbox" className="switch" checked={settings.data?.[key] ?? true} disabled={!settings.data || saveAssistant.isPending} onChange={(e) => saveAssistant.mutate({ [key]: e.target.checked })} />
    </label>
  );

  return (
    <section aria-label="Assistant" className={`${box} grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))]`}>
      <div className="flex flex-col gap-2.5 border-slate-100 px-5 py-4 sm:border-r dark:border-slate-800">
        <h2 className={caps}>Assistant</h2>
        {toggle('assistant_customers', 'Customers', 'portal, website')}
        {toggle('assistant_employees', 'Employees', 'staff app')}
        {saveAssistant.error && <ErrorBanner error={saveAssistant.error} />}
      </div>
      <div className="flex flex-col gap-2.5 border-slate-100 px-5 py-4 sm:col-span-2 sm:border-r dark:border-slate-800">
        <h2 className={caps}>How chat answers</h2>
        <div role="radiogroup" aria-label="How chat answers" className="flex gap-[3px] rounded-lg bg-slate-100 p-[3px] dark:bg-slate-800">
          {(Object.keys(MODES) as (keyof typeof MODES)[]).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              disabled={saveGeneral.isPending}
              onClick={() => pick(id)}
              className={`h-8 flex-1 rounded-md text-[13px] transition-colors ${
                mode === id ? 'bg-white font-semibold text-slate-900 shadow-[0_1px_2px_rgba(15,23,32,.12)] dark:bg-slate-950 dark:text-white' : 'font-medium text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {MODES[id][0]}
            </button>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-slate-500">{MODES[mode][1]}</p>
        {saveGeneral.error && <ErrorBanner error={saveGeneral.error} />}
      </div>
      <div className="flex flex-col gap-2 px-5 py-4">
        <h2 className={caps}>Spend · {month}</h2>
        <p className="flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tabular-nums">{money(spent)}</span>
          <span className="text-[13px] text-slate-500">{capped.length ? `of ${money(capTotal)} caps` : 'no caps set'}</span>
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={`h-full ${capTotal && spent / capTotal > 0.8 ? 'bg-amber-600' : 'bg-brand-600'}`} style={{ width: `${capTotal ? Math.min(100, (spent / capTotal) * 100) : 0}%` }} />
        </div>
        <p className="text-xs text-slate-500">
          {calls.toLocaleString()} calls · {data.connections.length} connection{data.connections.length === 1 ? '' : 's'}
        </p>
      </div>
    </section>
  );
}

// Capabilities --------------------------------------------------------------------------------

/** Move a capability to another connection: the same model there when it has it, else its cheapest. */
function swapTarget(data: Overview, slot: Slot, connectionId: string): Model | null {
  const current = data.models.find((m) => m.id === slot.model_id);
  const there = data.models.filter((m) => m.capability === slot.capability && m.connection_id === connectionId);
  if (!there.length || current?.connection_id === connectionId) return null;
  return (
    (current && (there.find((m) => m.model === current.model) ?? there.find((m) => modelName(m) === modelName(current)))) ??
    [...there].sort((a, b) => Number(a.input_price ?? 0) - Number(b.input_price ?? 0))[0]
  );
}

type Toast = { msg: string; detail?: string; undo?: () => void; tone?: 'ok' | 'error' };

/** Swaps capabilities to a connection live, and offers to undo it. */
function useSwap(data: Overview, onToast: (t: Toast) => void) {
  const api = useApi();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async ({ capabilities, connectionId }: { capabilities: Capability[]; connectionId: string }) => {
      const before: Slot[] = [];
      for (const cap of capabilities) {
        const slot = data.slots.find((s) => s.capability === cap)!;
        const target = swapTarget(data, slot, connectionId);
        if (!target) continue;
        before.push(slot);
        await api.put(`/admin/ai/slots/${cap}`, { model_id: target.id, backup_model_id: slot.backup_model_id === target.id ? slot.model_id : slot.backup_model_id });
      }
      return { before, connectionId };
    },
    onSuccess: ({ before, connectionId }) => {
      refresh();
      if (!before.length) return;
      const name = data.connections.find((c) => c.id === connectionId)?.name ?? 'the connection';
      onToast({
        msg: `${before.length === 1 ? CAPABILITY[before[0].capability].label : `${before.length} capabilities`} moved to ${name}.`,
        detail: 'Live now, no restart. Calls already running finish on the old connection.',
        undo: () =>
          void Promise.all(before.map((s) => api.put(`/admin/ai/slots/${s.capability}`, { model_id: s.model_id, backup_model_id: s.backup_model_id }))).then(refresh),
      });
    },
    onError: (err) => onToast({ msg: 'Could not move it.', detail: (err as Error).message, tone: 'error' }),
  });
}

function Capabilities({
  data,
  onOpen,
  onToast,
  onTest,
  onJobs,
}: {
  data: Overview;
  onOpen: (c: Capability) => void;
  onToast: (t: Toast) => void;
  onTest: (m: Model) => void;
  onJobs: (c: Capability) => void;
}) {
  const api = useApi();
  const refresh = useRefresh();
  const badge = useBadges(data.connections);
  const swap = useSwap(data, onToast);
  const [filter, setFilter] = useState<'all' | 'active' | 'unset'>('all');
  const [menu, setMenu] = useState<Capability | null>(null);
  // The menu is fixed to the window (the table's scroll box would cut it off), next to its button.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const saveSlot = useMutation({
    mutationFn: ({ capability, patch }: { capability: Capability; patch: Partial<Slot> }) => api.put(`/admin/ai/slots/${capability}`, patch),
    onSuccess: refresh,
    onError: (err) => onToast({ msg: 'Not saved.', detail: (err as Error).message, tone: 'error' }),
  });
  const queueTest = useMutation({
    mutationFn: (capability: Capability) => api.post('/admin/ai/jobs', { capability, input: SAMPLE_JOB[capability] }),
    onSuccess: (_, capability) => {
      refresh();
      onToast({ msg: 'Test job queued.', detail: 'The worker picks it up in a moment.' });
      onJobs(capability);
    },
    onError: (err) => onToast({ msg: 'Not queued.', detail: (err as Error).message, tone: 'error' }),
  });
  const rows = data.slots.map((slot) => {
    const main = data.models.find((m) => m.id === slot.model_id) ?? null;
    const backup = data.models.find((m) => m.id === slot.backup_model_id) ?? null;
    const conn = main ? data.connections.find((c) => c.id === main.connection_id) : undefined;
    const usage = data.usage.find((u) => u.capability === slot.capability);
    return { slot, main, backup, conn, usage, unset: !main, on: Boolean(main) && slot.active };
  });
  const counts = { all: rows.length, active: rows.filter((r) => r.on).length, unset: rows.filter((r) => r.unset).length };
  const shown = rows.filter((r) => filter === 'all' || (filter === 'active' ? r.on : r.unset));

  return (
    <section aria-labelledby="cap-h" className={box}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
        <div>
          <h2 id="cap-h" className="text-[15px] font-semibold">
            Capabilities
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">One model per capability, all running at once. Click a model to change it.</p>
        </div>
        <div role="tablist" aria-label="Filter capabilities" className="flex gap-[18px] text-[13px]">
          {(
            [
              ['all', 'All'],
              ['active', 'Active'],
              ['unset', 'Not set'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              className={`py-1.5 ${filter === id ? 'font-semibold text-slate-900 shadow-[inset_0_-2px_0_var(--color-brand-600)] dark:text-white' : 'font-medium text-slate-500'}`}
            >
              {label} <span className="font-medium text-slate-400">{counts[id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={`${th} w-[52px]`}>On</th>
              <th className={`${th} min-w-[190px]`}>Capability</th>
              <th className={`${th} w-[220px]`}>Model</th>
              <th className={`${th} w-[170px]`}>Backup</th>
              <th className={th}>
                Connection <span className="font-medium tracking-normal text-brand-700 normal-case dark:text-brand-500">· live swap</span>
              </th>
              <th className={th}>Privacy</th>
              <th className={th}>Delivery</th>
              <th className={`${th} text-right`}>Calls</th>
              <th className={`${th} text-right`}>Spend</th>
              <th className={`${th} w-10`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ slot, main, backup, conn, usage, unset, on }) => {
              const info = CAPABILITY[slot.capability];
              const isGeneralAuto = slot.capability === 'general' && unset;
              return (
                <tr key={slot.capability} className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${on || isGeneralAuto ? '' : 'opacity-55'}`}>
                  <td className={td}>
                    <input
                      type="checkbox"
                      className="switch"
                      aria-label={`${info.label} on`}
                      checked={on || (isGeneralAuto && slot.active)}
                      disabled={(unset && !isGeneralAuto) || saveSlot.isPending}
                      onChange={(e) => saveSlot.mutate({ capability: slot.capability, patch: { active: e.target.checked } })}
                    />
                  </td>
                  <td className={td}>
                    <div className="font-semibold whitespace-nowrap">{info.label}</div>
                    <div className="text-xs whitespace-nowrap text-slate-500">{info.hint}</div>
                  </td>
                  <td className={td}>
                    {main ? (
                      <ModelChip model={main} badge={badge(main.connection_id)} onClick={() => onOpen(slot.capability)} aria={`Change model for ${info.label}`} />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onOpen(slot.capability)}
                        className="rounded-md border border-dashed border-slate-400 bg-white px-2.5 py-1 text-xs font-semibold text-brand-700 hover:border-brand-600 dark:bg-slate-900 dark:text-brand-500"
                      >
                        {isGeneralAuto ? 'Auto · choose a model' : '+ Assign model'}
                      </button>
                    )}
                  </td>
                  <td className={td}>
                    {main ? (
                      backup ? (
                        <button
                          type="button"
                          onClick={() => onOpen(slot.capability)}
                          aria-label={`Change backup for ${info.label}`}
                          className="-mx-1.5 flex max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-brand-50 dark:hover:bg-slate-800"
                        >
                          <Badge2 {...badge(backup.connection_id)} />
                          <span className="truncate text-xs text-slate-700 dark:text-slate-300">{modelName(backup)}</span>
                        </button>
                      ) : (
                        <button type="button" onClick={() => onOpen(slot.capability)} className="text-xs whitespace-nowrap text-slate-400 hover:text-brand-700">
                          + Add backup
                        </button>
                      )
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className={td}>
                    {main ? (
                      <div role="radiogroup" aria-label={`Connection for ${info.label}`} className="inline-flex gap-0.5 rounded-full bg-slate-100 p-0.5 dark:bg-slate-800">
                        {data.connections
                          .filter((c) => c.active || c.id === main.connection_id)
                          .map((c) => {
                            const has = data.models.some((m) => m.capability === slot.capability && m.connection_id === c.id);
                            const current = main.connection_id === c.id;
                            return (
                              <button
                                key={c.id}
                                type="button"
                                role="radio"
                                aria-checked={current}
                                disabled={!has || swap.isPending}
                                title={has ? (current ? 'In use' : `Move to ${c.name} now`) : `No ${info.label.toLowerCase()} model on ${c.name}`}
                                onClick={() => !current && swap.mutate({ capabilities: [slot.capability], connectionId: c.id })}
                                className={`h-[26px] rounded-full px-2.5 text-xs whitespace-nowrap ${
                                  current
                                    ? 'cursor-default bg-white font-semibold text-brand-700 shadow-[0_1px_2px_rgba(15,23,32,.14)] dark:bg-slate-950 dark:text-brand-500'
                                    : has
                                      ? 'font-medium text-slate-500 hover:text-slate-900 dark:hover:text-white'
                                      : 'cursor-not-allowed font-medium text-slate-300 dark:text-slate-600'
                                }`}
                              >
                                {c.name}
                              </button>
                            );
                          })}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className={td}>{conn ? <PrivacyPill isPrivate={conn.private} /> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className={`${td} whitespace-nowrap text-slate-600 dark:text-slate-300`}>
                    {unset ? '—' : TRANSPORT_LABEL[slot.transport]}
                    <QueueLine queue={data.queue.find((x) => x.capability === slot.capability)} onOpen={() => onJobs(slot.capability)} />
                  </td>
                  <td className={`${td} text-right text-slate-600 tabular-nums dark:text-slate-300`}>{unset && !usage ? '—' : (usage?.calls ?? 0).toLocaleString()}</td>
                  <td className={`${td} text-right font-medium tabular-nums`}>{unset && !usage ? '—' : money(Number(usage?.spent_usd ?? 0))}</td>
                  <td className={`${td} relative`}>
                    <button
                      type="button"
                      aria-label={`More for ${info.label}`}
                      aria-expanded={menu === slot.capability}
                      onClick={(e) => {
                        setAnchor(e.currentTarget.getBoundingClientRect());
                        setMenu(menu === slot.capability ? null : slot.capability);
                      }}
                      className="grid size-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </button>
                    {menu === slot.capability && anchor && (
                      <RowMenu
                        anchor={anchor}
                        slot={slot}
                        main={main}
                        available={data.available_transports}
                        onClose={() => setMenu(null)}
                        onSave={(patch) => saveSlot.mutate({ capability: slot.capability, patch })}
                        onTest={() => main && onTest(main)}
                        onChange={() => onOpen(slot.capability)}
                        onQueueTest={
                          main && slot.active && QUEUED.includes(slot.transport) && SAMPLE_JOB[slot.capability] ? () => queueTest.mutate(slot.capability) : undefined
                        }
                        onJobs={data.queue_capabilities.includes(slot.capability) ? () => onJobs(slot.capability) : undefined}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-start gap-2 border-t border-[#F5E6B8] bg-[#FFFBEB] px-5 py-3 text-xs leading-relaxed text-[#7A4A06] dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
        <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>
          <strong>Not private</strong> connections may store or train on prompts. Customers' questions are never sent to them; staff questions are.
        </span>
      </div>
    </section>
  );
}

function ModelChip({ model, badge, onClick, aria }: { model: Model; badge: { text: string; className: string }; onClick: () => void; aria: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={aria}
      className="group -mx-1.5 -my-1 flex max-w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:outline-none dark:hover:bg-slate-800"
    >
      <Badge2 {...badge} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-semibold">{modelName(model)}</span>
        <span className="text-[11px] whitespace-nowrap text-slate-500">{priceLabel(model)}</span>
      </span>
      <Pencil className="size-3.5 shrink-0 text-brand-700 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
    </button>
  );
}

/** The ⋯ menu: delivery, a test, and clearing the model. */
function RowMenu({
  anchor,
  slot,
  main,
  available,
  onClose,
  onSave,
  onTest,
  onChange,
  onQueueTest,
  onJobs,
}: {
  anchor: DOMRect;
  slot: Slot;
  main: Model | null;
  available: Transport[];
  onClose: () => void;
  onSave: (patch: Partial<Slot>) => void;
  onTest: () => void;
  onChange: () => void;
  onQueueTest?: () => void;
  onJobs?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', away);
    // Fixed to the window, so it closes rather than drift when the page scrolls.
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  // Below the button when it fits, else on the side with more room, scrolling inside if still too tall.
  const [place, setPlace] = useState<{ top?: number; bottom?: number; maxHeight?: number }>({ top: anchor.bottom + 6 });
  useEffect(() => {
    const h = ref.current?.scrollHeight ?? 0;
    const below = window.innerHeight - anchor.bottom - 14;
    const above = anchor.top - 14;
    if (h <= below) return;
    setPlace(above > below ? { bottom: window.innerHeight - anchor.top + 6, maxHeight: above } : { top: anchor.bottom + 6, maxHeight: below });
  }, [anchor]);
  const item = 'flex w-full items-center rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800';
  return (
    <div
      ref={ref}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      style={{ ...place, right: Math.max(window.innerWidth - anchor.right, 8) }}
      className="fixed z-30 w-72 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-900"
    >
      <button type="button" className={item} onClick={() => (onChange(), onClose())}>
        Change model…
      </button>
      {main && TESTABLE.includes(slot.capability) && (
        <button type="button" className={item} onClick={() => (onTest(), onClose())}>
          {slot.capability === 'text_to_speech' ? 'Hear it' : 'Test'}
        </button>
      )}
      {onQueueTest && (
        <button type="button" className={item} onClick={() => (onQueueTest(), onClose())}>
          Queue a test job
        </button>
      )}
      {onJobs && (
        <button type="button" className={item} onClick={() => (onJobs(), onClose())}>
          Jobs…
        </button>
      )}
      <div className="px-2.5 pt-2 pb-1">
        <p className="mb-1 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Delivery</p>
        {(Object.keys(TRANSPORT_LABEL) as Transport[]).map((t) => {
          const directOnly = t !== 'direct' && DIRECT_ONLY.includes(slot.capability);
          const allowed = available.includes(t) && !directOnly;
          const recommended = RECOMMENDED[slot.capability].transport === t;
          const unavailable = directOnly ? null : t === 'bullmq' || t === 'redis_streams' ? 'needs Redis' : 'coming';
          return (
            <label key={t} className={`flex items-start gap-2 py-1.5 text-[13px] ${allowed ? 'cursor-pointer' : 'text-slate-400'}`}>
              <input
                type="radio"
                className="mt-0.5"
                name={`delivery-${slot.capability}`}
                checked={slot.transport === t}
                disabled={!allowed}
                onChange={() => onSave({ transport: t })}
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  {TRANSPORT_LABEL[t]}
                  {recommended && (
                    <span className="rounded-full bg-brand-50 px-1.5 py-px text-[10px] font-semibold tracking-wide text-brand-800 uppercase dark:bg-brand-950 dark:text-brand-300">
                      Recommended
                    </span>
                  )}
                  {!available.includes(t) && unavailable && <span className="text-xs">({unavailable})</span>}
                </span>
                <span className={`block text-xs ${allowed ? 'text-slate-500' : ''}`}>{TRANSPORT_HINT[t]}</span>
              </span>
            </label>
          );
        })}
        <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-xs text-slate-500 dark:border-slate-800">
          <strong className="font-semibold text-slate-700 dark:text-slate-300">Why {TRANSPORT_LABEL[RECOMMENDED[slot.capability].transport]}:</strong> {RECOMMENDED[slot.capability].why}
        </p>
      </div>
      {main && (
        <button type="button" className={`${item} text-red-700 dark:text-red-400`} onClick={() => (onSave({ model_id: null, backup_model_id: null }), onClose())}>
          Clear model
        </button>
      )}
    </div>
  );
}

// Connections ---------------------------------------------------------------------------------

function Connections({ data, onEdit, onToast }: { data: Overview; onEdit: (c: Connection) => void; onToast: (t: Toast) => void }) {
  const api = useApi();
  const refresh = useRefresh();
  const badge = useBadges(data.connections);
  const swap = useSwap(data, onToast);
  const save = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.put(`/admin/ai/connections/${id}`, { active }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (c: Connection) => api.post<{ ok: boolean; ms: number; models: number | null }>(`/admin/ai/connections/${c.id}/test`, {}).then((r) => ({ r, c })),
    onSuccess: ({ r, c }) => onToast({ msg: `${c.name} answered.`, detail: `${r.models !== null ? `${r.models} models listed · ` : ''}${r.ms.toLocaleString()} ms` }),
    onError: (err) => onToast({ msg: 'Test failed.', detail: (err as Error).message, tone: 'error' }),
  });
  /** Capabilities on this connection that another one can take over. */
  const movable = (from: Connection, to: Connection) =>
    data.slots.filter((s) => data.models.find((m) => m.id === s.model_id)?.connection_id === from.id && swapTarget(data, s, to.id)).map((s) => s.capability);

  return (
    <section aria-labelledby="conn-h" className={box}>
      <div className="border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
        <h2 id="conn-h" className="text-[15px] font-semibold">
          Connections
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">Accounts at AI providers, each with its models, key, privacy and monthly cap.</p>
      </div>
      {!data.encryption_available && (
        <p role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          SETTINGS_ENCRYPTION_KEY is not set on the server, so API keys cannot be stored yet.
        </p>
      )}
      {!data.connections.length ? (
        <p className="px-5 py-6 text-sm text-slate-500">No connections yet. Add one to choose models for each capability.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={`${th} w-[52px]`}>Active</th>
                <th className={th}>Name</th>
                <th className={th}>Kind</th>
                <th className={th}>Models</th>
                <th className={th}>Key</th>
                <th className={th}>Privacy</th>
                <th className={`${th} w-[220px]`}>This month / cap</th>
                <th className={`${th} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.connections.map((c) => {
                const others = data.connections.filter((o) => o.id !== c.id && o.active);
                const count = data.models.filter((m) => m.connection_id === c.id).length;
                const spent = Number(c.spent_usd);
                const cap = c.monthly_cap_usd === null ? null : Number(c.monthly_cap_usd);
                const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
                return (
                  <tr key={c.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${c.active ? '' : 'opacity-60'}`}>
                    <td className={td}>
                      <input type="checkbox" className="switch" aria-label={`${c.name} active`} checked={c.active} disabled={save.isPending} onChange={(e) => save.mutate({ id: c.id, active: e.target.checked })} />
                    </td>
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <Badge2 {...badge(c.id)} />
                        <div className="min-w-0">
                          <div className="font-semibold">{c.name}</div>
                          <div className="truncate font-mono text-[11px] text-slate-500">{c.kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : c.base_url}</div>
                        </div>
                      </div>
                    </td>
                    <td className={`${td} text-slate-600 dark:text-slate-300`}>{KIND_LABEL[c.kind]}</td>
                    <td className={`${td} text-slate-600 dark:text-slate-300`}>
                      {count} model{count === 1 ? '' : 's'}
                    </td>
                    <td className={td}>
                      {c.api_key_last4 ? (
                        <span className="font-mono text-xs text-slate-600 dark:text-slate-300">•••• {c.api_key_last4}</span>
                      ) : c.kind === 'openrouter' ? (
                        <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">Missing</span>
                      ) : (
                        <span className="text-xs text-slate-500">Not needed</span>
                      )}
                    </td>
                    <td className={td}>
                      <PrivacyPill isPrivate={c.private} />
                    </td>
                    <td className={td}>
                      <div className="mb-1 flex justify-between text-xs tabular-nums">
                        <span className="font-semibold">{money(spent)}</span>
                        <span className={cap !== null && spent >= cap ? 'font-semibold text-red-700 dark:text-red-400' : 'text-slate-500'}>{cap === null ? 'No cap' : spent >= cap ? `cap ${money(cap)} reached` : `of ${money(cap)}`}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div className={`h-full ${pct > 80 ? 'bg-amber-600' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                    <td className={`${td} text-right whitespace-nowrap`}>
                      <span className="inline-flex gap-1">
                        {others.length === 1 ? (
                          (() => {
                            const n = movable(c, others[0]).length;
                            return (
                              <button
                                type="button"
                                disabled={!n || swap.isPending}
                                title={n ? `Swap every capability that ${others[0].name} can serve, live` : `Nothing here that ${others[0].name} can take over`}
                                onClick={() => swap.mutate({ capabilities: movable(c, others[0]), connectionId: others[0].id })}
                                className={`press inline-flex h-[30px] items-center rounded-md px-2.5 text-xs font-semibold ${
                                  n ? 'border border-brand-600 bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-500' : 'cursor-not-allowed border border-slate-200 text-slate-300 dark:border-slate-700 dark:text-slate-600'
                                }`}
                              >
                                Move {n} to {others[0].name}
                              </button>
                            );
                          })()
                        ) : others.length > 1 ? (
                          <div className="w-40">
                            <Select
                              aria-label={`Move ${c.name}'s capabilities to`}
                              value=""
                              className="py-1 text-xs"
                              onChange={(e) => {
                                const to = others.find((o) => o.id === e.target.value);
                                if (to) swap.mutate({ capabilities: movable(c, to), connectionId: to.id });
                              }}
                            >
                              <option value="">Move to…</option>
                              {others.map((o) => (
                                <option key={o.id} value={o.id} disabled={!movable(c, o).length}>
                                  {o.name} ({movable(c, o).length})
                                </option>
                              ))}
                            </Select>
                          </div>
                        ) : null}
                        <button type="button" className={smallButton} disabled={test.isPending} onClick={() => test.mutate(c)}>
                          Test
                        </button>
                        <button type="button" className={smallButton} onClick={() => onEdit(c)}>
                          Edit
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Dialogs -------------------------------------------------------------------------------------

function Dialog({ label, onClose, children, width = 'w-[640px]', height }: { label: string; onClose: () => void; children: ReactNode; width?: string; height?: string }) {
  const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-[rgba(15,23,32,.45)] px-4 pt-[8vh] pb-6" onKeyDown={onKeyDown}>
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="fixed inset-0 cursor-default" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`relative flex max-w-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(15,23,32,.28)] dark:bg-slate-900 ${width} ${height ?? ''}`}
      >
        {children}
      </section>
    </div>
  );
}

function DialogHeader({ title, onClose, children }: { title: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {children}
      </div>
      <button type="button" aria-label="Close" onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300">
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Choose a capability's model and backup: search, filter by connection, privacy and price, sort. */
function ModelPicker({ data, capability, onClose, onAddModel }: { data: Overview; capability: Capability; onClose: () => void; onAddModel: () => void }) {
  const api = useApi();
  const refresh = useRefresh();
  const badge = useBadges(data.connections);
  const slot = data.slots.find((s) => s.capability === capability)!;
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [privateOnly, setPrivateOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [sort, setSort] = useState<'name' | 'price' | 'current'>('name');
  const save = useMutation({ mutationFn: (patch: Partial<Slot>) => api.put(`/admin/ai/slots/${capability}`, patch), onSuccess: refresh });
  const info = CAPABILITY[capability];
  const connOf = (m: Model) => data.connections.find((c) => c.id === m.connection_id);
  const forCap = data.models.filter((m) => m.capability === capability);
  const term = q.trim().toLowerCase();
  const shown = forCap
    .filter(
      (m) =>
        !hidden[m.connection_id] &&
        (!privateOnly || connOf(m)?.private) &&
        (!freeOnly || isFree(m)) &&
        (!term || `${modelName(m)} ${m.model} ${connOf(m)?.name ?? ''}`.toLowerCase().includes(term)),
    )
    .sort((a, b) =>
      sort === 'price'
        ? Number(a.input_price ?? 0) - Number(b.input_price ?? 0)
        : sort === 'current'
          ? Number(slot.model_id !== a.id) - Number(slot.model_id !== b.id) || Number(slot.backup_model_id !== a.id) - Number(slot.backup_model_id !== b.id)
          : modelName(a).localeCompare(modelName(b)),
    );
  const main = data.models.find((m) => m.id === slot.model_id);
  const backup = data.models.find((m) => m.id === slot.backup_model_id);
  const connections = data.connections.filter((c) => forCap.some((m) => m.connection_id === c.id));

  return (
    <Dialog label={`Choose the ${info.label} model`} onClose={onClose} width="w-[960px]" height="h-[min(660px,84vh)]">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-5 pt-4 pb-3.5 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <label className="flex h-11 flex-1 items-center gap-2.5 rounded-xl border border-slate-300 bg-slate-50 px-3.5 dark:border-slate-700 dark:bg-slate-800">
            <Search className="size-4 text-slate-500" aria-hidden="true" />
            <span className="sr-only">Search models</span>
            <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models, ids or connections" className="flex-1 bg-transparent text-sm outline-none" />
          </label>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <h2 className="text-[15px] font-semibold">
            {info.label} <span className="font-normal text-slate-500">· {info.hint}</span>
          </h2>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E7F4EF] px-2.5 py-1 text-[#0B6E55] dark:bg-emerald-950 dark:text-emerald-300">
              <strong>Primary</strong> {main ? modelName(main) : capability === 'general' ? 'Auto (server model)' : 'None yet'}
            </span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${backup ? 'bg-[#E7F4EF] text-[#0B6E55] dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
              <strong>Backup</strong> {backup ? modelName(backup) : 'None'}
            </span>
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Filters" className="hidden w-[210px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-slate-200 bg-slate-50 p-4 sm:flex dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex flex-col gap-2">
            <p className={caps}>Connections</p>
            {connections.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input type="checkbox" checked={!hidden[c.id]} onChange={() => setHidden({ ...hidden, [c.id]: !hidden[c.id] })} />
                <Badge2 {...badge(c.id)} size="sm" />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-xs text-slate-400">{forCap.filter((m) => m.connection_id === c.id).length}</span>
              </label>
            ))}
            {!connections.length && <p className="text-xs text-slate-500">None yet.</p>}
          </div>
          <div className="flex flex-col gap-2">
            <p className={caps}>Privacy</p>
            <label className="flex cursor-pointer items-center gap-2 text-[13px]">
              <input type="checkbox" checked={privateOnly} onChange={(e) => setPrivateOnly(e.target.checked)} />
              Private only
            </label>
            <p className="text-[11px] leading-snug text-slate-500">Customers' questions only go to private models.</p>
          </div>
          <div className="flex flex-col gap-2">
            <p className={caps}>Price</p>
            <label className="flex cursor-pointer items-center gap-2 text-[13px]">
              <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
              Free only
            </label>
          </div>
          <button
            type="button"
            onClick={() => {
              setQ('');
              setHidden({});
              setPrivateOnly(false);
              setFreeOnly(false);
            }}
            className="self-start text-xs font-semibold text-brand-700 hover:underline dark:text-brand-500"
          >
            Clear filters
          </button>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-2.5 dark:border-slate-800">
            <span className="text-xs text-slate-500">
              {shown.length} of {forCap.length} models
            </span>
            <div role="tablist" aria-label="Sort" className="flex gap-4 text-xs">
              {(
                [
                  ['name', 'Name'],
                  ['price', 'Lowest price'],
                  ['current', 'Selected first'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={sort === id}
                  onClick={() => setSort(id)}
                  className={`py-1 ${sort === id ? 'font-semibold text-slate-900 shadow-[inset_0_-2px_0_var(--color-brand-600)] dark:text-white' : 'font-medium text-slate-500'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {shown.map((m) => {
              const c = connOf(m);
              const isMain = slot.model_id === m.id;
              const isBackup = slot.backup_model_id === m.id;
              return (
                <div
                  key={m.id}
                  className={`flex items-start gap-3.5 border-b border-slate-100 px-5 py-3.5 dark:border-slate-800 ${isMain ? 'bg-[#F3FAF7] shadow-[inset_3px_0_0_var(--color-brand-600)] dark:bg-slate-800/60' : ''}`}
                >
                  <Badge2 {...badge(m.connection_id)} size="lg" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{modelName(m)}</span>
                      {c && <PrivacyPill isPrivate={c.private} />}
                      {m.tags.map((t) => (
                        <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {t}
                        </span>
                      ))}
                      {isMain && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-bold text-white">Primary</span>}
                      {isBackup && <span className="rounded-full bg-[#E7F4EF] px-2 py-0.5 text-[11px] font-bold text-[#0B6E55]">Backup</span>}
                    </div>
                    <p className="truncate font-mono text-[11px] text-slate-500">{m.model}</p>
                    {m.description && <p className="text-xs leading-snug text-slate-700 dark:text-slate-300">{m.description}</p>}
                    <p className="flex flex-wrap gap-3.5 text-[11px] text-slate-500 tabular-nums">
                      <span>{c?.name}</span>
                      <span>{priceLabel(m)}</span>
                      {contextLabel(m.context_tokens) && <span>{contextLabel(m.context_tokens)}</span>}
                    </p>
                  </div>
                  <div className="flex w-[104px] shrink-0 flex-col gap-1.5">
                    {!isMain && (
                      <button
                        type="button"
                        disabled={save.isPending}
                        onClick={() => save.mutate({ model_id: m.id, backup_model_id: isBackup ? slot.model_id : slot.backup_model_id, ...(capability === 'general' ? { active: true } : {}) })}
                        className="h-[30px] rounded-md bg-brand-600 px-2.5 text-xs font-semibold text-white hover:bg-brand-700"
                      >
                        Use
                      </button>
                    )}
                    {isBackup && (
                      <button type="button" disabled={save.isPending} onClick={() => save.mutate({ backup_model_id: null })} className={smallButton}>
                        Remove backup
                      </button>
                    )}
                    {!isMain && !isBackup && slot.model_id && (
                      <button type="button" disabled={save.isPending} onClick={() => save.mutate({ backup_model_id: m.id })} className={`${smallButton} justify-center`}>
                        As backup
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {!shown.length && (
              <div className="mx-5 my-8 rounded-xl border border-dashed border-slate-300 p-6 text-center text-[13px] text-slate-500 dark:border-slate-700">
                No models match. Clear filters, or add one to a connection.
              </div>
            )}
          </div>
        </div>
      </div>
      {save.error && (
        <div className="px-5">
          <ErrorBanner error={save.error} />
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <button type="button" onClick={onAddModel} className="text-[13px] font-semibold text-brand-700 hover:underline dark:text-brand-500">
          + Add a model to a connection
        </button>
        <button type="button" onClick={onClose} className="h-9 rounded-lg bg-[#0F1720] px-[18px] text-[13px] font-semibold text-white hover:bg-[#1E2A36] dark:bg-white dark:text-slate-900">
          Done
        </button>
      </div>
    </Dialog>
  );
}

/** Add or edit a connection: address, privacy, cap, key, and (editing) its models. */
function ConnectionDialog({ data, connection, onClose, onAddModel }: { data: Overview; connection?: Connection; onClose: () => void; onAddModel: (connectionId: string) => void }) {
  const api = useApi();
  const refresh = useRefresh();
  const [name, setName] = useState(connection?.name ?? '');
  const [kind, setKind] = useState<Kind>(connection?.kind ?? 'openrouter');
  const [baseUrl, setBaseUrl] = useState(connection?.base_url ?? '');
  const [isPrivate, setPrivate] = useState(connection?.private ?? false);
  const [cap, setCap] = useState(connection?.monthly_cap_usd ?? '');
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const body = { name, ...(connection ? {} : { kind }), base_url: kind === 'openrouter' ? null : baseUrl, private: isPrivate, monthly_cap_usd: cap === '' ? null : Number(cap) };
      const saved = connection ? await api.put<Connection>(`/admin/ai/connections/${connection.id}`, body) : await api.post<Connection>('/admin/ai/connections', body);
      if (key.trim()) await api.put(`/admin/ai/connections/${saved.id}/api-key`, { api_key: key.trim() });
      return saved;
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const removeKey = useMutation({ mutationFn: () => api.del(`/admin/ai/connections/${connection!.id}/api-key`), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api.del(`/admin/ai/connections/${connection!.id}`),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const removeModel = useMutation({ mutationFn: (id: string) => api.del(`/admin/ai/models/${id}`), onSuccess: refresh });
  const models = connection ? data.models.filter((m) => m.connection_id === connection.id) : [];
  const live = connection ? data.connections.find((c) => c.id === connection.id) ?? connection : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Dialog label={connection ? `Edit ${connection.name}` : 'Add connection'} onClose={onClose}>
      <DialogHeader title={connection ? `Edit ${connection.name}` : 'Add connection'} onClose={onClose}>
        <p className="mt-0.5 text-xs text-slate-500">An account at an AI provider. Its models can then be chosen for any capability.</p>
      </DialogHeader>
      <form onSubmit={submit} className="grid max-h-[70vh] gap-4 overflow-y-auto px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input required autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenRouter" />
          </Field>
          <Field label="Kind">
            <Select value={kind} disabled={Boolean(connection)} onChange={(e) => setKind(e.target.value as Kind)}>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Base URL">
          {kind === 'openrouter' ? (
            <Input value="https://openrouter.ai/api/v1" readOnly disabled />
          ) : (
            <Input type="url" required maxLength={500} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={kind === 'ollama' ? 'http://localhost:11434/v1' : 'https://models.example.com/v1'} />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`API key${kind === 'openrouter' ? '' : ' (if needed)'}`} hint={live?.api_key_last4 ? `Saved: •••• ${live.api_key_last4}. Paste a new one to replace it.` : 'Encrypted and never shown again.'}>
            <Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={live?.api_key_last4 ? 'Keep the saved key' : 'Paste the key'} disabled={!data.encryption_available} />
          </Field>
          <Field label="Monthly cap (USD)" hint="Blank: no cap. At the cap, the backup (or search) takes over until next month.">
            <Input type="number" min={0} step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" />
          </Field>
        </div>
        {live?.api_key_last4 && (
          <button type="button" onClick={() => window.confirm('Remove the saved key?') && removeKey.mutate()} className="-mt-2 justify-self-start text-xs font-semibold text-red-700 hover:underline dark:text-red-400">
            Remove the saved key
          </button>
        )}
        <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700">
          <input type="checkbox" className="mt-0.5" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
          <span>
            <span className="font-semibold">Private: doesn't store or train on prompts</span>
            <span className="block text-xs text-slate-500">
              Only private connections get customers' questions.{' '}
              {kind === 'openrouter' ? 'On OpenRouter this also limits requests to providers that deny data collection (free models usually stop working).' : 'Tick only if the provider guarantees it.'}
            </span>
          </span>
        </label>
        {!isPrivate && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            Not private: customers' questions are never sent to this connection; staff questions are.
          </p>
        )}
        {connection && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Models</p>
              <button type="button" onClick={() => onAddModel(connection.id)} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-500">
                + Add model
              </button>
            </div>
            {models.length ? (
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                {models.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{modelName(m)}</span>
                      <span className="block truncate font-mono text-[11px] text-slate-500">
                        {m.model} · {CAPABILITY[m.capability].label}
                      </span>
                    </span>
                    <span className="text-xs text-slate-500">{priceLabel(m)}</span>
                    <button type="button" aria-label={`Remove ${m.model}`} onClick={() => window.confirm(`Remove ${m.model}?`) && removeModel.mutate(m.id)} className="grid size-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-red-700 dark:hover:bg-slate-800">
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">No models yet.</p>
            )}
          </div>
        )}
        {(save.error || remove.error || removeKey.error || removeModel.error) && <ErrorBanner error={save.error ?? remove.error ?? removeKey.error ?? removeModel.error} />}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          {connection && (
            <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => window.confirm(`Delete ${connection.name} and its models?`) && remove.mutate()}>
              Delete
            </Button>
          )}
          <span className="ml-auto" />
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            {connection ? 'Save' : 'Add connection'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddModelDialog({ data, preset, onClose }: { data: Overview; preset: { capability?: Capability; connectionId?: string }; onClose: () => void }) {
  const api = useApi();
  const refresh = useRefresh();
  const [connectionId, setConnectionId] = useState(preset.connectionId ?? data.connections[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const [capability, setCapability] = useState<Capability>(preset.capability ?? 'general');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState('');
  const [moe, setMoe] = useState(false);
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [voice, setVoice] = useState('');
  const connection = data.connections.find((c) => c.id === connectionId);
  const presets = PRESETS.filter((p) => connection && p.kinds.includes(connection.kind) && (!preset.capability || p.capability === preset.capability));
  const save = useMutation({
    mutationFn: () =>
      api.post('/admin/ai/models', {
        connection_id: connectionId,
        model,
        capability,
        label: label || null,
        description: description || null,
        context_tokens: context === '' ? null : Number(context),
        tags: moe ? ['MoE'] : [],
        input_price: inputPrice === '' ? null : Number(inputPrice),
        output_price: outputPrice === '' ? null : Number(outputPrice),
        options: capability === 'text_to_speech' && voice.trim() ? { voice: voice.trim() } : {},
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const usePreset = (name: string) => {
    const p = presets.find((x) => x.label === name);
    if (!p) return;
    setModel(p.model);
    setLabel(p.label);
    setCapability(p.capability);
    setDescription(p.description);
    setContext(p.context_tokens ? String(p.context_tokens) : '');
    setMoe(p.tags.includes('MoE'));
    setInputPrice(String(p.input_price));
    setOutputPrice(String(p.output_price));
    setVoice(p.voice ?? '');
  };
  return (
    <Dialog label="Add a model" onClose={onClose}>
      <DialogHeader title="Add a model" onClose={onClose}>
        <p className="mt-0.5 text-xs text-slate-500">A model at one of your connections, for one capability.</p>
      </DialogHeader>
      {!data.connections.length ? (
        <p className="px-5 py-6 text-sm text-slate-500">Add a connection first.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="grid max-h-[70vh] gap-4 overflow-y-auto px-5 py-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Connection">
              <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {data.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.private ? '' : ' (not private)'}
                  </option>
                ))}
              </Select>
            </Field>
            {presets.length > 0 ? (
              <Field label="Start from">
                <Select value="" onChange={(e) => usePreset(e.target.value)}>
                  <option value="">A preset (optional)</option>
                  {presets.map((p) => (
                    <option key={p.label} value={p.label}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <span />
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model id">
              <Input required autoFocus maxLength={200} value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. google/gemma-4-26b-a4b-it" />
            </Field>
            <Field label="Name (optional)">
              <Input maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Gemma 4 26B A4B" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Capability">
              <Select value={capability} onChange={(e) => setCapability(e.target.value as Capability)}>
                {CAPABILITIES.map((c) => (
                  <option key={c} value={c}>
                    {CAPABILITY[c].label}
                  </option>
                ))}
              </Select>
            </Field>
            {capability === 'text_to_speech' ? (
              <Field label="Voice">
                <Input maxLength={100} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="e.g. nadine" />
              </Field>
            ) : (
              <Field label="Context (tokens)">
                <Input type="number" min={1} value={context} onChange={(e) => setContext(e.target.value)} placeholder="e.g. 128000" />
              </Field>
            )}
          </div>
          <Field label="Description (optional)">
            <Input maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it is good at" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={`Input (USD per M ${capability === 'text_to_speech' ? 'chars' : 'tokens'})`}>
              <Input type="number" min={0} step="0.0001" value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} />
            </Field>
            <Field label="Output (USD per M tokens)">
              <Input type="number" min={0} step="0.0001" value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)} disabled={capability === 'text_to_speech'} />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:pt-6">
              <input type="checkbox" checked={moe} onChange={(e) => setMoe(e.target.checked)} /> Mixture of experts
            </label>
          </div>
          {connection && !connection.private && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {connection.name} is not private: customers' questions are never sent to this model.
            </p>
          )}
          {save.error && <ErrorBanner error={save.error} />}
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!model.trim() || !connectionId || save.isPending}>
              Add model
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** A short reply (General) or a spoken sentence (text to speech) from one model. */
function TestDialog({ model, onClose }: { model: Model; onClose: () => void }) {
  const api = useApi();
  const refresh = useRefresh();
  const test = useMutation({
    mutationFn: () => api.post<{ ms: number; reply?: string; audio?: string; mime?: string }>(`/admin/ai/models/${model.id}/test`, {}),
    onSettled: refresh,
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    test.mutate();
  }, [test]);
  return (
    <Dialog label={`Test ${modelName(model)}`} onClose={onClose} width="w-[480px]">
      <DialogHeader title={`Test ${modelName(model)}`} onClose={onClose}>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">{model.model}</p>
      </DialogHeader>
      <div className="grid gap-3 px-5 py-4 text-sm">
        {test.isPending && <Spinner label="Testing" />}
        {test.data && (
          <>
            <p role="status" className="font-semibold text-emerald-700 dark:text-emerald-400">
              Passed in {test.data.ms.toLocaleString()} ms
            </p>
            {test.data.reply !== undefined && <p className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">“{test.data.reply || '(empty)'}”</p>}
            {test.data.audio && <audio controls autoPlay src={`data:${test.data.mime};base64,${test.data.audio}`} className="w-full" />}
          </>
        )}
        {test.error && <ErrorBanner error={test.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>
            Run again
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}

function UsageDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const q = useQuery({ queryKey: ['ai-calls'], queryFn: () => api.get<Call[]>('/admin/ai/calls?limit=100') });
  return (
    <Dialog label="Usage log" onClose={onClose} width="w-[1000px]">
      <DialogHeader title="Usage log" onClose={onClose}>
        <p className="mt-0.5 text-xs text-slate-500">The latest calls: model, size, cost and time. Prompts and replies are not stored.</p>
      </DialogHeader>
      <div className="max-h-[70vh] overflow-auto">
        {q.isLoading ? (
          <div className="p-5">
            <Spinner />
          </div>
        ) : !q.data?.length ? (
          <p className="px-5 py-6 text-sm text-slate-500">No calls yet.</p>
        ) : (
          <table className="w-full min-w-[820px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={`${th} min-w-[190px]`}>Capability</th>
                <th className={th}>Model</th>
                <th className={th}>Connection</th>
                <th className={th}>For</th>
                <th className={`${th} text-right`}>Units in / out</th>
                <th className={`${th} text-right`}>Cost</th>
                <th className={`${th} text-right`}>Time</th>
                <th className={th}>Result</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id}>
                  <td className={`${td} whitespace-nowrap text-slate-500`}>{dateTime(c.created_at)}</td>
                  <td className={td}>{CAPABILITY[c.capability]?.label ?? c.capability}</td>
                  <td className={`${td} max-w-52 truncate font-mono text-xs`}>{c.model}</td>
                  <td className={`${td} text-slate-600 dark:text-slate-300`}>{c.connection_name ?? '—'}</td>
                  <td className={`${td} text-slate-500`}>
                    {c.audience}
                    {c.step ? ` · ${c.step}` : ''}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{[c.input_units, c.output_units].filter((n) => n !== null).join(' / ') || '—'}</td>
                  <td className={`${td} text-right tabular-nums`}>${Number(c.cost_usd).toFixed(4)}</td>
                  <td className={`${td} text-right tabular-nums`}>{c.ms === null ? '—' : `${c.ms.toLocaleString()} ms`}</td>
                  <td className={`${td} ${c.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`} title={c.error ?? undefined}>
                    {c.ok ? 'ok' : 'failed'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}

/** Under a queued delivery: what's waiting, running or failed today, opening the jobs. */
function QueueLine({ queue, onOpen }: { queue?: Overview['queue'][number]; onOpen: () => void }) {
  if (!queue) return null;
  const parts = [
    queue.queued > 0 && `${queue.queued} waiting`,
    queue.running > 0 && `${queue.running} running`,
    queue.failed > 0 && `${queue.failed} failed`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <button type="button" onClick={onOpen} className={`block text-xs hover:underline ${queue.failed > 0 ? 'text-red-700 dark:text-red-400' : 'text-brand-700 dark:text-brand-400'}`}>
      {parts.join(' · ')}
    </button>
  );
}

const JOB_TONE: Record<JobStatus, string> = {
  queued: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  done: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300',
  cancelled: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

/** Shortens long arrays (vectors) and data links (images) so a result stays readable. */
function preview(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (Array.isArray(v) && v.length > 8 && v.every((x) => typeof x === 'number')) return [...v.slice(0, 8), `… ${v.length - 8} more`];
      if (typeof v === 'string' && v.startsWith('data:') && v.length > 120) return `${v.slice(0, 60)}… (${Math.round(v.length / 1024)} KB)`;
      return v;
    },
    2,
  );
}

/** The Postgres queue's jobs: status, attempts, model, cost and errors; retry, cancel and see a result. */
function JobsDialog({ capability, onClose, onToast }: { capability?: Capability; onClose: () => void; onToast: (t: Toast) => void }) {
  const api = useApi();
  const refresh = useRefresh();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | JobStatus>('all');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['ai-jobs', status],
    queryFn: () => api.get<Job[]>(`/admin/ai/jobs?limit=100${status === 'all' ? '' : `&status=${status}`}`),
    // While the dialog is open, follow jobs as the worker runs them.
    refetchInterval: 3_000,
  });
  const detail = useQuery({ queryKey: ['ai-job', open], queryFn: () => api.get<Job>(`/admin/ai/jobs/${open}`), enabled: Boolean(open), refetchInterval: 3_000 });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'retry' | 'cancel' }) => api.post(`/admin/ai/jobs/${id}/${action}`, {}),
    onSuccess: (_, v) => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['ai-jobs'] });
      onToast({ msg: v.action === 'retry' ? 'Job queued again.' : 'Job cancelled.' });
    },
    onError: (err) => onToast({ msg: 'Not changed.', detail: (err as Error).message, tone: 'error' }),
  });
  const jobs = (q.data ?? []).filter((j) => !capability || j.capability === capability);
  return (
    <Dialog label="Jobs" onClose={onClose} width="w-[1040px]">
      <DialogHeader title={capability ? `Jobs · ${CAPABILITY[capability].label}` : 'Jobs'} onClose={onClose}>
        <p className="mt-0.5 text-xs text-slate-500">
          Capabilities delivered through a queue (Postgres, BullMQ or Redis Streams) run here: the worker takes each job, tries the model then its backup, and retries failures
          with backoff. Jobs are kept in Postgres whatever carries them; finished ones for 30 days.
        </p>
      </DialogHeader>
      <div className="px-5 pt-3">
        <Tabs
          label="Job status"
          value={status}
          onChange={setStatus}
          tabs={[
            { key: 'all', label: 'All' },
            { key: 'queued', label: 'Waiting' },
            { key: 'running', label: 'Running' },
            { key: 'done', label: 'Done' },
            { key: 'failed', label: 'Failed' },
          ]}
        />
      </div>
      <div className="max-h-[60vh] overflow-auto">
        {q.isLoading ? (
          <div className="p-5">
            <Spinner />
          </div>
        ) : !jobs.length ? (
          <p className="px-5 py-6 text-sm text-slate-500">No jobs{status === 'all' ? ' yet' : ''}.</p>
        ) : (
          <table className="w-full min-w-[900px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={th}>Queued</th>
                <th className={th}>Capability</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Tries</th>
                <th className={th}>Model</th>
                <th className={`${th} text-right`}>Cost</th>
                <th className={`${th} text-right`}>Time</th>
                <th className={th}>Note</th>
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={open === j.id ? 'bg-brand-50/50 dark:bg-brand-950/30' : undefined}>
                  <td className={`${td} whitespace-nowrap text-slate-500`}>{dateTime(j.created_at)}</td>
                  <td className={td}>
                    {CAPABILITY[j.capability]?.label ?? j.capability}
                    <span className="block text-xs text-slate-500">{TRANSPORT_LABEL[j.transport] ?? j.transport}</span>
                  </td>
                  <td className={td}>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${JOB_TONE[j.status]}`}>
                      {j.status === 'queued' && j.attempts > 0 ? 'retrying' : j.status}
                    </span>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {j.attempts}/{j.max_attempts}
                  </td>
                  <td className={`${td} max-w-48 truncate`} title={j.model ?? undefined}>
                    {j.model ? (
                      <>
                        <span className="font-mono text-xs">{j.model}</span>
                        {j.connection_name && <span className="block text-xs text-slate-500">{j.connection_name}</span>}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>${Number(j.cost_usd).toFixed(4)}</td>
                  <td className={`${td} text-right tabular-nums`}>{j.ms === null ? '—' : `${j.ms.toLocaleString()} ms`}</td>
                  <td className={`${td} max-w-60 text-xs text-slate-500`}>
                    {j.error ? <span className="line-clamp-2 text-red-700 dark:text-red-400">{j.error}</span> : j.status === 'queued' && j.attempts > 0 ? `next try ${dateTime(j.run_after)}` : ''}
                  </td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    <span className="inline-flex gap-1.5">
                      <button type="button" className={smallButton} onClick={() => setOpen(open === j.id ? null : j.id)} aria-expanded={open === j.id}>
                        {open === j.id ? 'Hide' : 'View'}
                      </button>
                      {(j.status === 'failed' || j.status === 'cancelled') && (
                        <button type="button" className={smallButton} disabled={act.isPending} onClick={() => act.mutate({ id: j.id, action: 'retry' })}>
                          Retry
                        </button>
                      )}
                      {j.status === 'queued' && (
                        <button type="button" className={smallButton} disabled={act.isPending} onClick={() => act.mutate({ id: j.id, action: 'cancel' })}>
                          Cancel
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-3 border-t border-slate-200 p-5 sm:grid-cols-2 dark:border-slate-800">
          {detail.isLoading || !detail.data ? (
            <Spinner />
          ) : (
            <>
              <div>
                <p className={`${caps} mb-1.5`}>Input</p>
                <pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 text-xs break-words whitespace-pre-wrap dark:bg-slate-950">{preview(detail.data.input)}</pre>
              </div>
              <div>
                <p className={`${caps} mb-1.5`}>Result</p>
                {Array.isArray(detail.data.result?.images) && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {(detail.data.result.images as string[]).slice(0, 4).map((src) => (
                      <img key={src.slice(0, 80)} src={src} alt="Generated" className="size-32 rounded-lg border border-slate-200 object-cover dark:border-slate-800" />
                    ))}
                  </div>
                )}
                <pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 text-xs break-words whitespace-pre-wrap dark:bg-slate-950">
                  {detail.data.result ? preview(detail.data.result) : detail.data.status === 'done' ? '—' : 'Not finished yet.'}
                </pre>
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
