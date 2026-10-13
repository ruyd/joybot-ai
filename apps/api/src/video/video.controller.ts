import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Can, CurrentPrincipal, EmployeesOnly, Public, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { clientSecretSchema, videoSettingsSchema, VideoService, type VideoSettingsInput } from './video.service';

const CALLBACK_PATH = '/api/website/video/google/callback';

/** Marketing › Sales calls › Setup meeting links: Google Meet for sales calls. */
@Controller('website/video')
export class VideoController {
  constructor(
    private readonly video: VideoService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Where Google sends the admin back: API_PUBLIC_URL when set, else this request's own origin (as
   * the browser reached the API). The page shows it to paste into the OAuth client.
   */
  private redirectUri(req: Request): string {
    if (this.cfg.API_PUBLIC_URL) return `${this.cfg.API_PUBLIC_URL.replace(/\/$/, '')}${CALLBACK_PATH}`;
    const proto = (req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim();
    const host = (req.get('x-forwarded-host') ?? req.get('host') ?? 'localhost:3000').split(',')[0].trim();
    return `${proto}://${host}${CALLBACK_PATH}`;
  }

  @Get()
  @EmployeesOnly()
  @Can('read', 'website')
  settings(@CurrentPrincipal() p: Principal, @Req() req: Request) {
    return this.video.getSettings(p, this.redirectUri(req));
  }

  @Put()
  @EmployeesOnly()
  @Can('update', 'website')
  update(@CurrentPrincipal() p: Principal, @Req() req: Request, @Body(new ZodPipe(videoSettingsSchema)) body: VideoSettingsInput) {
    return this.video.updateSettings(p, body, this.redirectUri(req));
  }

  /** The OAuth client secret (stored encrypted, never shown again). */
  @Put('google/secret')
  @EmployeesOnly()
  @Can('update', 'website')
  setSecret(@CurrentPrincipal() p: Principal, @Req() req: Request, @Body(new ZodPipe(clientSecretSchema)) body: { client_secret: string }) {
    return this.video.setClientSecret(p, body.client_secret, this.redirectUri(req));
  }

  /** Removes the secret, which also disconnects the account. */
  @Delete('google/secret')
  @EmployeesOnly()
  @Can('update', 'website')
  removeSecret(@CurrentPrincipal() p: Principal, @Req() req: Request) {
    return this.video.setClientSecret(p, null, this.redirectUri(req));
  }

  /** Starts connecting a Google account: the browser goes to the returned URL. */
  @Post('google/connect')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('update', 'website')
  connect(@CurrentPrincipal() p: Principal, @Req() req: Request) {
    return this.video.beginConnect(p, this.redirectUri(req));
  }

  @Delete('google/connection')
  @EmployeesOnly()
  @Can('update', 'website')
  disconnect(@CurrentPrincipal() p: Principal, @Req() req: Request) {
    return this.video.disconnect(p, this.redirectUri(req));
  }

  @Post('google/test')
  @HttpCode(200)
  @EmployeesOnly()
  @Can('update', 'website')
  test(@CurrentPrincipal() p: Principal) {
    return this.video.testMeeting(p);
  }

  /**
   * Google's redirect after the consent screen (no sign-in: the single-use state says who started it).
   * Sends the admin back to the setup tab with the result.
   */
  @Get('google/callback')
  @Public()
  async callback(@Req() req: Request, @Res() res: Response, @Query('state') state?: string, @Query('code') code?: string, @Query('error') error?: string) {
    const back = `${await this.video.appUrl()}/staff/sales-calls?tab=video`;
    if (error || !state || !code) {
      res.redirect(`${back}&google_error=${encodeURIComponent(error === 'access_denied' ? 'You cancelled on Google’s screen.' : (error ?? 'Google did not send a code back.'))}`);
      return;
    }
    try {
      const email = await this.video.finishConnect(state, code, this.redirectUri(req));
      res.redirect(`${back}&google=connected${email ? `&account=${encodeURIComponent(email)}` : ''}`);
    } catch (err) {
      const message = (err as { response?: { message?: string } }).response?.message ?? (err as Error).message;
      res.redirect(`${back}&google_error=${encodeURIComponent(message)}`);
    }
  }
}
