import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { RequireSession } from '../../components/SignIn';
import { Badge, Button, Card, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { appConfig } from '../../lib/config';
import { useMe } from '../../lib/me';

interface Location {
  id: string;
  name: string;
}

const TIME_ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC'];

/** Customer profile: name, time zone, preferred location, WhatsApp consent; contacts via codes. */
export function Profile() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api.get<Location[]>('/locations') });
  const p = (me?.profile ?? {}) as Record<string, any>;
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const v = { ...p, ...draft };
  const save = useMutation({
    mutationFn: () => api.put('/me', draft),
    onSuccess: () => {
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  if (!me) return <Page><Spinner /></Page>;
  return (
    <Page>
      <PageHeader title="Profile" description={p.profile_completed_at ? undefined : 'Please complete your name and add a verified contact.'} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Your details">
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name"><Input value={v.first_name ?? ''} onChange={(e) => setDraft({ ...draft, first_name: e.target.value })} /></Field>
              <Field label="Last name"><Input value={v.last_name ?? ''} onChange={(e) => setDraft({ ...draft, last_name: e.target.value })} /></Field>
            </div>
            <Field label="Time zone" hint="Used for “today”, “tomorrow” and reminders.">
              <Select value={v.time_zone ?? ''} onChange={(e) => setDraft({ ...draft, time_zone: e.target.value || null })}>
                <option value="">Use the business default</option>
                {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz.replaceAll('_', ' ')}</option>)}
              </Select>
            </Field>
            <Field label="Preferred location">
              <Select value={v.preferred_location_id ?? ''} onChange={(e) => setDraft({ ...draft, preferred_location_id: e.target.value || null })}>
                <option value="">No preference</option>
                {locations.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={draft.whatsapp_opt_in !== undefined ? Boolean(draft.whatsapp_opt_in) : Boolean(p.whatsapp_opt_in_at)}
                onChange={(e) => setDraft({ ...draft, whatsapp_opt_in: e.target.checked })}
              />
              <span>Send me appointment and account messages on WhatsApp. <span className="text-slate-500">Sign-in codes are always sent when you ask for them.</span></span>
            </label>
            {save.error && <ErrorBanner error={save.error} />}
            {save.isSuccess && <p role="status" className="text-sm text-emerald-700">Saved.</p>}
            <div><Button type="submit" disabled={Object.keys(draft).length === 0 || save.isPending}>Save</Button></div>
          </form>
        </Card>
        <Card title="Sign-in contacts">
          <p className="mb-3 text-sm text-slate-500">You can sign in with any verified contact.</p>
          <div className="space-y-4">
            <ContactRow type="email" label="Email" value={p.email} verified={p.email_verified} />
            <ContactRow type="phone" label="Phone (WhatsApp)" value={p.phone} verified={p.phone_verified} />
          </div>
        </Card>
      </div>
    </Page>
  );
}

function ContactRow({ type, label, value, verified }: { type: "email" | "phone"; label: string; value: string | null; verified: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ id: string; sentTo: string } | null>(null);
  const [code, setCode] = useState('');
  const request = useMutation({
    mutationFn: () => api.post<{ verification_id: string; sent_to: string }>('/me/contacts', { type, value: input.trim() }),
    onSuccess: (r) => setPending({ id: r.verification_id, sentTo: r.sent_to }),
  });
  const verify = useMutation({
    mutationFn: () => api.post('/me/contacts/verify', { verification_id: pending!.id, code }),
    onSuccess: () => {
      setEditing(false);
      setPending(null);
      setInput('');
      setCode('');
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs text-slate-500">{label}</p>
          <p className="text-sm">{value ?? 'Not added'} {value && (verified ? <Badge tone="green">verified</Badge> : <Badge tone="amber">not verified</Badge>)}</p>
        </div>
        {!editing && <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{value ? 'Change' : 'Add'}</Button>}
      </div>
      {editing && !pending && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            request.mutate();
          }}
        >
          <Input
            aria-label={`New ${label}`}
            type={type === 'email' ? 'email' : 'tel'}
            placeholder={type === 'email' ? 'you@example.com' : '+12125550101'}
            required
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={request.isPending}>Send code</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
      {pending && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            verify.mutate();
          }}
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            We sent a 6-digit code to {pending.sentTo}{type === 'phone' ? ' on WhatsApp' : ''}.
          </p>
          <div className="flex gap-2">
            <Input aria-label="Verification code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <Button type="submit" size="sm" disabled={code.length !== 6 || verify.isPending}>Verify</Button>
          </div>
        </form>
      )}
      {(request.error || verify.error) && <div className="mt-2"><ErrorBanner error={request.error ?? verify.error} /></div>}
    </div>
  );
}

interface InvitePreview {
  business_name: string | null;
  organization: string | null;
  channel: 'email' | 'whatsapp';
  sent_to: string;
  expires_at: string;
}

/** Invite link landing page: who it is for, then sign in / sign up, then accept. */
export function InviteLanding() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: async () => {
      const res = await fetch(`${appConfig().apiBase}/invites/${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error('This invite is no longer valid. Ask for a new one, or sign up directly.');
      return (await res.json()) as InvitePreview;
    },
    retry: false,
  });
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      {preview.isLoading && <Spinner />}
      {preview.error && <ErrorBanner error={preview.error} />}
      {preview.data && (
        <>
          <h1 className="text-xl font-semibold">You're invited to {preview.data.business_name ?? 'JoyBot'}</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {preview.data.organization ? `You'll join ${preview.data.organization}. ` : ''}
            Sign up with the {preview.data.channel === 'email' ? 'email' : 'phone number'} this invite was sent to ({preview.data.sent_to}) and your account is linked automatically.
          </p>
          <div className="mt-6">
            <RequireSession>
              <AcceptInvite token={token} />
            </RequireSession>
          </div>
        </>
      )}
    </main>
  );
}

function AcceptInvite({ token }: { token: string }) {
  const api = useApi();
  const accept = useMutation({ mutationFn: () => api.post<{ status: 'linked' | 'review' }>('/me/invites/accept', { token }) });
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      accept.mutate();
    }
  }, [accept]);
  if (accept.isPending || accept.isIdle) return <Spinner label="Linking your account" />;
  if (accept.error) return <ErrorBanner error={accept.error} />;
  return (
    <Card>
      <p className="text-sm">
        {accept.data!.status === 'linked'
          ? 'Your account is ready.'
          : 'Thanks! You signed up with a different email or phone, so our team will connect your account shortly.'}
      </p>
      <Link to="/portal" className="mt-3 inline-block text-sm text-brand-600 underline">Go to the portal</Link>
    </Card>
  );
}
