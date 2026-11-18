/**
 * One call per queued capability against an OpenAI-compatible API (OpenRouter, Ollama, vLLM…).
 * Each runner returns the job's result plus what to log: units in and out and the cost.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** A model the slot can use now: from authz.ai_slot_delivery, with its key decrypted. */
export interface Target {
  model_id: string;
  model: string;
  options: Record<string, unknown> | null;
  input_price: string | null;
  output_price: string | null;
  connection_id: string;
  connection_name: string;
  kind: 'openrouter' | 'openai_compatible' | 'ollama';
  base_url: string | null;
  private: boolean;
  apiKey?: string;
}

export interface RunOutput {
  result: Record<string, unknown>;
  input_units?: number;
  output_units?: number;
  cost: number;
}

/** A job that will fail the same way however often it runs (bad input, nothing to run it with). */
export class PermanentError extends Error {}

/** The provider answered with an error status. 4xx other than 408/429 won't get better on a retry. */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    body: string | undefined,
  ) {
    super(`provider returned ${status}${body ? `: ${body}` : ''}`);
  }
  get permanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

type Input = Record<string, unknown>;
type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };

const TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function baseUrl(t: Pick<Target, 'kind' | 'base_url'>): string {
  return (t.kind === 'openrouter' ? OPENROUTER_BASE_URL : (t.base_url ?? '')).replace(/\/$/, '');
}

function headers(t: Target, json = true): Record<string, string> {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}),
    ...(t.kind === 'openrouter' ? { 'x-title': 'JoyBot' } : {}),
  };
}

/** OpenRouter extras: report the cost, and for private connections only providers that don't keep prompts. */
function extras(t: Target): Record<string, unknown> {
  if (t.kind !== 'openrouter') return {};
  return { usage: { include: true }, ...(t.private ? { provider: { data_collection: 'deny' } } : {}) };
}

/** OpenRouter's own figure, else tokens times the model's prices (per million). */
function costOf(t: Target, u: Usage | undefined): number {
  if (!u) return 0;
  if (typeof u.cost === 'number') return Math.max(u.cost, 0);
  return ((u.prompt_tokens ?? 0) * Number(t.input_price ?? 0) + (u.completion_tokens ?? 0) * Number(t.output_price ?? 0)) / 1_000_000;
}

async function post(t: Target, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${baseUrl(t)}${path}`, {
    method: 'POST',
    headers: headers(t),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new ProviderError(res.status, await res.text().then((s) => s.slice(0, 200)).catch(() => undefined));
  return res.json();
}

async function chat(t: Target, content: unknown, extra: Record<string, unknown> = {}): Promise<{ text: string; usage?: Usage; message: any }> {
  const data = await post(t, '/chat/completions', { model: t.model, messages: [{ role: 'user', content }], ...extras(t), ...extra });
  const message = data.choices?.[0]?.message ?? {};
  return { text: typeof message.content === 'string' ? message.content : '', usage: data.usage, message };
}

const str = (v: unknown, name: string, max = 100_000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new PermanentError(`input.${name} is required`);
  return v.slice(0, max);
};

const tokens = (u: Usage | undefined) => ({ input_units: u?.prompt_tokens, output_units: u?.completion_tokens });

/** Text to vectors, for finding knowledge by meaning. Input: { texts: string[] } or { text }. */
async function embeddings(t: Target, input: Input): Promise<RunOutput> {
  const texts = Array.isArray(input.texts) ? input.texts.map((x, i) => str(x, `texts[${i}]`, 20_000)) : [str(input.text, 'text', 20_000)];
  if (!texts.length || texts.length > 256) throw new PermanentError('input.texts takes 1 to 256 texts');
  const data = await post(t, '/embeddings', { model: t.model, input: texts, ...extras(t) });
  const vectors: number[][] = (data.data ?? []).sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
  if (vectors.length !== texts.length) throw new Error('provider returned a different number of vectors');
  return { result: { dimensions: vectors[0]?.length ?? 0, vectors }, input_units: data.usage?.prompt_tokens, cost: costOf(t, data.usage) };
}

/** Orders documents by how well they answer a query. Input: { query, documents: string[], top_n? }. */
async function reranker(t: Target, input: Input): Promise<RunOutput> {
  const documents = Array.isArray(input.documents) ? input.documents.map((x, i) => str(x, `documents[${i}]`, 20_000)) : [];
  if (!documents.length || documents.length > 1000) throw new PermanentError('input.documents takes 1 to 1000 texts');
  const topN = Number.isInteger(input.top_n) ? Math.min(Math.max(Number(input.top_n), 1), documents.length) : documents.length;
  const data = await post(t, '/rerank', { model: t.model, query: str(input.query, 'query', 5_000), documents, top_n: topN, ...extras(t) });
  const results = (data.results ?? [])
    .map((r: any) => ({ index: r.index, score: r.relevance_score ?? r.score }))
    .sort((a: any, b: any) => b.score - a.score);
  return { result: { results }, input_units: data.usage?.prompt_tokens ?? data.usage?.total_tokens, cost: costOf(t, data.usage) };
}

/** Flags unsafe text (Llama Guard style: "safe", or "unsafe" and category codes). Input: { text }. */
async function moderation(t: Target, input: Input): Promise<RunOutput> {
  const { text, usage } = await chat(t, str(input.text, 'text', 20_000), { max_tokens: 20, temperature: 0 });
  const lines = text.trim().split(/\s*\n\s*/);
  const flagged = lines[0]?.toLowerCase() === 'unsafe';
  const categories = flagged ? (lines[1] ?? '').split(/[,\s]+/).filter(Boolean) : [];
  return { result: { flagged, categories, raw: text.slice(0, 200) }, ...tokens(usage), cost: costOf(t, usage) };
}

/** Describes or answers a question about an image. Input: { image_url, prompt? }. */
async function vision(t: Target, input: Input): Promise<RunOutput> {
  const prompt = typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.slice(0, 5_000) : 'Describe this image.';
  const { text, usage } = await chat(t, [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: str(input.image_url, 'image_url', 10_000_000) } },
  ]);
  return { result: { text }, ...tokens(usage), cost: costOf(t, usage) };
}

/** A PDF or scan to text (Markdown). Input: { url, filename?, prompt? }. */
async function documentParsing(t: Target, input: Input): Promise<RunOutput> {
  const url = str(input.url, 'url', 10_000_000);
  const filename = typeof input.filename === 'string' ? input.filename.slice(0, 200) : (url.split('?')[0].split('/').pop() || 'document');
  const pdf = /\.pdf$/i.test(filename) || url.startsWith('data:application/pdf');
  const prompt = typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.slice(0, 5_000) : 'Extract all the text of this document as Markdown, keeping headings and tables.';
  const file = pdf ? { type: 'file', file: { filename, file_data: url } } : { type: 'image_url', image_url: { url } };
  const { text, usage } = await chat(t, [{ type: 'text', text: prompt }, file]);
  return { result: { text }, ...tokens(usage), cost: costOf(t, usage) };
}

/** Audio to text. Input: { audio_url, language? }; the worker downloads the audio (up to 25 MB). */
async function speechToText(t: Target, input: Input): Promise<RunOutput> {
  const url = str(input.audio_url, 'audio_url', 2_000);
  const audio = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!audio.ok) throw new PermanentError(`the audio could not be downloaded (${audio.status})`);
  const bytes = await audio.arrayBuffer();
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new PermanentError('the audio is larger than 25 MB');
  const form = new FormData();
  form.append('model', t.model);
  form.append('file', new Blob([bytes], { type: audio.headers.get('content-type') ?? 'audio/mpeg' }), url.split('?')[0].split('/').pop() || 'audio');
  if (typeof input.language === 'string') form.append('language', input.language.slice(0, 10));
  const res = await fetch(`${baseUrl(t)}/audio/transcriptions`, { method: 'POST', headers: headers(t, false), body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new ProviderError(res.status, await res.text().then((s) => s.slice(0, 200)).catch(() => undefined));
  const data: any = await res.json();
  const seconds = typeof data.usage?.seconds === 'number' ? data.usage.seconds : typeof data.duration === 'number' ? data.duration : undefined;
  return { result: { text: data.text ?? '', ...(seconds !== undefined ? { seconds } : {}) }, input_units: seconds !== undefined ? Math.round(seconds) : undefined, cost: costOf(t, data.usage) };
}

/** A picture from a prompt. Input: { prompt, size? }. OpenRouter returns it from chat; others use /images/generations. */
async function imageGeneration(t: Target, input: Input): Promise<RunOutput> {
  const prompt = str(input.prompt, 'prompt', 5_000);
  if (t.kind === 'openrouter') {
    const { message, text, usage } = await chat(t, prompt, { modalities: ['image', 'text'] });
    const images = (message.images ?? []).map((i: any) => i.image_url?.url).filter(Boolean);
    if (!images.length) throw new Error('the model returned no image');
    return { result: { images, text }, ...tokens(usage), cost: costOf(t, usage) };
  }
  const data = await post(t, '/images/generations', { model: t.model, prompt, n: 1, ...(typeof input.size === 'string' ? { size: input.size } : {}), response_format: 'b64_json' });
  const images = (data.data ?? []).map((d: any) => (d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url)).filter(Boolean);
  if (!images.length) throw new Error('the model returned no image');
  return { result: { images }, cost: costOf(t, data.usage) };
}

export const RUNNERS: Partial<Record<string, (t: Target, input: Input) => Promise<RunOutput>>> = {
  embeddings,
  reranker,
  moderation,
  vision,
  document_parsing: documentParsing,
  speech_to_text: speechToText,
  image_generation: imageGeneration,
};
