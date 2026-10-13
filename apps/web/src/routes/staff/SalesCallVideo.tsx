import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Video } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, ErrorBanner, Field, Input, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';

interface VideoSettings {
  google_project_id: string | null;
  google_client_id: string | null;
  google_secret_set_at: string | null;
  google_account_email: string | null;
  google_connected_at: string | null;
  google_calendar_id: string | null;
  checklist: ('project' | 'api' | 'consent' | 'test')[];
  redirect_uri: string;
  encryption_available: boolean;
}

const GUIDE = 'https://developers.google.com/workspace/calendar/api/quickstart/js';
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

/** A Google Cloud console page, in the project when one is set. */
const consoleUrl = (path: string, project: string | null) => `https://console.cloud.google.com${path}${project ? `${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}` : ''}`;

/**
 * Sales calls › Setup meeting links: Google Meet links for sales calls, set up step by step (a Google
 * Cloud project, the Calendar API, the consent screen, an OAuth client, connecting an account).
 */
export function VideoCallsTab({ editable }: { editable: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const settings = useQuery({ queryKey: ['video-settings'], queryFn: () => api.get<VideoSettings>('/website/video') });
  const s = settings.data;
  const saved = (data: VideoSettings) => queryClient.setQueryData(['video-settings'], data);
  const update = useMutation({ mutationFn: (body: Partial<VideoSettings>) => api.put<VideoSettings>('/website/video', body), onSuccess: saved });

  // Back from Google's consent screen: say how it went, then tidy the address.
  const [returned] = useState(() => ({ connected: params.get('google') === 'connected', account: params.get('account'), error: params.get('google_error') }));
  useEffect(() => {
    if (params.has('google') || params.has('google_error')) setParams({ tab: 'video' }, { replace: true });
  }, [params, setParams]);

  if (settings.isLoading) return <Spinner />;
  if (settings.error || !s) return <ErrorBanner error={settings.error} />;
  const project = s.google_project_id;
  const tickAll = (keys: VideoSettings['checklist'], on: boolean) =>
    update.mutate({ checklist: on ? [...new Set([...s.checklist, ...keys])] : s.checklist.filter((k) => !keys.includes(k)) });
  const tick = (key: VideoSettings['checklist'][number], on: boolean) => tickAll([key], on);
  const clientReady = Boolean(s.google_client_id && s.google_secret_set_at);

  return (
    <Card title="Setup meeting links">
      <div className="grid gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-300">
            <strong className="text-slate-900 dark:text-slate-100">Google Meet:</strong> each booked sales call gets its own Meet link, created in a
            Google account you connect and sent in the confirmation email. Follow the steps once; Google's guide covers the console in more detail.
          </p>
          <a href={GUIDE} target="_blank" rel="noreferrer" className={linkButton}>
            Google's guide <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </div>
        {returned.connected && (
          <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            Connected{returned.account ? ` ${returned.account}` : ''}. New sales calls now get a Meet link; try a test meeting below.
          </p>
        )}
        {returned.error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            Connecting Google did not work: {returned.error}
          </p>
        )}
        {!s.encryption_available && (
          <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            SETTINGS_ENCRYPTION_KEY is not set on the server, so the client secret cannot be stored yet.
          </p>
        )}

        <ProjectField settings={s} editable={editable} onSaved={saved} />

        <ol className="grid gap-3">
          <Step
            n={1}
            title="Create or choose a Google Cloud project and enable the Calendar API"
            done={s.checklist.includes('project') && s.checklist.includes('api')}
            onTick={editable ? (on) => tickAll(['project', 'api'], on) : undefined}
          >
            <ConsoleLink href={consoleUrl('/apis/library/calendar-json.googleapis.com', project)}>
              Open the Google Calendar API, pick or create a project at the top of the page (a Firebase project works too), and choose Enable.
            </ConsoleLink>
          </Step>
          <Step n={2} title="Set up the OAuth consent screen" done={s.checklist.includes('consent')} onTick={editable ? (on) => tick('consent', on) : undefined}>
            <p>
              Give it an app name and support email, and under <strong>Data access</strong> add only the scope <code className="text-xs">{SCOPE}</code>{' '}
              (non-sensitive, so Google doesn't need to verify the app). Then under <strong>Audience</strong>, choose <strong>Publish app</strong>: while it
              is in Testing, only listed test users can connect.
            </p>
            <ConsoleLink href={consoleUrl('/apis/credentials/consent', project)}>Open the consent screen</ConsoleLink>
          </Step>
          <Step n={3} title="Create an OAuth client ID" done={clientReady}>
            <p>
              Choose <strong>Create credentials › OAuth client ID</strong>, application type <strong>Web application</strong>, and add this{' '}
              <strong>Authorized redirect URI</strong>:
            </p>
            <CopyBox value={s.redirect_uri} />
            <ConsoleLink href={consoleUrl('/apis/credentials/oauthclient', project)}>Create the OAuth client</ConsoleLink>
            <ClientForm settings={s} editable={editable} onSaved={saved} />
          </Step>
          <Step n={4} title="Connect your Google account" done={Boolean(s.google_connected_at)}>
            <ConnectStep settings={s} editable={editable} clientReady={clientReady} onSaved={saved} />
          </Step>
          <Step n={5} title="Create a test meeting" done={Boolean(s.google_connected_at) && s.checklist.includes('test')}>
            <TestStep settings={s} editable={editable} />
          </Step>
        </ol>
        {update.error && <ErrorBanner error={update.error} />}
      </div>
    </Card>
  );
}

const linkButton =
  'press inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-slate-300 px-3.5 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-600 dark:hover:bg-slate-800';

function ConsoleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-600">
      {children} <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  );
}

/** A setup step; manual steps have a checkbox, the others turn green by themselves. */
function Step({ n, title, done, onTick, children }: { n: number; title: string; done: boolean; onTick?: (on: boolean) => void; children: ReactNode }) {
  return (
    <li className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${done ? 'bg-emerald-600 text-white' : 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-100'}`}
        >
          {done ? <Check className="size-4" /> : n}
        </span>
        <div className="grid min-w-0 flex-1 gap-2 text-sm text-slate-600 dark:text-slate-300">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {title}
              {done && <span className="sr-only"> (done)</span>}
            </h3>
            {onTick && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={done} onChange={(e) => onTick(e.target.checked)} />
                Done
              </label>
            )}
          </div>
          {children}
        </div>
      </div>
    </li>
  );
}

function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-slate-100 px-2 py-1.5 text-xs dark:bg-slate-800">{value}</code>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => void navigator.clipboard.writeText(value).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
        aria-label="Copy the redirect URI"
      >
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function ProjectField({ settings: s, editable, onSaved }: { settings: VideoSettings; editable: boolean; onSaved: (d: VideoSettings) => void }) {
  const api = useApi();
  const [project, setProject] = useState(s.google_project_id ?? '');
  const save = useMutation({ mutationFn: () => api.put<VideoSettings>('/website/video', { google_project_id: project }), onSuccess: onSaved });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <div className="w-72 max-w-full">
        <Field label="Google Cloud project ID (optional)" hint="Opens the console links below in this project.">
          <Input placeholder="my-project-123" value={project} disabled={!editable} onChange={(e) => setProject(e.target.value)} />
        </Field>
      </div>
      {editable && (
        <Button type="submit" variant="secondary" size="sm" className="mb-6" disabled={project === (s.google_project_id ?? '') || save.isPending}>
          Save
        </Button>
      )}
      {save.error && <ErrorBanner error={save.error} />}
    </form>
  );
}

function ClientForm({ settings: s, editable, onSaved }: { settings: VideoSettings; editable: boolean; onSaved: (d: VideoSettings) => void }) {
  const api = useApi();
  const [clientId, setClientId] = useState(s.google_client_id ?? '');
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      let data: VideoSettings | undefined;
      if (clientId.trim() !== (s.google_client_id ?? '')) data = await api.put<VideoSettings>('/website/video', { google_client_id: clientId.trim() });
      if (secret.trim()) data = await api.put<VideoSettings>('/website/video/google/secret', { client_secret: secret.trim() });
      return data ?? s;
    },
    onSuccess: (data) => {
      setSecret('');
      onSaved(data);
    },
  });
  if (!editable) return s.google_client_id ? <p className="text-xs text-slate-500">Client ID: {s.google_client_id}</p> : null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
    >
      <Field label="Client ID">
        <Input placeholder="…apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </Field>
      <Field label={s.google_secret_set_at ? `Client secret (saved ${dateTime(s.google_secret_set_at)})` : 'Client secret'}>
        <Input type="password" autoComplete="off" placeholder={s.google_secret_set_at ? '•••••••• (enter a new one to replace it)' : 'GOCSPX-…'} value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <Button type="submit" disabled={save.isPending || (!secret.trim() && clientId.trim() === (s.google_client_id ?? '')) || !s.encryption_available}>
        Save client
      </Button>
      {save.error && (
        <div className="sm:col-span-3">
          <ErrorBanner error={save.error} />
        </div>
      )}
    </form>
  );
}

function ConnectStep({ settings: s, editable, clientReady, onSaved }: { settings: VideoSettings; editable: boolean; clientReady: boolean; onSaved: (d: VideoSettings) => void }) {
  const api = useApi();
  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>('/website/video/google/connect'),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const disconnect = useMutation({ mutationFn: () => api.del('/website/video/google/connection').then(() => api.get<VideoSettings>('/website/video')), onSuccess: onSaved });
  return (
    <>
      <p>
        Sign in with the Google account that should hold the meetings. JoyBot makes its own calendar there (named after your site, e.g. “Acme sales calls”) and
        can see and change only that calendar, never the account's other calendars. Once connected, every new sales call gets its own Meet link (sent in the
        confirmation; rescheduling moves the meeting, cancelling removes it), until you disconnect. Share the calendar with your hosts so they see their calls.
      </p>
      {s.google_connected_at ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-900 dark:text-slate-100">{s.google_account_email ?? 'Connected'}</span>
          <span className="text-xs text-slate-500">since {dateTime(s.google_connected_at)}</span>
          {s.google_calendar_id && (
            <a
              href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(s.google_calendar_id)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-600"
            >
              Open the calendar <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          )}
          {editable && (
            <Button type="button" size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => window.confirm('Disconnect the Google account? New sales calls will not get Meet links.') && disconnect.mutate()}>
              Disconnect
            </Button>
          )}
          {editable && (
            <Button type="button" size="sm" variant="ghost" disabled={connect.isPending} onClick={() => connect.mutate()}>
              Use another account
            </Button>
          )}
        </div>
      ) : (
        editable && (
          <div>
            <Button type="button" disabled={!clientReady || connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? 'Opening Google…' : 'Connect Google account'}
            </Button>
            {!clientReady && <p className="mt-1 text-xs text-slate-500">Save the client ID and secret first.</p>}
          </div>
        )
      )}
      {(connect.error || disconnect.error) && <ErrorBanner error={connect.error ?? disconnect.error} />}
    </>
  );
}

/** Makes a meeting in JoyBot's calendar and removes it again; the step turns green once one worked. */
function TestStep({ settings: s, editable }: { settings: VideoSettings; editable: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const test = useMutation({
    mutationFn: () => api.post<{ meet_url: string }>('/website/video/google/test'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['video-settings'] }),
  });
  return (
    <>
      <p>Makes a meeting with a Meet link in JoyBot's calendar and removes it right away, to check everything works.</p>
      {!s.google_connected_at && <p className="text-xs text-slate-500">Connect a Google account first.</p>}
      {editable && s.google_connected_at && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
            <Video className="size-4" aria-hidden="true" />
            {test.isPending ? 'Creating…' : 'Create a test meeting'}
          </Button>
          {test.data && (
            <span role="status" className="text-emerald-700 dark:text-emerald-400">
              It works: {test.data.meet_url} (the test event was removed again)
            </span>
          )}
        </div>
      )}
      {test.error && <ErrorBanner error={test.error} />}
    </>
  );
}
