import { BadGatewayException, BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { ModelEndpointError, OpenAiCompatibleProvider, type LlmProvider } from '../chat/llm/llm.provider';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { APP_POOL, DbService } from '../db/db.module';
import { SecretBox } from '../email/secret-box';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const aiSettingsSchema = z
  .object({
    /** null: the server's default model (MODEL_ENDPOINT), or answers that only list records. */
    provider: z.enum(['openrouter', 'custom']).nullable(),
    model: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .transform((v) => v || null),
    base_url: z
      .string()
      .trim()
      .max(500)
      .url()
      .regex(/^https?:\/\//, 'Use an http or https URL')
      .nullable()
      .or(z.literal('').transform(() => null)),
    private_only: z.boolean(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const aiKeySchema = z.object({ api_key: z.string().trim().min(1).max(500) }).strict();

export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;

export interface AiSettings {
  provider: 'openrouter' | 'custom' | null;
  model: string | null;
  base_url: string | null;
  private_only: boolean;
  api_key_last4: string | null;
  api_key_set_at: string | null;
  updated_at: string;
  /** The server's default model when no provider is saved (MODEL_NAME), or null for evidence-only answers. */
  server_default: string | null;
  encryption_available: boolean;
}

interface Stored {
  provider: 'openrouter' | 'custom' | null;
  model: string | null;
  base_url: string | null;
  private_only: boolean;
  api_key_cipher: string | null;
}

const COLUMNS = 'provider, model, base_url, private_only, api_key_last4, api_key_set_at, updated_at';

/**
 * Admin › AI: the model that answers chat (OpenRouter, an own OpenAI-compatible deployment, or the
 * server's default), its API key (encrypted at rest, never returned) and a test prompt. Chat asks
 * `provider()` for each question; the answer is cached for 30 seconds.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AI');
  private cache?: { value: OpenAiCompatibleProvider | null; at: number };

  constructor(
    private readonly db: DbService,
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly box: SecretBox,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  getSettings(p: Principal): Promise<AiSettings> {
    return this.db.as(p, async (db) => {
      const row = (await db.query(`SELECT ${COLUMNS} FROM core.ai_settings WHERE id = 1`)).rows[0];
      if (!row) throw new NotFoundException();
      return { ...row, server_default: this.cfg.MODEL_ENDPOINT ? this.cfg.MODEL_NAME : null, encryption_available: this.box.available };
    });
  }

  async updateSettings(p: Principal, input: AiSettingsInput): Promise<AiSettings> {
    const cols = Object.keys(input) as (keyof AiSettingsInput)[];
    await this.db.as(p, (db) => db.query(`UPDATE core.ai_settings SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = 1`, cols.map((c) => input[c])));
    this.cache = undefined;
    return this.getSettings(p);
  }

  async setKey(p: Principal, key: string): Promise<AiSettings> {
    await this.db.as(p, (db) => db.query('SELECT authz.set_ai_key($1, $2)', [this.box.encrypt(key), key.slice(-4)]));
    this.cache = undefined;
    return this.getSettings(p);
  }

  async removeKey(p: Principal): Promise<AiSettings> {
    await this.db.as(p, (db) => db.query('SELECT authz.set_ai_key(NULL, NULL)'));
    this.cache = undefined;
    return this.getSettings(p);
  }

  /** Sends one short prompt to the saved provider (or the server's default). */
  async test(): Promise<{ reply: string; ms: number; model: string }> {
    const saved = await this.provider();
    const provider = saved ?? (this.cfg.MODEL_ENDPOINT ? new OpenAiCompatibleProvider(this.cfg.MODEL_ENDPOINT, this.cfg.MODEL_NAME) : null);
    if (!provider) throw new BadRequestException('Choose a provider first');
    try {
      return { ...(await provider.test()), model: provider.model };
    } catch (err) {
      if (err instanceof ModelEndpointError) throw new BadGatewayException(`The provider refused the request (${err.status})${err.detail ? `: ${err.detail}` : ''}`);
      throw new BadGatewayException(`The provider could not be reached: ${(err as Error).message}`);
    }
  }

  /** The saved provider for chat (cached for 30 seconds), or null to use the server's default. */
  async provider(): Promise<OpenAiCompatibleProvider | null> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    let value: OpenAiCompatibleProvider | null = null;
    try {
      value = this.build((await this.pool.query<Stored>('SELECT * FROM authz.ai_delivery()')).rows[0]);
    } catch (err) {
      this.logger.error(`AI settings cannot be used (was SETTINGS_ENCRYPTION_KEY changed?): ${(err as Error).message}`);
    }
    this.cache = { value, at: Date.now() };
    return value;
  }

  private build(s: Stored | undefined): OpenAiCompatibleProvider | null {
    if (!s?.provider || !s.model) return null;
    const apiKey = s.api_key_cipher ? this.box.decrypt(s.api_key_cipher) : undefined;
    const debug = this.cfg.MODEL_DEBUG === 'true';
    if (s.provider === 'openrouter') {
      if (!apiKey) return null;
      return new OpenAiCompatibleProvider(OPENROUTER_BASE_URL, s.model, undefined, debug, this.cfg.MODEL_THINKING, {
        apiKey,
        headers: { 'x-title': 'JoyBot' },
        // Only providers that neither store nor train on prompts (chat sends customer records).
        body: s.private_only ? { provider: { data_collection: 'deny' } } : {},
        noThinking: { reasoning: { enabled: false } },
      });
    }
    if (!s.base_url) return null;
    return new OpenAiCompatibleProvider(s.base_url, s.model, undefined, debug, this.cfg.MODEL_THINKING, { apiKey });
  }
}

/** The model chat uses: Admin › AI's saved provider, else the server's default. */
export class ConfiguredLlmProvider implements LlmProvider {
  readonly name = 'configured';

  constructor(
    private readonly ai: AiService,
    private readonly fallback: LlmProvider,
  ) {}

  plan(input: Parameters<LlmProvider['plan']>[0]) {
    return this.current().then((p) => p.plan(input));
  }

  async *answer(input: Parameters<LlmProvider['answer']>[0], signal?: AbortSignal): AsyncIterable<string> {
    yield* (await this.current()).answer(input, signal);
  }

  async warmUp(): Promise<void> {
    const p = await this.current();
    // A hosted provider needs no warm-up (and would be billed for it).
    if (p === this.fallback) await this.fallback.warmUp?.();
  }

  private async current(): Promise<LlmProvider> {
    return (await this.ai.provider()) ?? this.fallback;
  }
}
