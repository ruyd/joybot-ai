import { BadGatewayException, BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import {
  EvidenceOnlyProvider,
  ModelEndpointError,
  OpenAiCompatibleProvider,
  type AnswerInput,
  type LlmProvider,
  type PlanInput,
  type ProviderConnection,
  type TokenUsage,
} from '../chat/llm/llm.provider';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { APP_POOL, DbService } from '../db/db.module';
import { SecretBox } from '../email/secret-box';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** What a model does. One slot each; all slots work at the same time. */
export const CAPABILITIES = [
  'general',
  'embeddings',
  'reranker',
  'speech_to_text',
  'text_to_speech',
  'realtime_voice',
  'vision',
  'image_generation',
  'video_generation',
  'avatar',
  'moderation',
  'document_parsing',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const KINDS = ['openrouter', 'openai_compatible', 'ollama'] as const;
type Kind = (typeof KINDS)[number];

/** How a slot's work is delivered. Only these run today; Redis, SQS and Durable Objects come later. */
const AVAILABLE_TRANSPORTS = ['direct', 'postgres'] as const;
/** Answers stream while the person waits, so these are called directly. */
const DIRECT_ONLY: Capability[] = ['general', 'text_to_speech', 'realtime_voice'];

const url = z
  .string()
  .trim()
  .max(500)
  .url()
  .regex(/^https?:\/\//, 'Use an http or https URL');
const money = z.number().min(0).max(1_000_000);

export const connectionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(KINDS),
    base_url: url.nullable().or(z.literal('').transform(() => null)),
    private: z.boolean(),
    active: z.boolean(),
    monthly_cap_usd: money.nullable(),
  })
  .partial()
  .strict();
export const newConnectionSchema = connectionSchema
  .required({ name: true, kind: true })
  .refine((c) => c.kind === 'openrouter' || c.base_url, { message: 'This kind of connection needs a base URL', path: ['base_url'] });

export const modelSchema = z
  .object({
    connection_id: z.string().uuid(),
    model: z.string().trim().min(1).max(200),
    capability: z.enum(CAPABILITIES),
    label: z
      .string()
      .trim()
      .max(100)
      .nullable()
      .transform((v) => v || null),
    tags: z.array(z.string().trim().min(1).max(30)).max(10),
    description: z
      .string()
      .trim()
      .max(300)
      .nullable()
      .transform((v) => v || null),
    context_tokens: z.number().int().positive().max(100_000_000).nullable(),
    input_price: money.nullable(),
    output_price: money.nullable(),
    options: z.object({ voice: z.string().trim().max(100).optional() }).strict(),
  })
  .partial()
  .strict();
export const newModelSchema = modelSchema.required({ connection_id: true, model: true, capability: true });
export const modelUpdateSchema = modelSchema.omit({ connection_id: true, capability: true });

export const slotSchema = z
  .object({
    model_id: z.string().uuid().nullable(),
    backup_model_id: z.string().uuid().nullable(),
    transport: z.enum(['direct', 'postgres', 'redis', 'sqs', 'durable_objects']),
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const aiKeySchema = z.object({ api_key: z.string().trim().min(1).max(500) }).strict();

export type ConnectionInput = z.infer<typeof connectionSchema>;
export type ModelInput = z.infer<typeof modelSchema>;
export type SlotInput = z.infer<typeof slotSchema>;
type Audience = 'employee' | 'customer' | 'admin';

const CONNECTION_COLUMNS = 'id, name, kind, base_url, private, active, monthly_cap_usd, api_key_last4, api_key_set_at, created_at, updated_at';
const MODEL_COLUMNS = 'id, connection_id, model, capability, label, tags, description, context_tokens, input_price, output_price, options, created_at, updated_at';

/** A model ready to call: what it is, where, its key and prices. */
interface Delivery {
  model_id: string;
  model: string;
  options: { voice?: string };
  input_price: string | null;
  output_price: string | null;
  connection_id: string;
  connection_name: string;
  kind: Kind;
  base_url: string | null;
  private: boolean;
  api_key_cipher: string | null;
}

interface SlotRow extends Partial<Delivery> {
  slot_active: boolean;
  transport: string;
  role: 'primary' | 'backup' | null;
  connection_active: boolean | null;
  over_cap: boolean | null;
}

/** A slot as chat sees it: on or off, and the models it may use for an audience, in order. */
interface Resolved {
  active: boolean;
  /** No model chosen (General: the server's default model). */
  empty: boolean;
  usable: Delivery[];
}

/**
 * Settings › AI: connections to providers, their models, and one slot per capability. Chat and the
 * specialists ask `resolve()` for each call (cached for 30 seconds, cleared on any change), which
 * applies the privacy block (customers' questions go only to private connections), the monthly caps
 * and the backup model. Every call is logged in app.ai_calls (no prompt or reply text).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AI');
  private cache = new Map<Capability, { rows: SlotRow[]; at: number }>();

  constructor(
    private readonly db: DbService,
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly box: SecretBox,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  // Admin: read and change ---------------------------------------------------------------------

  overview(p: Principal) {
    return this.db.as(p, async (db) => {
      const spend = new Map((await db.query<{ connection_id: string; spent_usd: string }>('SELECT * FROM authz.ai_month_spend()')).rows.map((r) => [r.connection_id, r.spent_usd]));
      const connections = (await db.query(`SELECT ${CONNECTION_COLUMNS} FROM core.ai_connections ORDER BY lower(name)`)).rows.map((c) => ({
        ...c,
        spent_usd: spend.get(c.id) ?? '0',
      }));
      const models = (await db.query(`SELECT ${MODEL_COLUMNS} FROM core.ai_models ORDER BY capability, model`)).rows;
      const slots = (await db.query('SELECT capability, model_id, backup_model_id, transport, active, updated_at FROM core.ai_slots')).rows.sort(
        (a, b) => CAPABILITIES.indexOf(a.capability) - CAPABILITIES.indexOf(b.capability),
      );
      // This UTC month, per capability and per connection: calls and spending.
      const month = `created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
      const usage = (
        await db.query<{ capability: string; calls: number; spent_usd: string }>(
          `SELECT capability, count(*)::int AS calls, sum(cost_usd)::text AS spent_usd FROM app.ai_calls WHERE ${month} GROUP BY capability`,
        )
      ).rows;
      const callsByConnection = new Map(
        (await db.query<{ connection_id: string; calls: number }>(`SELECT connection_id, count(*)::int AS calls FROM app.ai_calls WHERE ${month} AND connection_id IS NOT NULL GROUP BY connection_id`)).rows.map(
          (r) => [r.connection_id, r.calls],
        ),
      );
      return {
        connections: connections.map((c) => ({ ...c, calls: callsByConnection.get(c.id) ?? 0 })),
        models,
        slots,
        usage,
        server_default: this.cfg.MODEL_ENDPOINT ? this.cfg.MODEL_NAME : null,
        encryption_available: this.box.available,
        available_transports: AVAILABLE_TRANSPORTS,
      };
    });
  }

  async createConnection(p: Principal, input: ConnectionInput) {
    const row = await this.db.as(p, async (db) => {
      const cols = Object.keys(input) as (keyof ConnectionInput)[];
      return (
        await db.query(
          `INSERT INTO core.ai_connections (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${CONNECTION_COLUMNS}`,
          cols.map((c) => input[c]),
        )
      ).rows[0];
    });
    this.changed();
    return row;
  }

  async updateConnection(p: Principal, id: string, input: ConnectionInput) {
    const cols = Object.keys(input) as (keyof ConnectionInput)[];
    if (!cols.length) throw new BadRequestException('Nothing to change');
    const row = await this.db.as(p, async (db) =>
      (
        await db.query(
          `UPDATE core.ai_connections SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${CONNECTION_COLUMNS}`,
          [id, ...cols.map((c) => input[c])],
        )
      ).rows[0],
    );
    if (!row) throw new NotFoundException();
    this.changed();
    return row;
  }

  async deleteConnection(p: Principal, id: string) {
    const n = await this.db.as(p, async (db) => (await db.query('DELETE FROM core.ai_connections WHERE id = $1', [id])).rowCount);
    if (!n) throw new NotFoundException();
    this.changed();
  }

  async setKey(p: Principal, id: string, key: string) {
    if (!this.box.available) throw new BadRequestException('SETTINGS_ENCRYPTION_KEY is not set, so keys cannot be stored');
    await this.db.as(p, (db) => db.query('SELECT authz.set_ai_connection_key($1, $2, $3)', [id, this.box.encrypt(key), key.slice(-4)]));
    this.changed();
    return this.connection(p, id);
  }

  async removeKey(p: Principal, id: string) {
    await this.db.as(p, (db) => db.query('SELECT authz.set_ai_connection_key($1, NULL, NULL)', [id]));
    this.changed();
    return this.connection(p, id);
  }

  async createModel(p: Principal, input: ModelInput) {
    const row = await this.db.as(p, async (db) => {
      const cols = Object.keys(input) as (keyof ModelInput)[];
      return (
        await db.query(
          `INSERT INTO core.ai_models (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${MODEL_COLUMNS}`,
          cols.map((c) => (c === 'options' ? JSON.stringify(input[c]) : input[c])),
        )
      ).rows[0];
    });
    this.changed();
    return row;
  }

  async updateModel(p: Principal, id: string, input: ModelInput) {
    const cols = Object.keys(input) as (keyof ModelInput)[];
    if (!cols.length) throw new BadRequestException('Nothing to change');
    const row = await this.db.as(p, async (db) =>
      (
        await db.query(
          `UPDATE core.ai_models SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${MODEL_COLUMNS}`,
          [id, ...cols.map((c) => (c === 'options' ? JSON.stringify(input[c]) : input[c]))],
        )
      ).rows[0],
    );
    if (!row) throw new NotFoundException();
    this.changed();
    return row;
  }

  async deleteModel(p: Principal, id: string) {
    const n = await this.db.as(p, async (db) => (await db.query('DELETE FROM core.ai_models WHERE id = $1', [id])).rowCount);
    if (!n) throw new NotFoundException();
    this.changed();
  }

  async updateSlot(p: Principal, capability: Capability, input: SlotInput) {
    if (input.transport && !(AVAILABLE_TRANSPORTS as readonly string[]).includes(input.transport)) {
      throw new BadRequestException(`${input.transport} is not available yet; use direct or postgres`);
    }
    if (input.transport && input.transport !== 'direct' && DIRECT_ONLY.includes(capability)) {
      throw new BadRequestException('This capability answers while the person waits, so it is called directly');
    }
    const cols = Object.keys(input) as (keyof SlotInput)[];
    const row = await this.db.as(p, async (db) =>
      (
        await db.query(
          `UPDATE core.ai_slots SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE capability = $1
           RETURNING capability, model_id, backup_model_id, transport, active, updated_at`,
          [capability, ...cols.map((c) => input[c])],
        )
      ).rows[0],
    );
    if (!row) throw new NotFoundException();
    this.changed();
    return row;
  }

  calls(p: Principal, limit: number) {
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT c.id, c.created_at, c.capability, c.model, c.audience, c.step, c.input_units, c.output_units, c.cost_usd, c.ms, c.ok, c.error,
                  n.name AS connection_name
             FROM app.ai_calls c LEFT JOIN core.ai_connections n ON n.id = c.connection_id
            ORDER BY c.created_at DESC LIMIT $1`,
          [limit],
        )
      ).rows,
    );
  }

  /** Connection's Test button: lists the provider's models (checks the address and key without spending anything). */
  async testConnection(p: Principal, id: string) {
    const c = await this.db.as(p, async (db) => (await db.query<{ id: string; kind: Kind; base_url: string | null; name: string }>('SELECT id, kind, base_url, name FROM core.ai_connections WHERE id = $1', [id])).rows[0]);
    if (!c) throw new NotFoundException();
    // The key: through any of its models' delivery (admins only); a connection without models is tested without one.
    const keyed = await this.db.as(p, async (db) =>
      (await db.query<{ id: string }>('SELECT id FROM core.ai_models WHERE connection_id = $1 LIMIT 1', [id])).rows[0]
        ? (await db.query<Delivery>('SELECT * FROM authz.ai_model_delivery((SELECT id FROM core.ai_models WHERE connection_id = $1 LIMIT 1))', [id])).rows[0]
        : undefined,
    );
    const started = Date.now();
    const base = this.baseUrl({ kind: c.kind, base_url: c.base_url } as Delivery);
    const key = keyed ? this.key(keyed) : undefined;
    try {
      // OpenRouter's model list is public, so its key is checked on /key instead.
      const res = await fetch(`${base}/${c.kind === 'openrouter' ? 'key' : 'models'}`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new ModelEndpointError(res.status, await res.text().then((t) => t.slice(0, 300)).catch(() => undefined));
      const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      return { ok: true, ms: Date.now() - started, models: Array.isArray(body.data) ? body.data.length : null };
    } catch (err) {
      throw providerError(err);
    }
  }

  /** Admin's Test button: one short prompt (General) or a spoken sentence (text to speech). */
  async testModel(p: Principal, id: string) {
    const m = await this.db.as(p, async (db) => (await db.query<Delivery & { capability: Capability }>('SELECT * FROM authz.ai_model_delivery($1)', [id])).rows[0]);
    if (!m) throw new NotFoundException();
    try {
      if (m.capability === 'general') {
        const provider = this.chatProvider(m, 'admin', 'test');
        return { capability: m.capability, model: m.model, ...(await provider.test()) };
      }
      if (m.capability === 'text_to_speech') {
        const spoken = await this.callSpeech(m, 'Hello! This is how replies will sound.', 'admin');
        return { capability: m.capability, model: m.model, ms: spoken.ms, audio: spoken.audio.toString('base64'), mime: spoken.mime };
      }
    } catch (err) {
      throw providerError(err);
    }
    throw new BadRequestException('Testing this kind of model is not available yet');
  }

  // Runtime: what chat and the specialists use ------------------------------------------------

  /** A slot for an audience: its usable models in order, after the privacy block, caps and on/off. */
  async resolve(capability: Capability, audience: Audience): Promise<Resolved> {
    const rows = await this.slotRows(capability);
    const first = rows[0];
    if (!first) return { active: false, empty: true, usable: [] };
    const models = rows.filter((r): r is SlotRow & Delivery => Boolean(r.model_id && r.connection_id));
    const usable = models.filter(
      (r) =>
        r.connection_active &&
        !r.over_cap &&
        // The privacy block: customers' questions carry their records, so only private connections.
        (audience !== 'customer' || r.private) &&
        // OpenRouter refuses requests without a key.
        (r.kind !== 'openrouter' || r.api_key_cipher),
    );
    return { active: first.slot_active, empty: models.length === 0, usable };
  }

  /** Speaks text with the text-to-speech slot (for voice replies). */
  async speak(text: string, audience: Audience): Promise<{ audio: Buffer; mime: string; ms: number }> {
    const slot = await this.resolve('text_to_speech', audience);
    if (!slot.active || !slot.usable.length) throw new BadRequestException('No voice model is available for this audience');
    let last: unknown;
    for (const m of slot.usable) {
      try {
        return await this.callSpeech(m, text, audience === 'admin' ? 'admin' : audience);
      } catch (err) {
        last = err;
      }
    }
    throw providerError(last);
  }

  /** A chat model for one call, which logs what it used. */
  chatProvider(m: Delivery, audience: Audience, step: string): OpenAiCompatibleProvider {
    const started = Date.now();
    const onUsage = (u: TokenUsage) => void this.log(m, 'general', audience, step, u.prompt_tokens, u.completion_tokens, this.cost(m, u), Date.now() - started, true);
    const debug = this.cfg.MODEL_DEBUG === 'true';
    const connection: ProviderConnection = { apiKey: this.key(m), onUsage };
    if (m.kind === 'openrouter') {
      connection.headers = { 'x-title': 'JoyBot' };
      // Private: only OpenRouter providers that neither store nor train on prompts.
      connection.body = { usage: { include: true }, ...(m.private ? { provider: { data_collection: 'deny' } } : {}) };
      connection.noThinking = { reasoning: { enabled: false } };
    }
    return new OpenAiCompatibleProvider(this.baseUrl(m), m.model, undefined, debug, this.cfg.MODEL_THINKING, connection);
  }

  /** Logs a failed call (successful ones log from their usage). */
  logFailure(m: Delivery, audience: Audience, step: string, err: unknown, ms: number) {
    void this.log(m, 'general', audience, step, undefined, undefined, 0, ms, false, (err as Error).message);
  }

  /** True when the General slot has a model configured (not Auto). */
  async generalConfigured(): Promise<boolean> {
    return !(await this.resolve('general', 'employee')).empty;
  }

  // Internals ----------------------------------------------------------------------------------

  private async callSpeech(m: Delivery, text: string, audience: Audience) {
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl(m)}/audio/speech`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.key(m) ? { authorization: `Bearer ${this.key(m)}` } : {}),
          ...(m.kind === 'openrouter' ? { 'x-title': 'JoyBot' } : {}),
        },
        body: JSON.stringify({ model: m.model, input: text.slice(0, 5000), ...(m.options?.voice ? { voice: m.options.voice } : {}) }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new ModelEndpointError(res.status, await res.text().then((t) => t.slice(0, 300)).catch(() => undefined));
      const raw = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') ?? '';
      // Raw PCM (HeyGen: 44.1 kHz mono 16-bit) gets a WAV header so browsers can play it.
      const pcm = !type || type.includes('pcm') || type.includes('octet-stream') || type.includes('L16');
      const audio = pcm ? wav(raw, 44_100) : raw;
      const ms = Date.now() - started;
      void this.log(m, 'text_to_speech', audience, 'speak', text.length, undefined, (text.length * Number(m.input_price ?? 0)) / 1_000_000, ms, true);
      return { audio, mime: pcm ? 'audio/wav' : type.split(';')[0], ms };
    } catch (err) {
      void this.log(m, 'text_to_speech', audience, 'speak', text.length, undefined, 0, Date.now() - started, false, (err as Error).message);
      throw err;
    }
  }

  private async slotRows(capability: Capability): Promise<SlotRow[]> {
    const hit = this.cache.get(capability);
    if (hit && Date.now() - hit.at < 30_000) return hit.rows;
    let rows: SlotRow[] = [];
    try {
      rows = (await this.pool.query<SlotRow>('SELECT * FROM authz.ai_slot_delivery($1)', [capability])).rows;
    } catch (err) {
      this.logger.error(`AI slot ${capability} cannot be read: ${(err as Error).message}`);
    }
    this.cache.set(capability, { rows, at: Date.now() });
    return rows;
  }

  private changed() {
    this.cache.clear();
  }

  private key(m: Delivery): string | undefined {
    if (!m.api_key_cipher) return undefined;
    try {
      return this.box.decrypt(m.api_key_cipher);
    } catch (err) {
      this.logger.error(`The key for ${m.connection_name} cannot be read (was SETTINGS_ENCRYPTION_KEY changed?): ${(err as Error).message}`);
      return undefined;
    }
  }

  private baseUrl(m: Delivery): string {
    return (m.kind === 'openrouter' ? OPENROUTER_BASE_URL : (m.base_url ?? '')).replace(/\/$/, '');
  }

  /** OpenRouter's own figure, else tokens times the model's prices. */
  private cost(m: Delivery, u: TokenUsage): number {
    if (typeof u.cost === 'number') return u.cost;
    return ((u.prompt_tokens ?? 0) * Number(m.input_price ?? 0) + (u.completion_tokens ?? 0) * Number(m.output_price ?? 0)) / 1_000_000;
  }

  private async log(m: Delivery, capability: Capability, audience: Audience, step: string, input: number | undefined, output: number | undefined, cost: number, ms: number, ok: boolean, error?: string) {
    try {
      await this.pool.query('SELECT authz.log_ai_call($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [
        m.connection_id,
        m.model_id,
        capability,
        m.model,
        audience,
        step,
        input ?? null,
        output ?? null,
        cost,
        ms,
        ok,
        error ?? null,
      ]);
      // Spending changes whether a connection is over its cap.
      if (cost > 0) this.cache.clear();
    } catch (err) {
      this.logger.warn(`AI call not logged: ${(err as Error).message}`);
    }
  }

  private connection(p: Principal, id: string) {
    return this.db.as(p, async (db) => {
      const row = (await db.query(`SELECT ${CONNECTION_COLUMNS} FROM core.ai_connections WHERE id = $1`, [id])).rows[0];
      if (!row) throw new NotFoundException();
      return row;
    });
  }
}

function providerError(err: unknown) {
  if (err instanceof BadRequestException || err instanceof NotFoundException) return err;
  if (err instanceof ModelEndpointError) return new BadGatewayException(`The provider refused the request (${err.status})${err.detail ? `: ${err.detail}` : ''}`);
  return new BadGatewayException(`The provider could not be reached: ${(err as Error)?.message ?? 'unknown error'}`);
}

/** Wraps 16-bit mono PCM in a WAV header. */
function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * The model chat uses: the General slot's model (then its backup) for the asker's audience, the
 * server's default when the slot is empty (Auto), or search only when the slot is off or no model
 * may be used (for customers: no private connection; or every connection is over its cap).
 */
export class ConfiguredLlmProvider implements LlmProvider {
  readonly name = 'configured';
  private readonly searchOnlyProvider = new EvidenceOnlyProvider();

  constructor(
    private readonly ai: AiService,
    private readonly fallback: LlmProvider,
  ) {}

  async plan(input: PlanInput) {
    const slot = await this.ai.resolve('general', input.audience);
    if (!slot.active || (!slot.empty && !slot.usable.length)) return [];
    if (slot.empty) return this.fallback.plan(input);
    let last: unknown;
    for (const m of slot.usable) {
      const started = Date.now();
      try {
        return await this.ai.chatProvider(m, input.audience, 'plan').plan(input);
      } catch (err) {
        this.ai.logFailure(m, input.audience, 'plan', err, Date.now() - started);
        last = err;
      }
    }
    throw last;
  }

  async *answer(input: AnswerInput, signal?: AbortSignal): AsyncIterable<string> {
    const slot = await this.ai.resolve('general', input.audience);
    if (!slot.active || (!slot.empty && !slot.usable.length)) {
      yield* this.searchOnlyProvider.answer(input);
      return;
    }
    if (slot.empty) {
      yield* this.fallback.answer(input, signal);
      return;
    }
    let last: unknown;
    for (const m of slot.usable) {
      const started = Date.now();
      let yielded = false;
      try {
        for await (const token of this.ai.chatProvider(m, input.audience, 'answer').answer(input, signal)) {
          yielded = true;
          yield token;
        }
        return;
      } catch (err) {
        this.ai.logFailure(m, input.audience, 'answer', err, Date.now() - started);
        // Half an answer can't be continued by another model; chat then lists the records found.
        if (yielded) throw err;
        last = err;
      }
    }
    throw last;
  }

  async warmUp(): Promise<void> {
    // A hosted provider needs no warm-up (and would be billed for it).
    if (!(await this.ai.generalConfigured())) await this.fallback.warmUp?.();
  }

  async searchOnly(audience: 'employee' | 'customer' = 'employee'): Promise<boolean> {
    const slot = await this.ai.resolve('general', audience);
    if (!slot.active) return true;
    if (slot.empty) return (await this.fallback.searchOnly?.()) ?? false;
    return slot.usable.length === 0;
  }
}
