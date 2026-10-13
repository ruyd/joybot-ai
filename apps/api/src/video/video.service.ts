import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { APP_POOL, DbService } from '../db/db.module';
import { SecretBox } from '../email/secret-box';
import { MessagingService } from '../messaging/messaging.service';
import { GoogleClient, GoogleError, type GoogleClientCredentials, type MeetingEvent } from './google';

export const CHECKLIST = ['project', 'api', 'consent', 'test'] as const;

export const videoSettingsSchema = z
  .object({
    google_project_id: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9-]{4,29}$/, 'A Google Cloud project ID, e.g. my-project-123')
      .nullable()
      .or(z.literal('').transform(() => null)),
    google_client_id: z
      .string()
      .trim()
      .regex(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/, 'The client ID ends in .apps.googleusercontent.com')
      .nullable()
      .or(z.literal('').transform(() => null)),
    checklist: z.array(z.enum(CHECKLIST)).max(CHECKLIST.length),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const clientSecretSchema = z.object({ client_secret: z.string().trim().min(8).max(500) }).strict();

export type VideoSettingsInput = z.infer<typeof videoSettingsSchema>;

const COLUMNS = `google_project_id, google_client_id, google_secret_set_at, google_account_email, google_connected_at, google_calendar_id, checklist, updated_at`;

/**
 * Video calls for sales calls: Google Meet through a Google account an admin connects (OAuth, scope
 * calendar.app.created). The client secret and refresh token are encrypted at rest and never returned.
 * Connecting makes JoyBot's own calendar in that account; while connected, each booking gets an event
 * with a Meet link there (disconnecting is the way to stop).
 */
@Injectable()
export class VideoService {
  private readonly logger = new Logger('Video');

  constructor(
    private readonly db: DbService,
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly box: SecretBox,
    private readonly google: GoogleClient,
    private readonly messaging: MessagingService,
  ) {}

  getSettings(p: Principal, redirectUri: string) {
    return this.db.as(p, async (db) => {
      const row = (await db.query(`SELECT ${COLUMNS} FROM core.video_settings WHERE id = 1`)).rows[0];
      if (!row) throw new NotFoundException();
      return { ...row, redirect_uri: redirectUri, encryption_available: this.box.available };
    });
  }

  async updateSettings(p: Principal, input: VideoSettingsInput, redirectUri: string) {
    const cols = Object.keys(input) as (keyof VideoSettingsInput)[];
    await this.db.as(p, (db) => db.query(`UPDATE core.video_settings SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = 1`, cols.map((c) => input[c])));
    return this.getSettings(p, redirectUri);
  }

  async setClientSecret(p: Principal, secret: string | null, redirectUri: string) {
    await this.db.as(p, (db) => db.query('SELECT authz.set_google_client_secret($1)', [secret === null ? null : this.box.encrypt(secret)]));
    return this.getSettings(p, redirectUri);
  }

  /** Starts connecting a Google account: the consent screen's URL, with a single-use state. */
  async beginConnect(p: Principal, redirectUri: string): Promise<{ url: string }> {
    const c = await this.credentials();
    if (!c) throw new BadRequestException('Save the OAuth client ID and secret first');
    const state = randomBytes(32).toString('base64url');
    await this.db.as(p, (db) => db.query('SELECT authz.begin_google_connect($1)', [hash(state)]));
    return { url: this.google.consentUrl(c.clientId, redirectUri, state) };
  }

  /**
   * Google's redirect: stores the account for whoever started connecting (the state says who) and makes
   * JoyBot's calendar there, reusing the one it made before when the same account reconnects.
   */
  async finishConnect(state: string, code: string, redirectUri: string): Promise<string | null> {
    const user = (await this.pool.query<{ user_id: string | null }>('SELECT authz.claim_google_connect($1) AS user_id', [hash(state)])).rows[0]?.user_id;
    if (!user) throw new BadRequestException('This sign-in link expired or was already used. Start connecting again.');
    const c = await this.credentials();
    if (!c) throw new BadRequestException('The OAuth client is not set up any more');
    const { refreshToken, email } = await this.google.exchangeCode(c, code, redirectUri);
    const s = (await this.stored())!;
    const previous = s.calendar_id && email && s.google_account_email?.toLowerCase() === email.toLowerCase() ? s.calendar_id : null;
    const calendarId = await this.google.ensureCalendar(c, refreshToken, previous, { summary: s.calendar_name, timeZone: s.time_zone });
    await this.pool.query('SELECT authz.finish_google_connect($1, $2, $3, $4)', [user, this.box.encrypt(refreshToken), email, calendarId]);
    return email;
  }

  async disconnect(p: Principal, redirectUri: string) {
    await this.db.as(p, (db) => db.query('SELECT authz.disconnect_google()'));
    return this.getSettings(p, redirectUri);
  }

  /** Creates (then removes) a meeting to show the connection works, and ticks the last setup step. */
  async testMeeting(p: Principal): Promise<{ meet_url: string }> {
    const d = await this.delivery();
    if (!d) throw new BadRequestException('Connect a Google account first');
    const start = new Date(Date.now() + 60 * 60_000);
    const m = await this.meeting(d, { summary: 'JoyBot test meeting', description: 'Created from JoyBot to check Google Meet; removed right away.', start, end: new Date(start.getTime() + 30 * 60_000) }, `test-${randomBytes(8).toString('hex')}`);
    await this.google.deleteMeeting(d.client, d.refreshToken, m.calendarId, m.eventId).catch(() => undefined);
    await this.db.as(p, (db) => db.query(`UPDATE core.video_settings SET checklist = array_append(array_remove(checklist, 'test'), 'test') WHERE id = 1`));
    return { meet_url: m.meetUrl };
  }

  // Sales calls (no principal: the booking path) ------------------------------------------------

  /** While connected: an event with a Meet link for a new sales call, kept on the appointment (best effort). */
  async createForSalesCall(id: string, e: { summary: string; description: string; start: Date; end: Date }): Promise<string | null> {
    const d = await this.delivery();
    if (!d) return null;
    try {
      const m = await this.meeting(d, e, `sales-call-${id}`);
      await this.pool.query('SELECT authz.set_sales_call_meeting($1, $2, $3)', [id, m.meetUrl, m.eventId]);
      return m.meetUrl;
    } catch (err) {
      this.logger.warn(`Meet link for sales call failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Moves the call's event to its new time (best effort). */
  async moveForSalesCall(id: string) {
    const ev = (await this.pool.query<{ calendar_event_id: string | null; starts_at: Date; ends_at: Date }>('SELECT * FROM authz.sales_call_event($1)', [id])).rows[0];
    if (!ev?.calendar_event_id) return;
    const d = await this.delivery();
    if (!d) return;
    await this.google.moveMeeting(d.client, d.refreshToken, d.calendarId, ev.calendar_event_id, ev.starts_at, ev.ends_at).catch((err) => this.logger.warn(`moving the Meet event failed: ${(err as Error).message}`));
  }

  /** Removes the call's event (best effort) and forgets the link. */
  async cancelForSalesCall(id: string) {
    const ev = (await this.pool.query<{ calendar_event_id: string | null }>('SELECT * FROM authz.sales_call_event($1)', [id])).rows[0];
    if (!ev?.calendar_event_id) return;
    const d = await this.delivery();
    if (d) await this.google.deleteMeeting(d.client, d.refreshToken, d.calendarId, ev.calendar_event_id).catch((err) => this.logger.warn(`removing the Meet event failed: ${(err as Error).message}`));
    await this.pool.query('SELECT authz.set_sales_call_meeting($1, NULL, NULL)', [id]);
  }

  // ---------------------------------------------------------------------------------------------

  /** A meeting in JoyBot's calendar; when that calendar was deleted in Google, makes it again first. */
  private async meeting(d: Delivery, e: MeetingEvent, requestId: string) {
    try {
      return { ...(await this.google.createMeeting(d.client, d.refreshToken, d.calendarId, e, requestId)), calendarId: d.calendarId };
    } catch (err) {
      if (!(err instanceof GoogleError) || ![404, 410].includes((err.getResponse() as { statusCode?: number }).statusCode ?? 0)) throw err;
      const calendarId = await this.google.ensureCalendar(d.client, d.refreshToken, d.calendarId, d.calendar);
      if (calendarId === d.calendarId) throw err;
      await this.pool.query('SELECT authz.set_google_calendar($1)', [calendarId]);
      return { ...(await this.google.createMeeting(d.client, d.refreshToken, calendarId, e, requestId)), calendarId };
    }
  }

  private async stored() {
    return (
      await this.pool.query<{
        google_client_id: string | null;
        client_secret_cipher: string | null;
        refresh_token_cipher: string | null;
        google_account_email: string | null;
        calendar_id: string | null;
        calendar_name: string;
        time_zone: string | null;
      }>('SELECT * FROM authz.video_delivery()')
    ).rows[0];
  }

  private async credentials(): Promise<GoogleClientCredentials | null> {
    const s = await this.stored();
    if (!s?.google_client_id || !s.client_secret_cipher) return null;
    return { clientId: s.google_client_id, clientSecret: this.box.decrypt(s.client_secret_cipher) };
  }

  /** The client, the connected account and its JoyBot calendar (null when not connected). */
  private async delivery(): Promise<Delivery | null> {
    const s = await this.stored();
    if (!s?.google_client_id || !s.client_secret_cipher || !s.refresh_token_cipher || !s.calendar_id) return null;
    try {
      return {
        client: { clientId: s.google_client_id, clientSecret: this.box.decrypt(s.client_secret_cipher) },
        refreshToken: this.box.decrypt(s.refresh_token_cipher),
        calendarId: s.calendar_id,
        calendar: { summary: s.calendar_name, timeZone: s.time_zone },
      };
    } catch (err) {
      this.logger.error(`Google secrets cannot be decrypted (was SETTINGS_ENCRYPTION_KEY changed?): ${(err as Error).message}`);
      return null;
    }
  }

  /** The web app, where the callback sends the admin back. */
  appUrl() {
    return this.messaging.appUrl();
  }
}

interface Delivery {
  client: GoogleClientCredentials;
  refreshToken: string;
  calendarId: string;
  calendar: { summary: string; timeZone: string | null };
}

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
