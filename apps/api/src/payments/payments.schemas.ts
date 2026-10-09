import { z } from 'zod';

const money = z.coerce.number().positive().multipleOf(0.01).max(1_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/);
const isoDateTime = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const common = {
  customer_id: z.string().uuid(),
  appointment_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  amount: money,
  currency: currency.optional(),
  notes_internal: z.string().max(2000).optional(),
  /** Set after the API reported possible duplicates and the user confirmed it is a new payment. */
  confirm_duplicate: z.boolean().optional(),
};

/** Manual payment entry by staff (plan.md §4.4). Stripe payments never come through here. */
export const createManualPaymentSchema = z.discriminatedUnion('method', [
  z
    .object({
      ...common,
      method: z.literal('card_pos'),
      paid_at: isoDateTime,
      pos_reference: z.string().trim().min(1).max(100),
      pos_terminal_id: z.string().trim().min(1).max(50).optional(),
      card_brand: z.string().trim().max(20).optional(),
      card_last4: z.string().regex(/^\d{4}$/).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      method: z.literal('bank_transfer'),
      // Either already received (reference + paid_at) or expected (expected_at).
      bank_reference: z.string().trim().min(1).max(100).optional(),
      paid_at: isoDateTime.optional(),
      expected_at: isoDate.optional(),
    })
    .strict(),
  z
    .object({ ...common, method: z.literal('cash'), paid_at: isoDateTime, receipt_number: z.string().max(50).optional() })
    .strict(),
  z.object({ ...common, method: z.literal('other'), paid_at: isoDateTime, description: z.string().min(1).max(500) }).strict(),
]).superRefine((b, ctx) => {
  // A bank transfer is either already received (reference + date) or expected (pending).
  if (b.method !== 'bank_transfer') return;
  const received = Boolean(b.bank_reference && b.paid_at);
  const expected = !b.bank_reference && !b.paid_at && Boolean(b.expected_at);
  if (!received && !expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provide bank_reference + paid_at (received) or expected_at (pending)' });
  }
});
export type CreateManualPayment = z.infer<typeof createManualPaymentSchema>;

export const duplicateCheckSchema = z
  .object({
    customer_id: z.string().uuid(),
    amount: money,
    on: z.union([isoDateTime, isoDate]).optional(),
  })
  .strict();
export type DuplicateCheck = z.infer<typeof duplicateCheckSchema>;

export const updateManualPaymentSchema = z
  .object({
    amount: money,
    paid_at: isoDateTime,
    appointment_id: z.string().uuid().nullable(),
    pos_reference: z.string().trim().min(1).max(100),
    pos_terminal_id: z.string().trim().min(1).max(50).nullable(),
    card_brand: z.string().trim().max(20).nullable(),
    card_last4: z.string().regex(/^\d{4}$/).nullable(),
    bank_reference: z.string().trim().min(1).max(100),
    expected_at: isoDate.nullable(),
    notes_internal: z.string().max(2000).nullable(),
  })
  .partial()
  .strict();
export type UpdateManualPayment = z.infer<typeof updateManualPaymentSchema>;

export const markReceivedSchema = z.object({ bank_reference: z.string().trim().min(1).max(100), paid_at: isoDateTime }).strict();
export const voidSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const refundSchema = z.object({ amount: money, reason: z.string().trim().min(3).max(500) }).strict();

export const listSchema = z
  .object({
    customer_id: z.string().uuid().optional(),
    status: z.string().optional(),
    source: z.enum(['stripe', 'manual']).optional(),
    method: z.string().optional(),
    unmatched: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListPayments = z.infer<typeof listSchema>;
