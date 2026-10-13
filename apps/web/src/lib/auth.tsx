import { createClient, type Session as SupabaseSession, type SupabaseClient } from '@supabase/supabase-js';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { appConfig, type PoolConfig } from './config';

export type Audience = 'customer' | 'employee';

export interface Session {
  audience: Audience;
  status: 'loading' | 'signed-out' | 'signed-in';
  /** Headers that authenticate API calls for this audience. */
  headers(): Record<string, string>;
  signIn(returnTo?: string): Promise<void>;
  /** Local development only: sign in as a sample principal (x-dev-principal). */
  signInAs?(principalId: string): void;
  /** Supabase: email a sign-in code, then sign in with it. */
  sendCode?(email: string): Promise<void>;
  verifyCode?(email: string, code: string): Promise<void>;
  /** `reason` (e.g. the API's answer to a refused login) is shown on the sign-in screen. */
  signOut(reason?: string): Promise<void>;
}

const REASON_KEY = 'joybot.auth.reason';

/** Why the last session ended (shown once on the sign-in screen). */
export function takeSignOutReason(): string | null {
  const reason = sessionStorage.getItem(REASON_KEY);
  sessionStorage.removeItem(REASON_KEY);
  return reason;
}

const DEV_KEY = (a: Audience) => `joybot.dev.${a}`;
const PENDING_KEY = 'joybot.auth.pending';

const managers = new Map<Audience, UserManager>();

/** One OIDC client per Cognito user pool (customers / employees), authorization code + PKCE. */
export function userManager(audience: Audience): UserManager {
  const existing = managers.get(audience);
  if (existing) return existing;
  const cfg = appConfig();
  const pool: PoolConfig | undefined = audience === 'customer' ? cfg.customers : cfg.employees;
  if (!pool || !cfg.region) throw new Error(`Sign-in is not configured for ${audience}s`);
  const mgr = new UserManager({
    authority: `https://cognito-idp.${cfg.region}.amazonaws.com/${pool.userPoolId}`,
    client_id: pool.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    response_type: 'code',
    scope: audience === 'customer' ? 'openid email phone profile' : 'openid email profile',
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({ store: window.sessionStorage, prefix: `joybot.${audience}.` }),
  });
  managers.set(audience, mgr);
  return mgr;
}

/** Completes the Cognito redirect (route /auth/callback). Returns where to go next. */
export async function completeSignIn(): Promise<string> {
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? '{}') as { audience?: Audience; returnTo?: string };
  sessionStorage.removeItem(PENDING_KEY);
  if (!pending.audience) throw new Error('No sign-in in progress');
  await userManager(pending.audience).signinRedirectCallback();
  return pending.returnTo ?? (pending.audience === 'customer' ? '/portal' : '/staff');
}

const SessionContext = createContext<Session | undefined>(undefined);

export function SessionProvider({ audience, children }: { audience: Audience; children: ReactNode }) {
  return appConfig().authMode === 'supabase' ? (
    <SupabaseSessionProvider audience={audience}>{children}</SupabaseSessionProvider>
  ) : (
    <OidcSessionProvider audience={audience}>{children}</OidcSessionProvider>
  );
}

const clients = new Map<Audience, SupabaseClient>();

/** One Supabase client per area, each with its own stored session (staff and portal sign in separately). */
function supabaseClient(audience: Audience): SupabaseClient {
  const existing = clients.get(audience);
  if (existing) return existing;
  const cfg = appConfig().supabase;
  if (!cfg) throw new Error('Sign-in is not configured');
  const client = createClient(cfg.url, cfg.anonKey, {
    auth: {
      storageKey: `joybot.${audience}.auth`,
      persistSession: true,
      autoRefreshToken: true,
      // Invite and magic links land with the session in the URL.
      detectSessionInUrl: true,
      flowType: 'implicit',
    },
  });
  clients.set(audience, client);
  return client;
}

/**
 * Supabase Auth (AUTH_MODE=supabase on the API): sign in with a code sent by email. One user pool for
 * both areas, so every API call says which one it is for (x-joybot-audience); the API links the login
 * to the employee or customer the first time.
 */
function SupabaseSessionProvider({ audience, children }: { audience: Audience; children: ReactNode }) {
  const [current, setCurrent] = useState<SupabaseSession | null | undefined>(undefined);

  useEffect(() => {
    const client = supabaseClient(audience);
    let active = true;
    void client.auth.getSession().then(({ data }) => active && setCurrent(data.session));
    const { data } = client.auth.onAuthStateChange((_event, session) => setCurrent(session));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [audience]);

  const session = useMemo<Session>(
    () => ({
      audience,
      status: current === undefined ? 'loading' : current ? 'signed-in' : 'signed-out',
      headers: (): Record<string, string> => (current ? { authorization: `Bearer ${current.access_token}`, 'x-joybot-audience': audience } : {}),
      // The sign-in screen collects the email and code itself.
      signIn: async () => {},
      sendCode: async (email: string) => {
        const { error } = await supabaseClient(audience).auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
        if (error) throw error;
      },
      verifyCode: async (email: string, code: string) => {
        const { error } = await supabaseClient(audience).auth.verifyOtp({ email, token: code, type: 'email' });
        if (error) throw error;
      },
      signOut: async (reason?: string) => {
        if (reason) sessionStorage.setItem(REASON_KEY, reason);
        await supabaseClient(audience).auth.signOut({ scope: 'local' });
      },
    }),
    [audience, current],
  );

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function OidcSessionProvider({ audience, children }: { audience: Audience; children: ReactNode }) {
  const dev = appConfig().authMode === 'dev';
  const [user, setUser] = useState<User | null | undefined>(dev ? null : undefined);
  const [devPrincipal, setDevPrincipal] = useState<string | null>(() => (dev ? localStorage.getItem(DEV_KEY(audience)) : null));

  useEffect(() => {
    if (dev) return;
    const mgr = userManager(audience);
    let active = true;
    void mgr.getUser().then((u) => active && setUser(u && !u.expired ? u : null));
    const loaded = (u: User) => setUser(u);
    const unloaded = () => setUser(null);
    mgr.events.addUserLoaded(loaded);
    mgr.events.addUserUnloaded(unloaded);
    mgr.events.addSilentRenewError(unloaded);
    return () => {
      active = false;
      mgr.events.removeUserLoaded(loaded);
      mgr.events.removeUserUnloaded(unloaded);
      mgr.events.removeSilentRenewError(unloaded);
    };
  }, [audience, dev]);

  const signIn = useCallback(
    async (returnTo?: string) => {
      if (dev) return;
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ audience, returnTo: returnTo ?? window.location.pathname }));
      await userManager(audience).signinRedirect();
    },
    [audience, dev],
  );

  const signOut = useCallback(async (reason?: string) => {
    if (reason) sessionStorage.setItem(REASON_KEY, reason);
    if (dev) {
      localStorage.removeItem(DEV_KEY(audience));
      setDevPrincipal(null);
      return;
    }
    const cfg = appConfig();
    const pool = audience === 'customer' ? cfg.customers! : cfg.employees!;
    await userManager(audience).removeUser();
    // Cognito's hosted logout (not advertised in OIDC discovery).
    const params = new URLSearchParams({ client_id: pool.clientId, logout_uri: `${window.location.origin}/` });
    window.location.assign(`${pool.loginDomain}/logout?${params}`);
  }, [audience, dev]);

  const session = useMemo<Session>(() => {
    const signedIn = dev ? Boolean(devPrincipal) : Boolean(user);
    return {
      audience,
      status: !dev && user === undefined ? 'loading' : signedIn ? 'signed-in' : 'signed-out',
      headers: (): Record<string, string> =>
        dev
          ? devPrincipal
            ? { 'x-dev-principal': `${audience}:${devPrincipal}` }
            : {}
          : user
            ? { authorization: `Bearer ${user.access_token}` }
            : {},
      signIn,
      signInAs: dev
        ? (id: string) => {
            localStorage.setItem(DEV_KEY(audience), id);
            setDevPrincipal(id);
          }
        : undefined,
      signOut,
    };
  }, [audience, dev, devPrincipal, signIn, signOut, user]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
