import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Page } from '../components/Layout';
import { Badge, Button, Card, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../components/ui';
import { useApi } from '../lib/api';
import { preferredTimeZone, time, TIME_ZONES } from '../lib/format';
import { useMe, type Me } from '../lib/me';
import { useTheme, type ThemePreference } from '../lib/theme';

/** Saves account fields: employees through PUT /me/employee, customers through PUT /me. */
function useSaveAccount() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  return useMutation({
    mutationFn: (fields: Record<string, unknown>) => api.put<Me>(me?.type === 'employee' ? '/me/employee' : '/me', fields),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
}

/** Staff "Profile & preferences": your name (email and role are admin-managed; email is the sign-in), time zone and theme. */
export function StaffProfile() {
  const { me } = useMe();
  const save = useSaveAccount();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  useEffect(() => {
    if (!me) return;
    setFirst(me.profile.first_name ?? '');
    setLast(me.profile.last_name ?? '');
  }, [me]);
  if (!me) return <Page><Spinner /></Page>;
  const p = me.profile as Me['profile'] & { employee_number?: string };
  const changed = first !== (p.first_name ?? '') || last !== (p.last_name ?? '');
  return (
    <Page>
      <PageHeader title="Profile & preferences" />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card title="Your details">
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ first_name: first, last_name: last });
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name">
                <Input required value={first} onChange={(e) => setFirst(e.target.value)} />
              </Field>
              <Field label="Last name">
                <Input required value={last} onChange={(e) => setLast(e.target.value)} />
              </Field>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">Email</dt>
                <dd className="truncate">{p.email}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Employee number</dt>
                <dd>{p.employee_number}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Role</dt>
                <dd><Badge tone="brand">{me.role}</Badge></dd>
              </div>
            </dl>
            <p className="text-xs text-slate-500">Your email is how you sign in; ask an admin to change it or your role.</p>
            {save.error && <ErrorBanner error={save.error} />}
            {save.isSuccess && !changed && <p role="status" className="text-sm text-emerald-700">Saved.</p>}
            <div>
              <Button type="submit" disabled={!changed || save.isPending}>Save</Button>
            </div>
          </form>
        </Card>
        <PreferenceCards />
      </div>
    </Page>
  );
}

const THEMES: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Match this device' },
  { value: 'light', label: 'Light', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' },
];

/** Time zone (saved to the account) and theme (this browser): cards for the profile pages' grid. */
export function PreferenceCards() {
  const { me } = useMe();
  const save = useSaveAccount();
  const { preference, setTheme } = useTheme();
  const saved = (me?.profile.time_zone as string | null | undefined) ?? null;
  const [zone, setZone] = useState<string>('');
  useEffect(() => setZone(saved ?? ''), [saved]);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!me) return <Spinner />;
  const effective = preferredTimeZone(zone || null);

  return (
    <>
      <Card title="Time zone">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ time_zone: zone || null });
          }}
        >
          <Field
            label="Your time zone"
            hint={
              me.type === 'employee'
                ? 'Used for “today” on your home page and by the assistant. Appointment times still show in each location’s zone.'
                : 'Used for “today”, “tomorrow” and reminders.'
            }
          >
            <Select value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">{me.type === 'employee' ? 'Not set: use my location or the business default' : 'Not set: use the business default'}</option>
              {TIME_ZONES.map((tz) => (
                <option key={tz} value={tz}>{tz.replaceAll('_', ' ')}</option>
              ))}
            </Select>
          </Field>
          <p className="text-sm text-slate-500">
            {zone ? <>It's {time(new Date().toISOString(), effective)} there now.</> : <>This browser is on {browserZone.replaceAll('_', ' ')}.</>}
            {zone !== browserZone && (
              <button type="button" className="ml-2 text-brand-600 hover:underline" onClick={() => setZone(browserZone)}>
                Use this browser's
              </button>
            )}
          </p>
          {save.error && <ErrorBanner error={save.error} />}
          {save.isSuccess && zone === (saved ?? '') && <p role="status" className="text-sm text-emerald-700">Saved.</p>}
          <div>
            <Button type="submit" disabled={zone === (saved ?? '') || save.isPending}>Save time zone</Button>
          </div>
        </form>
      </Card>

      <Card title="Appearance">
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm text-slate-500">Theme for this browser. The sun/moon button in the header switches it too.</legend>
          {THEMES.map((t) => (
            <label key={t.value} className="flex items-center gap-2 text-sm">
              <input type="radio" name="theme" value={t.value} checked={preference === t.value} onChange={() => setTheme(t.value)} />
              {t.label}
              {t.hint && <span className="text-slate-500">· {t.hint}</span>}
            </label>
          ))}
        </fieldset>
      </Card>
    </>
  );
}
