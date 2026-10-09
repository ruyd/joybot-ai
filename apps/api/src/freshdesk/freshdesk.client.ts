/**
 * Minimal Freshdesk API v2 client (plan.md §4.5): read-only, Basic auth with the API key,
 * retries on 429 (Retry-After) and transient 5xx, short timeouts.
 */

export interface FreshdeskContact {
  id: number;
}

export interface FreshdeskTicket {
  id: number;
  subject: string;
  status: number;
  priority: number;
  requester_id: number;
  created_at: string;
  updated_at: string;
  description_text?: string;
  type?: string | null;
}

export interface FreshdeskConversation {
  id: number;
  body_text: string;
  private: boolean;
  incoming: boolean;
  user_id: number;
  created_at: string;
}

export class FreshdeskError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5_000;

export class FreshdeskClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async contacts(filter: { email?: string; phone?: string; mobile?: string }): Promise<FreshdeskContact[]> {
    return this.get<FreshdeskContact[]>(`/api/v2/contacts?${new URLSearchParams(filter as Record<string, string>)}`);
  }

  async ticketsByRequester(requesterId: string | number, updatedSince?: string): Promise<FreshdeskTicket[]> {
    const params = new URLSearchParams({ requester_id: String(requesterId), include: 'description', order_by: 'updated_at', per_page: '30' });
    if (updatedSince) params.set('updated_since', updatedSince);
    return this.get<FreshdeskTicket[]>(`/api/v2/tickets?${params}`);
  }

  async ticket(id: string | number): Promise<FreshdeskTicket> {
    return this.get<FreshdeskTicket>(`/api/v2/tickets/${encodeURIComponent(String(id))}`);
  }

  async conversations(id: string | number): Promise<FreshdeskConversation[]> {
    return this.get<FreshdeskConversation[]>(`/api/v2/tickets/${encodeURIComponent(String(id))}/conversations?per_page=50`);
  }

  /** Cheap authenticated call used by "Test connection". */
  async ping(): Promise<void> {
    await this.get('/api/v2/tickets?per_page=1');
  }

  private async get<T>(path: string): Promise<T> {
    const auth = Buffer.from(`${this.apiKey}:X`).toString('base64');
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
          headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) continue;
        throw new FreshdeskError(`Freshdesk unreachable: ${(err as Error).message}`);
      }
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404) throw new FreshdeskError('Not found in Freshdesk', 404);
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt, MAX_RETRY_WAIT_MS));
        continue;
      }
      throw new FreshdeskError(`Freshdesk returned ${res.status}`, res.status);
    }
  }
}

/** Freshdesk stores phones as free text: try the common US/E.164 spellings. */
export function phoneVariants(e164: string): string[] {
  const digits = e164.replace(/\D/g, '');
  const variants = new Set([e164, digits]);
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : undefined;
  if (national) {
    variants.add(national);
    variants.add(`(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`);
    variants.add(`${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`);
    variants.add(`+1 ${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`);
  }
  return [...variants];
}

const STATUS: Record<number, string> = { 2: 'open', 3: 'pending', 4: 'resolved', 5: 'closed' };
const PRIORITY: Record<number, string> = { 1: 'low', 2: 'medium', 3: 'high', 4: 'urgent' };

export const ticketStatus = (s: number) => STATUS[s] ?? 'waiting';
export const ticketPriority = (p: number) => PRIORITY[p] ?? 'medium';
