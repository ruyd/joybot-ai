import { Logger } from '@nestjs/common';
import type { Evidence, ToolName } from '../tools';
import { answerPrompt, evidenceBlock, plannerPrompt, type Lookup } from '../prompts';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlanInput {
  audience: 'employee' | 'customer';
  question: string;
  history: ChatTurn[];
  scopeSummary: string;
  now: string;
  timeZone: string;
  tools: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
}

export interface AnswerInput {
  audience: 'employee' | 'customer';
  businessName: string;
  timeZone: string;
  question: string;
  history: ChatTurn[];
  evidence: Evidence[];
  /** What was looked up and how many records each lookup found (so empty results can be stated plainly). */
  lookups?: Lookup[];
}

export interface PlannedToolCall {
  tool: ToolName;
  args: unknown;
}

export interface LlmProvider {
  readonly name: string;
  /** Picks tools (Gemma 4 tool calling). May return none. */
  plan(input: PlanInput): Promise<PlannedToolCall[]>;
  /** Streams the grounded answer. */
  answer(input: AnswerInput, signal?: AbortSignal): AsyncIterable<string>;
  /** Loads the model ahead of the first question (optional). */
  warmUp?(): Promise<void>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

const HISTORY_TURNS = 6;

/** Turns off Gemma 4's thinking step: `reasoning_effort` for Ollama, `chat_template_kwargs` for vLLM (each ignores the other). */
const NO_THINKING = { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };

/** vLLM (AWS) or Ollama (local) through the OpenAI-compatible chat completions API. */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  private readonly logger = new Logger('LlmProvider');

  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
    /** MODEL_DEBUG: log full requests and responses (local development only). */
    private readonly debug = false,
    /** MODEL_THINKING: where the model may reason first (slower). */
    private readonly thinking: 'off' | 'plan' | 'all' = 'plan',
  ) {}

  private options(step: 'plan' | 'answer') {
    return this.thinking === 'all' || (this.thinking === 'plan' && step === 'plan') ? {} : NO_THINKING;
  }

  async warmUp(): Promise<void> {
    const started = Date.now();
    await this.post({ model: this.model, max_tokens: 1, ...this.options('answer'), messages: [{ role: 'user', content: 'Hi' }] });
    this.logger.log(`model ${this.model} ready (${Date.now() - started} ms)`);
  }

  async plan(input: PlanInput): Promise<PlannedToolCall[]> {
    if (input.tools.length === 0) return [];
    const res = await this.post({
      model: this.model,
      temperature: 0,
      max_tokens: 300,
      ...this.options('plan'),
      tools: input.tools,
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: plannerPrompt(input) },
        ...input.history.slice(-HISTORY_TURNS),
        { role: 'user', content: input.question },
      ],
    });
    const body = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning?: string; tool_calls?: { function: { name: string; arguments: string } }[] } }[];
      usage?: unknown;
    };
    if (this.debug) {
      const m = body.choices?.[0]?.message;
      this.dump('plan response', { tool_calls: m?.tool_calls?.map((c) => c.function), usage: body.usage }, { reasoning: m?.reasoning, content: m?.content });
    }
    const calls = body.choices?.[0]?.message?.tool_calls ?? [];
    return calls.flatMap((c) => {
      try {
        return [{ tool: c.function.name as ToolName, args: JSON.parse(c.function.arguments || '{}') }];
      } catch {
        this.logger.warn(`discarding tool call with invalid JSON arguments: ${c.function.name}`);
        return [];
      }
    });
  }

  async *answer(input: AnswerInput, signal?: AbortSignal): AsyncIterable<string> {
    const res = await this.post(
      {
        model: this.model,
        temperature: 0, // grounded answers: no variety wanted, and fewer invented details
        max_tokens: 600,
        ...this.options('answer'),
        stream: true,
        messages: [
          { role: 'system', content: `${answerPrompt(input)}\n\n${evidenceBlock(input.evidence)}` },
          ...input.history.slice(-HISTORY_TURNS),
          { role: 'user', content: input.question },
        ],
      },
      signal,
    );
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          let delta: { content?: string; reasoning?: string } | undefined;
          try {
            delta = JSON.parse(data).choices?.[0]?.delta;
          } catch {
            continue; // ignore keep-alives and partial lines
          }
          if (delta?.reasoning) reasoning += delta.reasoning;
          if (delta?.content) {
            content += delta.content;
            yield delta.content;
          }
        }
      }
    } finally {
      if (this.debug) this.dump('answer response', {}, { reasoning, content });
    }
  }

  private async post(body: { messages: { role: string; content: string }[]; tools?: PlanInput['tools']; [option: string]: unknown }, signal?: AbortSignal): Promise<Response> {
    if (this.debug) {
      const { messages, tools, ...options } = body;
      this.dump(tools ? 'plan request' : 'answer request', { ...options, tools: tools?.map((t) => t.function.name) });
      for (const m of messages) this.logger.debug(`--- ${m.role} ---\n${m.content}`);
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`model endpoint returned ${res.status}`);
    return res;
  }

  private dump(label: string, data: object, text: Record<string, string | undefined> = {}): void {
    const blocks = Object.entries(text).flatMap(([name, value]) => (value ? [`--- ${name} ---\n${value}`] : []));
    this.logger.debug([`=== ${label} ===`, ...(Object.keys(data).length ? [JSON.stringify(data, null, 2)] : []), ...blocks].join('\n'));
  }
}

/**
 * No model configured (local development without a GPU, tests): no tool planning beyond the
 * deterministic rules, and answers list the records with citations.
 */
export class EvidenceOnlyProvider implements LlmProvider {
  readonly name = 'evidence-only';

  async plan(): Promise<PlannedToolCall[]> {
    return [];
  }

  async *answer(input: AnswerInput): AsyncIterable<string> {
    if (input.evidence.length === 0) {
      yield "I couldn't find any records that answer that.";
      return;
    }
    // An approved answer is the reply; other records are listed after it.
    const answer = input.evidence.findIndex((e) => e.type === 'answer');
    if (answer >= 0) yield `${String(input.evidence[answer].fields.approved_answer)} [${answer + 1}]\n`;
    const rest = input.evidence.map((e, i) => ({ e, n: i + 1 })).filter(({ n }) => n !== answer + 1);
    if (rest.length) yield answer >= 0 ? '\nAlso relevant:\n' : 'Here is what I found:\n';
    for (const { e, n } of rest) {
      yield `- ${e.title} [${n}]\n`;
    }
  }
}
