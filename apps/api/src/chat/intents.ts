/**
 * Deterministic intent rules for the most common questions (plan.md §6: E2B leans on deterministic
 * paths). When a rule matches, tools run without asking the model to plan; otherwise Gemma 4
 * plans with tool calling.
 */
import type { ToolName } from './tools';

export interface PlannedCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

const has = (t: string, re: RegExp) => re.test(t);

export function planByRules(
  text: string,
  ctx: { audience: 'employee' | 'customer'; hasCustomerScope: boolean; hasOrgScope: boolean; range?: { from: string; to: string } },
): PlannedCall[] {
  const t = text.toLowerCase();
  const range = ctx.range ? { from: ctx.range.from, to: ctx.range.to } : {};
  const calls: PlannedCall[] = [];

  if (ctx.audience === 'employee' && has(t, /\bmy (schedule|appointments|day|calendar)\b|\bam i (booked|busy|working)\b/)) {
    calls.push({ tool: 'get_my_schedule', args: range });
  }
  if (ctx.audience === 'employee' && has(t, /\b(pending|overdue|unreceived|outstanding) (bank )?transfers?\b|\btransfers? (pending|overdue)\b/)) {
    calls.push({ tool: 'list_pending_bank_transfers', args: { overdue_only: has(t, /\boverdue\b/) } });
  }
  if (ctx.audience === 'employee' && has(t, /\bunmatched\b.*\b(stripe|payments?)\b|\bunassigned payments?\b/)) {
    calls.push({ tool: 'list_unmatched_stripe_payments', args: {} });
  }
  if (calls.length > 0) return calls;

  const customerScoped = ctx.audience === 'customer' || ctx.hasCustomerScope || ctx.hasOrgScope;
  if (customerScoped) {
    if (has(t, /\b(appointment|appointments|booking|booked|schedule|visit|session)s?\b/)) {
      calls.push({ tool: 'list_appointments', args: { ...range, upcoming_only: !ctx.range && has(t, /\b(next|upcoming|coming|future)\b/) } });
    }
    if (has(t, /\b(owe|balance|outstanding|unpaid|due)\b/)) {
      calls.push({ tool: 'get_balance', args: {} });
    }
    if (has(t, /\b(pay|paid|payment|payments|charge|charged|refund|refunded|transfer|receipt|card)\b/)) {
      calls.push({ tool: 'list_payments', args: range });
    }
    if (has(t, /\b(tickets?|support (cases?|requests?)|cases?|complaints?|issues?)\b/)) {
      const ticketNo = /#(\d{1,12})\b/.exec(t);
      calls.push(ticketNo ? { tool: 'get_ticket', args: { ticket_id: ticketNo[1] } } : { tool: 'list_tickets', args: {} });
    }
    if (ctx.hasOrgScope && has(t, /\b(members?|employees|people|staff of)\b/)) {
      calls.push({ tool: 'list_organization_members', args: {} });
    }
    if (calls.length === 0 && has(t, /\b(profile|details|contact|email|phone|address|who is|info)\b/)) {
      calls.push({ tool: 'get_customer_profile', args: {} });
    }
  }
  if (has(t, /\b(price|prices|cost|costs|how much|services?|offer|menu)\b/) && !calls.some((c) => c.tool === 'get_balance')) {
    calls.push({ tool: 'list_services', args: {} });
  }
  if (has(t, /\b(location|locations|address|where are you|branch|branches|open hours|opening)\b/)) {
    calls.push({ tool: 'list_locations', args: {} });
  }
  return calls;
}
