import { Logger } from '@nestjs/common';
import type { Evidence, ToolName } from '../tools';
import { answerPrompt, evidenceBlock, plannerPrompt } from '../prompts';

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
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

const HISTORY_TURNS = 6;

/** vLLM (AWS) or Ollama (local) through the OpenAI-compatible chat completions API. */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  private readonly logger = new Logger('LlmProvider');

  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
  ) {}

  async plan(input: PlanInput): Promise<PlannedToolCall[]> {
    if (input.tools.length === 0) return [];
    const res = await this.post({
      model: this.model,
      temperature: 0,
      max_tokens: 300,
      tools: input.tools,
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: plannerPrompt(input) },
        ...input.history.slice(-HISTORY_TURNS),
        { role: 'user', content: input.question },
      ],
    });
    const body = (await res.json()) as {
      choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    };
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
        temperature: 0.2,
        max_tokens: 600,
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
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const token = JSON.parse(data).choices?.[0]?.delta?.content;
          if (token) yield token as string;
        } catch {
          // ignore keep-alives and partial lines
        }
      }
    }
  }

  private async post(body: object, signal?: AbortSignal): Promise<Response> {
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
    yield 'Here is what I found:\n';
    for (const [i, e] of input.evidence.entries()) {
      yield `- ${e.title} [${i + 1}]\n`;
    }
  }
}
