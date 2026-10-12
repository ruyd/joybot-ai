import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { apiKeySchema, emailSettingsSchema, EmailService, testEmailSchema, type EmailSettingsInput } from './email.service';

/** Admin › Email: email through Resend (settings, API key, usage, domains, a test email). */
@Controller('admin/email')
@EmployeesOnly()
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @Get()
  @Can('update', 'settings')
  settings(@CurrentPrincipal() p: Principal) {
    return this.email.getSettings(p);
  }

  @Put()
  @Can('update', 'settings')
  update(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(emailSettingsSchema)) body: EmailSettingsInput) {
    return this.email.updateSettings(p, body);
  }

  /** Stores a Resend API key (checked with Resend first, kept encrypted, never shown again). */
  @Put('api-key')
  @Can('update', 'settings')
  setKey(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(apiKeySchema)) body: { api_key: string }) {
    return this.email.setKey(p, body.api_key);
  }

  /** Removes the key (email goes back to the default sender). */
  @Delete('api-key')
  @Can('update', 'settings')
  removeKey(@CurrentPrincipal() p: Principal) {
    return this.email.removeKey(p);
  }

  /** Resend's usage: emails today and this month against the plan's limits, and the rate limit. */
  @Get('usage')
  @Can('update', 'settings')
  usage() {
    return this.email.usage();
  }

  /** The domains on the Resend account and whether they are verified. */
  @Get('domains')
  @Can('update', 'settings')
  domains() {
    return this.email.domains();
  }

  @Post('test')
  @HttpCode(200)
  @Can('update', 'settings')
  test(@Body(new ZodPipe(testEmailSchema)) body: { to: string }) {
    return this.email.sendTest(body.to);
  }
}
