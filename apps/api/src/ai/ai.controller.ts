import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { aiKeySchema, aiSettingsSchema, AiService, type AiSettingsInput } from './ai.service';

/** Admin › AI: the chat model (provider, model, API key) and a test prompt. */
@Controller('admin/ai')
@EmployeesOnly()
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get()
  @Can('update', 'settings')
  settings(@CurrentPrincipal() p: Principal) {
    return this.ai.getSettings(p);
  }

  @Put()
  @Can('update', 'settings')
  update(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(aiSettingsSchema)) body: AiSettingsInput) {
    return this.ai.updateSettings(p, body);
  }

  /** Stores the provider's API key (kept encrypted, never shown again). */
  @Put('api-key')
  @Can('update', 'settings')
  setKey(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(aiKeySchema)) body: { api_key: string }) {
    return this.ai.setKey(p, body.api_key);
  }

  @Delete('api-key')
  @Can('update', 'settings')
  removeKey(@CurrentPrincipal() p: Principal) {
    return this.ai.removeKey(p);
  }

  /** One short prompt to the model chat would use now. */
  @Post('test')
  @HttpCode(200)
  @Can('update', 'settings')
  test() {
    return this.ai.test();
  }
}
