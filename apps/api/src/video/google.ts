import { BadGatewayException, BadRequestException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

/** HTTP for Google's APIs; tests override it. */
export type GoogleHttp = (url: string, init: RequestInit) => Promise<Response>;
export const GOOGLE_HTTP = Symbol('GOOGLE_HTTP');

/**
 * The signed-in account's email, and calendar.app.created (non-sensitive): JoyBot may make its own
 * calendars and manage events on them, and cannot see the account's other calendars.
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const GOOGLE_SCOPES = ['openid', 'email', CALENDAR_SCOPE];

export interface GoogleClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface MeetingEvent {
  summary: string;
  description: string;
  start: Date;
  end: Date;
}

/** Google said no, with what the admin page should say. */
export class GoogleError extends HttpException {}

/** Google OAuth (connecting an account) and Calendar events with Google Meet links. */
@Injectable()
export class GoogleClient {
  private readonly logger = new Logger('Google');
  private tokens = new Map<string, { token: string; until: number }>();

  constructor(@Inject(GOOGLE_HTTP) private readonly http: GoogleHttp) {}

  /** Google's consent screen: offline access (a refresh token), always asking, so one comes back. */
  consentUrl(clientId: string, redirectUri: string, state: string): string {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  /** The code from Google's redirect → a refresh token and the account's email (the calendar permission is required). */
  async exchangeCode(c: GoogleClientCredentials, code: string, redirectUri: string): Promise<{ refreshToken: string; email: string | null }> {
    const res = await this.token(c, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (!res.refresh_token) throw new BadRequestException('Google did not grant offline access. Try connecting again.');
    if (res.scope && !res.scope.split(' ').includes(CALENDAR_SCOPE)) {
      throw new BadRequestException('JoyBot needs permission to make and manage its own calendar. Connect again and leave that box ticked.');
    }
    this.remember(c, res.refresh_token, res);
    return { refreshToken: res.refresh_token, email: emailFromIdToken(res.id_token) };
  }

  /** JoyBot's calendar in the account: `existing` when it is still there, else a new one. */
  async ensureCalendar(c: GoogleClientCredentials, refreshToken: string, existing: string | null, cal: { summary: string; timeZone: string | null }): Promise<string> {
    if (existing) {
      const found = await this.calendar<{ id?: string }>(c, refreshToken, 'GET', `/calendars/${encodeURIComponent(existing)}`, undefined, [404, 410]);
      if (found.id) return found.id;
    }
    const made = await this.calendar<{ id: string }>(c, refreshToken, 'POST', '/calendars', {
      summary: cal.summary,
      description: 'Sales calls booked on the website, with their Google Meet links. Made and kept up to date by JoyBot.',
      ...(cal.timeZone ? { timeZone: cal.timeZone } : {}),
    });
    return made.id;
  }

  /** Creates an event with a Meet link in JoyBot's calendar (no emails from Google). */
  async createMeeting(c: GoogleClientCredentials, refreshToken: string, calendarId: string, e: MeetingEvent, requestId: string): Promise<{ eventId: string; meetUrl: string }> {
    const event = await this.calendar<{ id: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] } }>(
      c,
      refreshToken,
      'POST',
      `/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=none`,
      {
        summary: e.summary,
        description: e.description,
        start: { dateTime: e.start.toISOString() },
        end: { dateTime: e.end.toISOString() },
        conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      },
    );
    const meetUrl = event.hangoutLink ?? event.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
    if (!meetUrl) throw new BadGatewayException('Google created the event without a Meet link (is Google Meet available to this account?)');
    return { eventId: event.id, meetUrl };
  }

  moveMeeting(c: GoogleClientCredentials, refreshToken: string, calendarId: string, eventId: string, start: Date, end: Date) {
    return this.calendar(c, refreshToken, 'PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    });
  }

  async deleteMeeting(c: GoogleClientCredentials, refreshToken: string, calendarId: string, eventId: string) {
    await this.calendar(c, refreshToken, 'DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, undefined, [404, 410]);
  }

  // ---------------------------------------------------------------------------------------------

  private async token(c: GoogleClientCredentials, params: Record<string, string>) {
    const res = await this.send('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new GoogleError({ statusCode: 400, code: data.error ?? 'google_error', message: explain(data.error, data.error_description) }, 400);
    return data as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string };
  }

  private tokenKey(c: GoogleClientCredentials, refreshToken: string) {
    return createHash('sha256').update(`${c.clientId}:${refreshToken}`).digest('hex');
  }

  private remember(c: GoogleClientCredentials, refreshToken: string, res: { access_token: string; expires_in?: number }) {
    this.tokens.set(this.tokenKey(c, refreshToken), { token: res.access_token, until: Date.now() + Math.max(60, (res.expires_in ?? 3600) - 120) * 1000 });
  }

  /** An access token for the connected account (cached until shortly before it expires). */
  private async accessToken(c: GoogleClientCredentials, refreshToken: string): Promise<string> {
    const hit = this.tokens.get(this.tokenKey(c, refreshToken));
    if (hit && hit.until > Date.now()) return hit.token;
    const res = await this.token(c, { grant_type: 'refresh_token', refresh_token: refreshToken });
    this.remember(c, refreshToken, res);
    return res.access_token;
  }

  private async calendar<T>(c: GoogleClientCredentials, refreshToken: string, method: string, path: string, body?: unknown, ok: number[] = []): Promise<T> {
    const access = await this.accessToken(c, refreshToken);
    const res = await this.send(`https://www.googleapis.com/calendar/v3${path}`, {
      method,
      headers: { Authorization: `Bearer ${access}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (ok.includes(res.status)) return {} as T;
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } } & T;
    if (!res.ok) {
      const message = data.error?.message ?? `Google Calendar answered ${res.status}`;
      throw new GoogleError({ statusCode: res.status, code: data.error?.status ?? 'calendar_error', message: `Google Calendar: ${message}` }, res.status === 401 || res.status === 403 ? 400 : 502);
    }
    return data;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.http(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      this.logger.warn(`${init.method} ${new URL(url).pathname} failed: ${(err as Error).message}`);
      throw new BadGatewayException('Could not reach Google; try again in a moment');
    }
  }
}

function explain(error?: string, description?: string): string {
  if (error === 'invalid_grant') return 'Google no longer accepts the connection (it was revoked or expired). Connect the account again.';
  if (error === 'invalid_client' || error === 'unauthorized_client') return 'Google did not accept the client ID and secret. Check them in the Google Cloud console.';
  if (error === 'redirect_uri_mismatch') return 'The redirect URI is not on the OAuth client. Add the one shown here to its Authorized redirect URIs.';
  return description ? `Google: ${description}` : `Google said ${error ?? 'no'}`;
}

/** The email in an ID token from Google's token endpoint (received directly over TLS, so not re-verified). */
function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}
