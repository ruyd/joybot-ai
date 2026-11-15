import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Page } from '../../components/Layout';
import { Badge, Button, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';

type Provider = 'openrouter' | 'custom' | 'none' | null;
type Hosted = 'openrouter' | 'custom';
/** How chat answers: the server's model (Auto), a model chosen here, or search only. */
type Mode = 'auto' | 'model' | 'none';
const modeOf = (p: Provider): Mode => (p === null ? 'auto' : p === 'none' ? 'none' : 'model');

interface AiSettings {
  provider: Provider;
  model: string | null;
  base_url: string | null;
  /** OpenRouter: only providers that don't store or train on prompts. */
  private_only: boolean;
  api_key_last4: string | null;
  api_key_set_at: string | null;
  /** The server's default model (MODEL_NAME), or null: answers list the records found. */
  server_default: string | null;
  encryption_available: boolean;
}

interface AssistantSettings {
  assistant_customers: boolean;
  assistant_employees: boolean;
}

/** Gemma 4 on OpenRouter (E2B isn't listed there; 26B A4B is the cheapest). */
const OPENROUTER_MODELS = ['google/gemma-4-26b-a4b-it', 'google/gemma-4-31b-it'];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

const section = 'rounded-xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900';
const sectionTitle = 'text-lg font-semibold tracking-tight';
const sectionLead = 'mt-0.5 text-sm text-slate-500 dark:text-slate-400';
const linkButton =
  'press inline-flex w-fit items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-600 dark:hover:bg-slate-800';

/** Admin › AI: whether the assistant is shown, how chat answers, and which model. */
export function AiPage() {
  const api = useApi();
  const settings = useQuery({ queryKey: ['ai-settings'], queryFn: () => api.get<AiSettings>('/admin/ai') });
  // "Model" chosen but not saved yet shows the model form; Auto and search only save at once.
  const [mode, setMode] = useState<Mode | null>(null);
  const s = settings.data;
  const shown = mode ?? (s ? modeOf(s.provider) : null);
  return (
    <Page>
      <PageHeader title="AI" description="Turn the assistant on or off, choose how chat answers, and which model writes the replies." />
      <div className="grid max-w-5xl gap-5">
        <section className={section}>
          <h2 className={sectionTitle}>Assistant</h2>
          <p className={sectionLead}>Turn the assistant on or off, and choose how it answers.</p>
          <AssistantToggles />
          <h3 className="mt-6 mb-2 text-sm font-semibold">How chat answers</h3>
          {settings.isLoading ? (
            <Spinner />
          ) : settings.error || !s ? (
            <ErrorBanner error={settings.error} />
          ) : (
            <AnswerMode settings={s} mode={shown!} onMode={setMode} />
          )}
        </section>
        {s && shown === 'model' && <ModelCard key={s.provider ?? 'auto'} settings={s} onSaved={() => setMode(null)} />}
        {s && <TestCard settings={s} />}
      </div>
    </Page>
  );
}

/** A bordered tile: a toggle or a choice with a label and a line under it. */
function ChoiceTile({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${
        selected ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600 dark:bg-slate-800' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
      }`}
    >
      {children}
    </label>
  );
}

function AssistantToggles() {
  const api = useApi();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<AssistantSettings>('/settings') });
  const save = useMutation({
    mutationFn: (patch: Partial<AssistantSettings>) => api.put<AssistantSettings>('/admin/settings', patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const toggle = (key: keyof AssistantSettings, label: string, hint: string) => (
    <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
      <input type="checkbox" className="switch" checked={q.data?.[key] ?? true} disabled={!q.data || save.isPending} onChange={(e) => save.mutate({ [key]: e.target.checked })} />
    </label>
  );
  return (
    <div className="mt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {toggle('assistant_customers', 'For customers', 'Portal and website chat')}
        {toggle('assistant_employees', 'For employees', 'Ask JoyBot in the staff app')}
      </div>
      <p className="mt-2 text-xs text-slate-500">Turned off, the assistant is hidden and no new questions are answered. Past conversations are kept.</p>
      {save.error && <ErrorBanner error={save.error} />}
    </div>
  );
}

function AnswerMode({ settings: s, mode, onMode }: { settings: AiSettings; mode: Mode; onMode: (m: Mode | null) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (provider: null | 'none') => api.put<AiSettings>('/admin/ai', { provider, model: null, base_url: null, private_only: s.private_only }),
    onSuccess: (data) => {
      queryClient.setQueryData(['ai-settings'], data);
      onMode(null);
    },
  });
  const choose = (m: Mode) => {
    if (m === 'model') return onMode(modeOf(s.provider) === 'model' ? null : 'model');
    if (modeOf(s.provider) === m) return onMode(null);
    save.mutate(m === 'auto' ? null : 'none');
  };
  const option = (value: Mode, label: string, hint: string) => (
    <ChoiceTile selected={mode === value}>
      <input type="radio" name="ai-mode" className="mt-0.5" checked={mode === value} disabled={save.isPending} onChange={() => choose(value)} />
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>
      </span>
    </ChoiceTile>
  );
  return (
    <fieldset>
      <legend className="sr-only">How chat answers</legend>
      <div className="grid gap-3 md:grid-cols-3">
        {option('model', 'Model', 'A model you choose here (OpenRouter or your own endpoint) writes every answer. If it fails, chat falls back to search.')}
        {option(
          'auto',
          'Auto (search as backup)',
          s.server_default
            ? `Uses the server's model (${s.server_default}), and falls back to search results if it is unavailable.`
            : 'No model is set on this server, so chat answers with search results. Set one on the server and Auto uses it.',
        )}
        {option('none', 'No model — search only', 'Answers with matching saved answers, passages and records. Nothing is sent to an AI provider.')}
      </div>
      {save.error && <ErrorBanner error={save.error} />}
    </fieldset>
  );
}

function ModelCard({ settings: s, onSaved }: { settings: AiSettings; onSaved: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<Hosted>(s.provider === 'custom' ? 'custom' : 'openrouter');
  const [model, setModel] = useState(s.model ?? (s.provider === 'custom' ? '' : OPENROUTER_MODELS[0]!));
  const [baseUrl, setBaseUrl] = useState(s.base_url ?? '');
  const [privateOnly, setPrivateOnly] = useState(s.private_only);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.put<AiSettings>('/admin/ai', {
        provider,
        model,
        base_url: provider === 'custom' ? baseUrl : null,
        private_only: privateOnly,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['ai-settings'], data);
      setSaved(true);
      onSaved();
    },
  });
  const inUse = s.provider === 'openrouter' || s.provider === 'custom';
  const changed =
    provider !== s.provider || model !== (s.model ?? '') || (provider === 'openrouter' && privateOnly !== s.private_only) || (provider === 'custom' && baseUrl !== (s.base_url ?? ''));
  const needsKey = s.provider === 'openrouter' && !s.api_key_last4;

  return (
    <section className={section}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={sectionTitle}>Chat model</h2>
        {!inUse ? <Badge tone="amber">Not saved</Badge> : needsKey ? <Badge tone="amber">Needs a key</Badge> : <Badge tone="green">In use</Badge>}
      </div>
      <form
        className="mt-4 grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Provider">
            <Select
              value={provider}
              onChange={(e) => {
                const p = e.target.value as Hosted;
                setProvider(p);
                setSaved(false);
                if (p === 'openrouter' && !model) setModel(OPENROUTER_MODELS[0]!);
              }}
            >
              <option value="openrouter">OpenRouter</option>
              <option value="custom">Own deployment</option>
            </Select>
          </Field>
          <Field label="Model">
            <Input
              list="ai-model-suggestions"
              maxLength={200}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === 'openrouter' ? 'google/gemma-4-26b-a4b-it' : 'The name the endpoint expects'}
              required
            />
            <datalist id="ai-model-suggestions">{provider === 'openrouter' && OPENROUTER_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
          <Field label="Base URL">
            {provider === 'custom' ? (
              <Input type="url" maxLength={500} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://models.example.com/v1" required />
            ) : (
              <Input value={OPENROUTER_URL} readOnly disabled />
            )}
          </Field>
        </div>
        {provider === 'openrouter' && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={privateOnly} onChange={(e) => setPrivateOnly(e.target.checked)} />
            <span>
              <span className="font-medium">Only providers that don't store prompts</span>
              <span className="block text-xs text-slate-500">Questions include customer records. Free models usually log prompts, so they stop working with this on.</span>
            </span>
          </label>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={(inUse && !changed) || save.isPending}>
            Save model
          </Button>
          {saved && !changed && (
            <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
              Saved
            </span>
          )}
        </div>
        {save.error && <ErrorBanner error={save.error} />}
      </form>
      <div className="mt-5 border-t border-slate-100 pt-5 dark:border-slate-800">
        <ApiKey settings={s} provider={provider} />
      </div>
    </section>
  );
}

function ApiKey({ settings: s, provider }: { settings: AiSettings; provider: Hosted }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const done = (data: AiSettings) => queryClient.setQueryData(['ai-settings'], data);
  const save = useMutation({
    mutationFn: () => api.put<AiSettings>('/admin/ai/api-key', { api_key: key.trim() }),
    onSuccess: (data) => {
      done(data);
      setKey('');
      setReplacing(false);
    },
  });
  const remove = useMutation({ mutationFn: () => api.del('/admin/ai/api-key').then(() => api.get<AiSettings>('/admin/ai')), onSuccess: done });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <div className="grid gap-3 text-sm">
      <p className="font-semibold">API key{provider === 'custom' && <span className="font-normal text-slate-500"> (if the endpoint needs one)</span>}</p>
      {!s.encryption_available && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          SETTINGS_ENCRYPTION_KEY is not set on the server, so a key cannot be stored yet.
        </p>
      )}
      {s.api_key_last4 && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-10 min-w-48 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-sm tracking-wider text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            ••••••••••••{s.api_key_last4}
          </span>
          <Button type="button" variant="secondary" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => window.confirm('Remove the API key?') && remove.mutate()}>
            Remove
          </Button>
          <span className="text-xs text-slate-500">saved {dateTime(s.api_key_set_at)}</span>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            aria-label="API key"
            autoComplete="off"
            spellCheck={false}
            placeholder={provider === 'openrouter' ? 'Paste the key (sk-or-…)' : 'Paste the key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="min-w-64 flex-1 sm:max-w-sm"
          />
          <Button type="submit" variant="secondary" disabled={!key.trim() || save.isPending || !s.encryption_available}>
            Save key
          </Button>
          {replacing && (
            <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
              Keep the current key
            </Button>
          )}
        </form>
      )}
      {provider === 'openrouter' && !s.api_key_last4 && (
        <div className="flex flex-wrap items-center gap-3">
          <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" className={linkButton}>
            Open API keys in OpenRouter <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
          <span className="text-xs text-slate-500">Add credits first; Gemma costs a fraction of a cent per question. Until a key is saved, chat uses Auto.</span>
        </div>
      )}
      <p className="text-xs text-slate-500">Keys are encrypted and never shown again; only the last four characters appear here.</p>
      {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
    </div>
  );
}

/** One short prompt to the model chat would use now. */
function TestCard({ settings: s }: { settings: AiSettings }) {
  const api = useApi();
  const test = useMutation({ mutationFn: () => api.post<{ reply: string; ms: number; model: string }>('/admin/ai/test', {}) });
  useEffect(() => test.reset(), [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const usable = s.provider === 'none' ? false : s.provider || s.server_default;
  return (
    <section className={section}>
      <h2 className={sectionTitle}>Test</h2>
      <p className={sectionLead}>Sends one short prompt to the model chat uses now.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          disabled={!usable || test.isPending}
          onClick={() => test.mutate()}
          className="press min-h-10 rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
        >
          {test.isPending ? 'Asking…' : 'Run test'}
        </button>
        {!usable && <span className="text-slate-500">{s.provider === 'none' || !s.server_default ? 'Search only: there is no model to test.' : 'Choose a provider first.'}</span>}
        {test.data && (
          <span role="status" className="font-semibold text-emerald-700 dark:text-emerald-400">
            Test passed · {test.data.ms.toLocaleString()} ms · {test.data.model} replied “{test.data.reply || '(empty)'}”
          </span>
        )}
      </div>
      {test.error && (
        <div className="mt-3">
          <ErrorBanner error={test.error} />
        </div>
      )}
    </section>
  );
}
