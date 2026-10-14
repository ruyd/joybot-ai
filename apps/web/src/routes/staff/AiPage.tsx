import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Page } from '../../components/Layout';
import { Button, Card, ErrorBanner, Field, Input, PageHeader, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';

type Provider = 'openrouter' | 'custom' | null;

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

const linkButton =
  'press inline-flex w-fit items-center gap-1.5 rounded-full border border-slate-300 px-3.5 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-600 dark:hover:bg-slate-800';

/** Admin › AI: whether the assistant is shown, and which model answers it. */
export function AiPage() {
  const api = useApi();
  const settings = useQuery({ queryKey: ['ai-settings'], queryFn: () => api.get<AiSettings>('/admin/ai') });
  return (
    <Page>
      <PageHeader title="AI" description="Turn the assistant on or off, and choose the model that answers it." />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <AssistantCard />
        {settings.isLoading ? (
          <Spinner />
        ) : settings.error || !settings.data ? (
          <ErrorBanner error={settings.error} />
        ) : (
          <div className="grid gap-4">
            <ModelCard settings={settings.data} />
            <TestCard settings={settings.data} />
          </div>
        )}
      </div>
    </Page>
  );
}

function AssistantCard() {
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
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" checked={q.data?.[key] ?? true} disabled={!q.data || save.isPending} onChange={(e) => save.mutate({ [key]: e.target.checked })} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
  return (
    <Card title="Assistant">
      {!q.data ? (
        <Spinner />
      ) : (
        <div className="grid gap-3">
          {toggle('assistant_customers', 'Show the assistant to customers', 'The Assistant page and the chat box in the portal. Off: customers land on their appointments.')}
          {toggle('assistant_employees', 'Show the assistant to staff', 'The Assistant page and the chat box in the staff console.')}
          <p className="text-xs text-slate-500">Turned off, the assistant is hidden and no new questions are answered. Past conversations are kept.</p>
          {save.error && <ErrorBanner error={save.error} />}
        </div>
      )}
    </Card>
  );
}

function ModelCard({ settings: s }: { settings: AiSettings }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<Provider>(s.provider);
  const [model, setModel] = useState(s.model ?? '');
  const [baseUrl, setBaseUrl] = useState(s.base_url ?? '');
  const [privateOnly, setPrivateOnly] = useState(s.private_only);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.put<AiSettings>('/admin/ai', {
        provider,
        model: provider ? model : null,
        base_url: provider === 'custom' ? baseUrl : null,
        private_only: privateOnly,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['ai-settings'], data);
      setSaved(true);
    },
  });
  const changed = provider !== s.provider || (provider !== null && (model !== (s.model ?? '') || privateOnly !== s.private_only)) || (provider === 'custom' && baseUrl !== (s.base_url ?? ''));
  const choose = (p: Provider) => {
    setProvider(p);
    setSaved(false);
    if (p === 'openrouter' && !model) setModel(OPENROUTER_MODELS[0]);
  };
  const option = (value: Provider, label: string, hint: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="radio" name="ai-provider" className="mt-0.5" checked={provider === value} onChange={() => choose(value)} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );

  return (
    <Card title="Chat model">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <fieldset className="grid gap-2">
          <legend className="sr-only">Provider</legend>
          {option('openrouter', 'OpenRouter', 'Hosted models, paid per use. Needs an OpenRouter API key.')}
          {option('custom', 'Own deployment', 'Any OpenAI-compatible endpoint (vLLM, Ollama, another provider).')}
          {option(
            null,
            'Server default',
            s.server_default ? `The model set on the server (${s.server_default}).` : 'No model on this server: answers list the records found, without writing a reply.',
          )}
        </fieldset>
        {provider && (
          <Field label="Model" hint={provider === 'openrouter' ? 'An OpenRouter model id, e.g. google/gemma-4-26b-a4b-it' : 'The model name the endpoint expects'}>
            <Input list="ai-model-suggestions" maxLength={200} value={model} onChange={(e) => setModel(e.target.value)} required />
            <datalist id="ai-model-suggestions">{provider === 'openrouter' && OPENROUTER_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
        )}
        {provider === 'custom' && (
          <Field label="Base URL" hint="Up to /v1, e.g. https://models.example.com/v1">
            <Input type="url" maxLength={500} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </Field>
        )}
        {provider === 'openrouter' && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={privateOnly} onChange={(e) => setPrivateOnly(e.target.checked)} />
            <span>
              <span className="font-medium">Only providers that don't store prompts</span>
              <span className="block text-xs text-slate-500">
                Questions include customer records. Free models usually log prompts, so they stop working with this on.
              </span>
            </span>
          </label>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="secondary" disabled={!changed || save.isPending}>
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
      {provider && (
        <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
          <ApiKey settings={s} provider={provider} />
        </div>
      )}
    </Card>
  );
}

function ApiKey({ settings: s, provider }: { settings: AiSettings; provider: 'openrouter' | 'custom' }) {
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
      <p className="font-medium text-slate-900 dark:text-slate-100">API key{provider === 'custom' && <span className="font-normal text-slate-500"> (if the endpoint needs one)</span>}</p>
      {provider === 'openrouter' && (
        <>
          <p className="text-slate-600 dark:text-slate-300">
            Create a key in OpenRouter (add credits first; Gemma costs a fraction of a cent per question). It is stored encrypted and never shown again.
          </p>
          <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" className={linkButton}>
            Open API keys in OpenRouter <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
          {!s.api_key_last4 && s.provider === 'openrouter' && (
            <p role="status" className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Until a key is saved, chat uses the server default.
            </p>
          )}
        </>
      )}
      {!s.encryption_available && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          SETTINGS_ENCRYPTION_KEY is not set on the server, so a key cannot be stored yet.
        </p>
      )}
      {s.api_key_last4 && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">••••••••{s.api_key_last4}</code>
          <span className="text-xs text-slate-500">saved {dateTime(s.api_key_set_at)}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={remove.isPending} onClick={() => window.confirm('Remove the API key?') && remove.mutate()}>
            Remove
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <Field label="Paste the key">
              <Input type="password" autoComplete="off" spellCheck={false} placeholder={provider === 'openrouter' ? 'sk-or-…' : ''} value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" disabled={!key.trim() || save.isPending || !s.encryption_available}>
            Save key
          </Button>
          {replacing && (
            <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
              Keep the current key
            </Button>
          )}
        </form>
      )}
      {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
    </div>
  );
}

/** One short prompt to the model chat would use now. */
function TestCard({ settings: s }: { settings: AiSettings }) {
  const api = useApi();
  const test = useMutation({ mutationFn: () => api.post<{ reply: string; ms: number; model: string }>('/admin/ai/test', {}) });
  useEffect(() => test.reset(), [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const usable = s.provider || s.server_default;
  return (
    <Card title="Test">
      <div className="grid gap-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">Sends one short prompt to the model chat uses now.</p>
        <div>
          <Button type="button" variant="secondary" disabled={!usable || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Asking…' : 'Send test prompt'}
          </Button>
        </div>
        {!usable && <p className="text-xs text-slate-500">Choose a provider first.</p>}
        {test.error && <ErrorBanner error={test.error} />}
        {test.data && (
          <p role="status" className="text-emerald-700 dark:text-emerald-400">
            {test.data.model} replied “{test.data.reply || '(empty)'}” in {(test.data.ms / 1000).toFixed(1)} s.
          </p>
        )}
      </div>
    </Card>
  );
}
