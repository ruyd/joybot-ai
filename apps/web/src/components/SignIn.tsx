import { useState, type ReactNode } from 'react';
import { useSession } from '../lib/auth';
import { appConfig } from '../lib/config';
import { Button, Card, Field, Input, Spinner } from './ui';

/** Sample principals from packages/db/src/seed.ts (local development only). */
const SAMPLES = {
  employee: [
    { id: '20000000-0000-4000-8000-000000000001', label: 'Ada — admin' },
    { id: '20000000-0000-4000-8000-000000000002', label: 'Sam — staff, New York' },
    { id: '20000000-0000-4000-8000-000000000003', label: 'Lia — staff, Los Angeles' },
  ],
  customer: [
    { id: '40000000-0000-4000-8000-000000000001', label: 'Maria — customer' },
    { id: '40000000-0000-4000-8000-000000000002', label: 'John — Acme organization admin' },
    { id: '40000000-0000-4000-8000-000000000003', label: 'Jane — Acme member' },
    { id: '40000000-0000-4000-8000-000000000006', label: 'Pat — phone-only customer' },
  ],
};

/** Shows the sign-in screen until the session for this audience is signed in. */
export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.status === 'loading') return <div className="p-6"><Spinner /></div>;
  if (session.status === 'signed-in') return <>{children}</>;
  return <SignIn />;
}

function SignIn() {
  const session = useSession();
  const dev = appConfig().authMode === 'dev';
  const [custom, setCustom] = useState('');
  const who = session.audience === 'customer' ? 'Customer portal' : 'Staff console';

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <div className="mb-6 flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="size-8" />
        <h1 className="text-xl font-semibold">JoyBot · {who}</h1>
      </div>
      {!dev ? (
        <Card>
          <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
            {session.audience === 'customer'
              ? 'Sign in with your email, or with your phone — we send the code over WhatsApp.'
              : 'Sign in with your work account.'}
          </p>
          <Button className="w-full" onClick={() => void session.signIn()}>
            Sign in
          </Button>
        </Card>
      ) : (
        <Card title="Local development sign-in">
          <p className="mb-3 text-sm text-slate-500">The local API trusts this choice (AUTH_MODE=dev). Not available in AWS.</p>
          <div className="space-y-2">
            {SAMPLES[session.audience].map((s) => (
              <Button key={s.id} variant="secondary" className="w-full justify-start" onClick={() => session.signInAs?.(s.id)}>
                {s.label}
              </Button>
            ))}
          </div>
          <form
            className="mt-4 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.trim()) session.signInAs?.(custom.trim());
            }}
          >
            <div className="flex-1">
              <Field label="Or another ID">
                <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="UUID" />
              </Field>
            </div>
            <Button type="submit" variant="secondary">
              Go
            </Button>
          </form>
        </Card>
      )}
    </main>
  );
}
