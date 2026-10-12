import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, ErrorBanner, Field, Input, PageHeader, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useMe } from '../../lib/me';

interface EmailSettings {
  /** A key and a from address are saved, so Resend sends the app's email. */
  active: boolean;
  resend_key_last4: string | null;
  resend_key_set_at: string | null;
  from_name: string | null;
  from_email: string | null;
  encryption_available: boolean;
}

interface Period {
  used: number;
  limit: number | null;
  sent: number;
  received: number;
  resets_at: string | null;
}
interface Usage {
  emails: { daily: Period | null; monthly: Period | null };
  domains?: { used: number; limit: number | null };
  rate_limit?: { limit: number; duration: string };
}
interface Domain {
  id: string;
  name: string;
  status: string;
  region: string;
  created_at: string;
}

const TEST_SENDER = 'onboarding@resend.dev';
const DOMAIN_TONE: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  verified: 'green',
  pending: 'amber',
  partially_verified: 'amber',
  temporary_failure: 'amber',
  failed: 'red',
  partially_failed: 'red',
  not_started: 'slate',
};

/**
 * Admin › Email: send the app's email through Resend, set up in steps (account, API key, an
 * domain, the sender, a test), with Resend's usage and domains alongside.
 */
export function EmailPage() {
  const api = useApi();
  const settings = useQuery({ queryKey: ['email-settings'], queryFn: () => api.get<EmailSettings>('/admin/email') });
  const s = settings.data;
  const hasKey = Boolean(s?.resend_key_last4);
  const usage = useQuery({ queryKey: ['email-usage'], enabled: hasKey, queryFn: () => api.get<Usage>('/admin/email/usage'), retry: false });
  const domains = useQuery({
    queryKey: ['email-domains'],
    enabled: hasKey,
    queryFn: () => api.get<Domain[]>('/admin/email/domains'),
    retry: false,
    // While a domain waits for DNS verification, check again every 30 seconds.
    refetchInterval: (q) => (q.state.data?.length && !q.state.data.some((d) => d.status === 'verified') ? 30_000 : false),
  });
  const verified = domains.data?.filter((d) => d.status === 'verified') ?? [];
  const waiting = !verified.length ? domains.data?.[0] : undefined;

  return (
    <Page>
      <PageHeader
        title="Email"
        description="Send the app's email (invitations, invoices, ticket replies and sales call confirmations) through Resend. Sign-in and verification codes come from the sign-in provider."
      />
      {settings.isLoading ? (
        <Spinner />
      ) : settings.error || !s ? (
        <ErrorBanner error={settings.error} />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <ol className="grid gap-4">
            <Step n={1} title="Create a Resend account" done={hasKey}>
              <p>Resend delivers the email. The free plan covers 100 emails a day and 3,000 a month.</p>
              <a href="https://resend.com/signup" target="_blank" rel="noreferrer" className={linkButton}>
                Sign up at resend.com <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </Step>
            <Step n={2} title="Create an API key" done={hasKey}>
              <ApiKeyStep settings={s} />
            </Step>
            <Step n={3} title="Add your domain" done={verified.length > 0} pending={Boolean(waiting)}>
              <p>
                Resend sends to your customers only from a domain you own. Add your domain in Resend, add the DNS records it shows at your domain
                provider, then choose <strong>I've already added the records</strong> in Resend. Until then it can only send tests from{' '}
                <code className="text-xs">{TEST_SENDER}</code> to your own Resend address.
              </p>
              {waiting && (
                <p role="status" className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  <strong>{waiting.name}</strong> is added but not verified yet ({waiting.status.replaceAll('_', ' ')}). Add its DNS records and choose{' '}
                  <strong>I've already added the records</strong> in Resend; this step turns green once Resend verifies it (it can take a few minutes).
                </p>
              )}
              <a href="https://resend.com/domains" target="_blank" rel="noreferrer" className={linkButton}>
                {domains.data?.length ? 'Open domains in Resend' : 'Add a domain in Resend'} <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
              <DomainsBox enabled={hasKey} query={domains} />
            </Step>
            <Step n={4} title="Choose the sender" done={Boolean(s.from_email)}>
              <SenderStep settings={s} verified={verified} />
            </Step>
            <Step n={5} title="Send a test email" done={s.active}>
              <TestStep settings={s} />
            </Step>
          </ol>
          <UsageBox enabled={hasKey} query={usage} />
        </div>
      )}
    </Page>
  );
}

const linkButton =
  'press inline-flex w-fit items-center gap-1.5 rounded-full border border-slate-300 px-3.5 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-600 dark:hover:bg-slate-800';

function Step({ n, title, done, pending, children }: { n: number; title: string; done: boolean; pending?: boolean; children: ReactNode }) {
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${
            done
              ? 'bg-emerald-600 text-white'
              : pending
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                : 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-100'
          }`}
        >
          {done ? <Check className="size-4" /> : pending ? <Clock className="size-4" /> : n}
        </span>
        <div className="grid min-w-0 flex-1 gap-3 text-sm text-slate-600 dark:text-slate-300">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {n}. {title}
            {done ? <span className="sr-only"> (done)</span> : pending && <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-400">waiting for verification</span>}
          </h2>
          {children}
        </div>
      </div>
    </li>
  );
}

/** Puts saved settings in the cache and refreshes what depends on the key. */
function useSaveSettings() {
  const queryClient = useQueryClient();
  return (data: EmailSettings) => {
    queryClient.setQueryData(['email-settings'], data);
    void queryClient.invalidateQueries({ queryKey: ['email-usage'] });
    void queryClient.invalidateQueries({ queryKey: ['email-domains'] });
  };
}

function ApiKeyStep({ settings: s }: { settings: EmailSettings }) {
  const api = useApi();
  const saved = useSaveSettings();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const save = useMutation({
    mutationFn: () => api.put<EmailSettings>('/admin/email/api-key', { api_key: key.trim() }),
    onSuccess: (data) => {
      saved(data);
      setKey('');
      setReplacing(false);
    },
  });
  const remove = useMutation({ mutationFn: () => api.del('/admin/email/api-key').then(() => api.get<EmailSettings>('/admin/email')), onSuccess: (data) => saved(data) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <>
      <p>
        In Resend, open <strong>API Keys</strong> and choose <strong>Create API key</strong>. Pick <strong>Full access</strong> so this page can show
        your usage and domains (a sending-only key works for sending). Copy the key and paste it here; it is stored encrypted and never shown again.
      </p>
      <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" className={linkButton}>
        Open API keys in Resend <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
      {!s.encryption_available && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          SETTINGS_ENCRYPTION_KEY is not set on the server, so a key cannot be stored yet.
        </p>
      )}
      {s.resend_key_last4 && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">re_••••••••{s.resend_key_last4}</code>
          <span className="text-xs text-slate-500">saved {dateTime(s.resend_key_set_at)}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => window.confirm('Remove the API key? Resend is turned off and email goes out the default way.') && remove.mutate()}
          >
            Remove
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <Field label="API key">
              <Input type="password" autoComplete="off" spellCheck={false} placeholder="re_…" value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" disabled={!key.trim() || save.isPending || !s.encryption_available}>
            {save.isPending ? 'Checking…' : 'Save key'}
          </Button>
          {replacing && (
            <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
              Keep the current key
            </Button>
          )}
        </form>
      )}
      {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
    </>
  );
}

function SenderStep({ settings: s, verified }: { settings: EmailSettings; verified: Domain[] }) {
  const api = useApi();
  const saved = useSaveSettings();
  const [fromName, setFromName] = useState(s.from_name ?? '');
  const [fromEmail, setFromEmail] = useState(s.from_email ?? '');
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () => api.put<EmailSettings>('/admin/email', { from_name: fromName, from_email: fromEmail }),
    onSuccess: (data) => {
      saved(data);
      setDone(true);
    },
  });
  const domain = fromEmail.split('@')[1]?.toLowerCase();
  const offDomain = Boolean(domain) && fromEmail !== TEST_SENDER && verified.length > 0 && !verified.some((d) => d.name.toLowerCase() === domain);
  const changed = fromName !== (s.from_name ?? '') || fromEmail !== (s.from_email ?? '');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setDone(false);
        save.mutate();
      }}
      className="grid gap-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From address" hint={verified.length ? `On a verified domain, e.g. hello@${verified[0].name}` : `Until a domain is verified: ${TEST_SENDER}`}>
          <Input
            type="email"
            list="email-from-suggestions"
            placeholder="no-reply@example.com"
            maxLength={254}
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
          />
          <datalist id="email-from-suggestions">
            {verified.map((d) => (
              <option key={d.id} value={`hello@${d.name}`} />
            ))}
            <option value={TEST_SENDER} />
          </datalist>
        </Field>
        <Field label="From name" hint="e.g. your business name">
          <Input maxLength={80} value={fromName} onChange={(e) => setFromName(e.target.value)} />
        </Field>
      </div>
      {offDomain && <p className="text-amber-700 dark:text-amber-400">{domain} is not one of your verified domains; Resend will refuse to send from it.</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" disabled={!changed || save.isPending}>
          Save sender
        </Button>
        {done && !changed && (
          <span role="status" className="text-emerald-700 dark:text-emerald-400">
            Saved
          </span>
        )}
      </div>
      {save.error && <ErrorBanner error={save.error} />}
    </form>
  );
}

/** A test email with the saved key: from the saved address, or Resend's testing sender until one is saved. */
function TestStep({ settings: s }: { settings: EmailSettings }) {
  const api = useApi();
  const { me } = useMe();
  const [to, setTo] = useState(me?.profile.email ?? '');
  useEffect(() => setTo((t) => t || me?.profile.email || ''), [me]);
  const test = useMutation({ mutationFn: () => api.post<{ id: string; from: string }>('/admin/email/test', { to: to.trim() }) });
  const from = s.from_email ?? TEST_SENDER;

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          test.mutate();
        }}
        className="grid gap-1"
      >
        <label htmlFor="email-test-to" className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Send a test email to
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input id="email-test-to" type="email" required value={to} onChange={(e) => setTo(e.target.value)} className="min-w-64 flex-1" />
          <Button type="submit" variant="secondary" disabled={!s.resend_key_last4 || test.isPending}>
            {test.isPending ? 'Sending…' : 'Send test'}
          </Button>
        </div>
        <p className="text-xs text-slate-500">{from === TEST_SENDER ? `From ${TEST_SENDER}: only your Resend account's email address receives it.` : `From ${from}.`}</p>
      </form>
      <p className={s.active ? 'text-emerald-700 dark:text-emerald-400' : 'text-xs text-slate-500'}>
        {s.active
          ? 'Resend is on: invitations, invoices, ticket replies and sales call confirmations go through it.'
          : 'Save an API key and a from address first.'}
      </p>
      {test.error && <ErrorBanner error={test.error} />}
      {test.data && (
        <p role="status" className="text-emerald-700 dark:text-emerald-400">
          Test email sent to {to.trim()} from {test.data.from}.
        </p>
      )}
    </>
  );
}

function DomainsBox({ enabled, query }: { enabled: boolean; query: ReturnType<typeof useQuery<Domain[]>> }) {
  if (!enabled) return <p className="text-xs text-slate-500">Your domains show here once an API key is saved.</p>;
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="font-medium text-slate-900 dark:text-slate-100">Domains in Resend</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label="Refresh domains">
          <RefreshCw className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
        </Button>
      </div>
      <div className="p-3">
        {query.isLoading ? (
          <Spinner />
        ) : query.error ? (
          <ErrorBanner error={query.error} />
        ) : !query.data?.length ? (
          <p className="text-slate-500">No domains yet.</p>
        ) : (
          <ul className="grid gap-2">
            {query.data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-slate-900 dark:text-slate-100">{d.name}</span>
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  {d.region}
                  <Badge tone={DOMAIN_TONE[d.status] ?? 'slate'}>{d.status.replaceAll('_', ' ')}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function UsageBox({ enabled, query }: { enabled: boolean; query: ReturnType<typeof useQuery<Usage>> }) {
  const u = query.data;
  return (
    <Card
      title="Usage"
      className="lg:sticky lg:top-20"
      actions={
        enabled && (
          <Button type="button" size="sm" variant="ghost" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label="Refresh usage">
            <RefreshCw className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
          </Button>
        )
      }
    >
      {!enabled ? (
        <p className="text-sm text-slate-500">Emails sent today and this month, against your plan's limits, show here once an API key is saved.</p>
      ) : query.isLoading ? (
        <Spinner />
      ) : query.error ? (
        <ErrorBanner error={query.error} />
      ) : u ? (
        <div className="grid gap-4 text-sm">
          <Meter label="Today" period={u.emails.daily} />
          <Meter label="This month" period={u.emails.monthly} />
          {u.domains && (
            <p className="flex justify-between text-slate-600 dark:text-slate-300">
              <span>Domains</span>
              <span>
                {u.domains.used}
                {u.domains.limit != null && ` of ${u.domains.limit}`}
              </span>
            </p>
          )}
          {u.rate_limit && (
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Rate limit</p>
              <p className="mt-1 font-semibold text-slate-900 dark:text-slate-100">{rate(u.rate_limit)}</p>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function Meter({ label, period }: { label: string; period: Period | null }) {
  if (!period) return null;
  const pct = period.limit ? Math.min(100, Math.round((period.used / period.limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-slate-900 dark:text-slate-100">{label}</span>
        <span className="text-slate-600 dark:text-slate-300">
          {period.used.toLocaleString()}
          {period.limit != null ? ` of ${period.limit.toLocaleString()}` : ''}
        </span>
      </div>
      {period.limit != null && (
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
          role="progressbar"
          aria-label={`${label}: ${period.used} of ${period.limit} emails`}
          aria-valuemin={0}
          aria-valuemax={period.limit}
          aria-valuenow={period.used}
        >
          <div className={`h-full rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="mt-1 text-xs text-slate-500">
        {period.sent.toLocaleString()} sent · {period.received.toLocaleString()} received
        {period.resets_at && ` · resets ${dateTime(period.resets_at)}`}
      </p>
    </div>
  );
}

/** { limit: 1000, duration: '1000ms' } → "1,000 requests a second". */
function rate(r: { limit: number; duration: string }): string {
  const ms = /^(\d+)ms$/.exec(r.duration)?.[1];
  if (ms && Number(ms) === 1000) return `${r.limit.toLocaleString()} requests a second`;
  return `${r.limit.toLocaleString()} requests per ${r.duration}`;
}
