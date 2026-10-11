import { describe, expect, it } from 'vitest';
import { extractIdentifiers, normalizePhone } from '../src/chat/extraction';
import { ungroundedFacts } from '../src/chat/grounding';
import { customerSearch, planByRules } from '../src/chat/intents';
import { formatLocal, offsetMinutes, parseRelativeRange, zonedMidnight } from '../src/chat/time';
import { evidenceBlock } from '../src/chat/prompts';
import { validateArgs } from '../src/chat/tools';

describe('time zones', () => {
  it('computes offsets across daylight saving time', () => {
    expect(offsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/New_York')).toBe(-240);
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(offsetMinutes(new Date('2026-07-01T12:00:00Z'), 'Asia/Kolkata')).toBe(330);
  });

  it('finds local midnight, including DST change days', () => {
    expect(zonedMidnight(2026, 3, 8, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z'); // spring forward
    expect(zonedMidnight(2026, 11, 1, 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z'); // fall back
    expect(zonedMidnight(2026, 7, 1, 'America/Los_Angeles').toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('resolves relative dates in the principal’s zone', () => {
    // 2026-10-09 02:00 UTC is still Oct 8 in New York.
    const now = new Date('2026-10-09T02:00:00Z');
    expect(parseRelativeRange('what about tomorrow?', 'America/New_York', now)).toEqual({
      from: '2026-10-09T04:00:00.000Z',
      to: '2026-10-10T04:00:00.000Z',
      label: 'tomorrow',
    });
    expect(parseRelativeRange('payments last month', 'America/New_York', now)).toMatchObject({
      from: '2026-09-01T04:00:00.000Z',
      to: '2026-10-01T04:00:00.000Z',
    });
    // Thursday Oct 8 → "this week" starts Monday Oct 5.
    expect(parseRelativeRange('my schedule this week', 'America/New_York', now)?.from).toBe('2026-10-05T04:00:00.000Z');
    expect(parseRelativeRange('on friday', 'America/New_York', now)?.from).toBe('2026-10-09T04:00:00.000Z');
    expect(parseRelativeRange('hello', 'America/New_York', now)).toBeUndefined();
  });

  it('formats times with the zone label', () => {
    expect(formatLocal('2026-10-10T19:00:00Z', 'America/New_York')).toBe('Sat, Oct 10, 2026, 3:00 PM EDT');
  });
});

describe('identifier extraction', () => {
  it('finds exact identifiers', () => {
    const ids = extractIdentifiers('Payments for C-10432 and maria@Example.com, call (212) 555-0101 about A-2026-000123 / P-2026-000004');
    expect(ids.customerNumbers).toEqual(['C-10432']);
    expect(ids.emails).toEqual(['maria@example.com']);
    expect(ids.phones).toEqual(['+12125550101']);
    expect(ids.appointmentNumbers).toEqual(['A-2026-000123']);
    expect(ids.paymentNumbers).toEqual(['P-2026-000004']);
  });

  it('finds likely names but not question words', () => {
    expect(extractIdentifiers("Show me Maria Lopez's unpaid appointments").names).toEqual(['Maria Lopez']);
    expect(extractIdentifiers('What are Acme Corp open tickets?').names).toEqual(['Acme Corp']);
    expect(extractIdentifiers('When is my next appointment?').names).toEqual([]);
  });

  it('normalizes phones to E.164', () => {
    expect(normalizePhone('212-555-0101')).toBe('+12125550101');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('555-0101')).toBeUndefined();
  });
});

describe('intent rules', () => {
  const customer = { audience: 'customer' as const, hasCustomerScope: true, hasOrgScope: false };
  it('maps common customer questions to tools', () => {
    expect(planByRules('When is my next appointment?', customer).map((c) => c.tool)).toEqual(['list_appointments']);
    expect(planByRules('Was my bank transfer received?', customer).map((c) => c.tool)).toEqual(['list_payments']);
    expect(planByRules('How much do I owe?', customer).map((c) => c.tool)).toEqual(['get_balance']);
    expect(planByRules('How much is a haircut?', customer).map((c) => c.tool)).toEqual(['list_services']);
  });

  it('understands casual wording', () => {
    expect(planByRules('Am I all square with you?', customer).map((c) => c.tool)).toEqual(['get_balance']);
    expect(planByRules('How did I settle up for my last haircut?', customer).map((c) => c.tool)).toEqual(['list_payments']);
    expect(planByRules('Has support gotten back to me?', customer).map((c) => c.tool)).toEqual(['list_tickets']);
    expect(planByRules('What payment methods do you support?', customer).map((c) => c.tool)).toEqual(['list_payments']);
    const staff = { audience: 'employee' as const, hasCustomerScope: false, hasOrgScope: false };
    expect(planByRules('Who am I seeing in the next few days?', staff).map((c) => c.tool)).toEqual(['get_my_schedule']);
    expect(planByRules('Who still has not paid by transfer?', staff).map((c) => c.tool)).toEqual(['list_pending_bank_transfers']);
    expect(planByRules('Any card payments we could not match to a customer?', staff).map((c) => c.tool)).toEqual(['list_unmatched_stripe_payments']);
    expect(planByRules('What does my team have scheduled with you?', { ...customer, hasOrgScope: true }).map((c) => c.tool)).toEqual(['list_appointments']);
  });

  it('gives employees their schedule and worklists', () => {
    const staff = { audience: 'employee' as const, hasCustomerScope: false, hasOrgScope: false };
    expect(planByRules("What's on my schedule tomorrow?", staff).map((c) => c.tool)).toEqual(['get_my_schedule']);
    expect(planByRules('Any overdue bank transfers?', staff)).toEqual([{ tool: 'list_pending_bank_transfers', args: { overdue_only: true } }]);
    expect(planByRules('Show unmatched Stripe payments', staff).map((c) => c.tool)).toEqual(['list_unmatched_stripe_payments']);
  });

  it('tells a customer search from a question about one customer', () => {
    expect(customerSearch('do we have any customers named Maria?')).toBe('Maria');
    expect(customerSearch('Any clients called Daniel Park?')).toBe('Daniel Park');
    expect(customerSearch('find customers named lopez')).toBe('lopez');
    expect(customerSearch('Search for customer Park')).toBe('Park');
    expect(customerSearch("Show me Maria Lopez's appointments")).toBeUndefined();
    expect(customerSearch('Appointments for Daniel Park')).toBeUndefined();
  });

  it('does not run customer tools for employees without a customer in scope', () => {
    expect(planByRules('show appointments', { audience: 'employee', hasCustomerScope: false, hasOrgScope: false })).toEqual([]);
  });
});

describe('tool argument validation', () => {
  it('rejects unknown arguments (the model cannot choose whose data)', () => {
    expect(() => validateArgs('list_payments', { customer_id: '4000' })).toThrow(/unknown argument customer_id/);
  });
  it('checks types, enums and formats', () => {
    expect(() => validateArgs('list_appointments', { status: 'whatever' })).toThrow(/one of/);
    expect(() => validateArgs('get_appointment', { appointment_number: 'DROP TABLE' })).toThrow(/invalid format/);
    expect(() => validateArgs('list_payments', { from: 'yesterday-ish' })).toThrow(/date/);
    expect(validateArgs('list_appointments', { upcoming_only: true })).toEqual({ upcoming_only: true });
  });
});

describe('evidenceBlock', () => {
  it('never puts internal customer ids in the prompt', () => {
    const block = evidenceBlock([
      { type: 'appointment', id: 'A-2026-000001', title: 'Haircut', customerId: '40000000-0000-4000-8000-000000000001', fields: { status: 'scheduled' } },
    ]);
    expect(block).toContain('A-2026-000001');
    expect(block).not.toContain('40000000-0000-4000-8000-000000000001');
  });

  it('keeps saved answers\' internal ids out of the prompt', () => {
    const block = evidenceBlock([{ type: 'answer', id: 'b0000000-0000-4000-8000-000000000001', title: 'Rescheduling', fields: { approved_answer: 'Cancel 24 hours ahead.' } }]);
    expect(block).toContain('type="answer"');
    expect(block).not.toContain('b0000000-0000-4000-8000-000000000001');
  });
});

describe('grounding check', () => {
  const appointment = {
    type: 'appointment' as const,
    id: 'A-2026-000002',
    title: 'Haircut — Mon, Oct 12, 2026, 8:06 PM EDT',
    fields: { status: 'scheduled', price: '$50.00', payment: 'P-2026-000001' },
  };
  it('passes answers whose years, times, amounts and numbers come from the records', () => {
    expect(ungroundedFacts('Your Haircut is on Monday, October 12, 2026, at 8:06 PM EDT for $50 [1].', [appointment], 'When is my next appointment?')).toEqual([]);
    expect(ungroundedFacts('A-2026-000002 was paid with P-2026-000001 [1].', [appointment], 'Show A-2026-000002')).toEqual([]);
    // Numbers from the question may be repeated ("I can't find P-2026-000009").
    expect(ungroundedFacts('There are no records for payment P-2026-000009.', [], 'Show payment P-2026-000009')).toEqual([]);
  });
  it('flags invented details', () => {
    const customer = { type: 'customer' as const, id: 'C-10005', title: 'Rita Reyes', fields: { status: 'active' } };
    expect(ungroundedFacts('Rita Reyes has an appointment for a massage on 2023-10-27 at 10:00 AM [1].', [customer], 'find customer rita reyes')).toEqual(['10:00 AM', '2023']);
    expect(ungroundedFacts('Your Haircut costs $65.00 [1].', [appointment], 'How much?')).toEqual(['$65.00']);
    expect(ungroundedFacts('See ticket #5009 [1].', [appointment], 'Any tickets?')).toEqual(['#5009']);
  });
});
