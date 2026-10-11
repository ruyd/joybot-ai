import { date, money } from '../lib/format';
import { Badge } from './ui';

export interface InvoiceLine {
  id: string;
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
  service_id: string | null;
  appointment_id: string | null;
  appointment_number: string | null;
}

export interface InvoicePayment {
  id: string;
  payment_number: string;
  amount: string;
  amount_refunded: string;
  currency: string;
  method: string;
  status: string;
  paid_at: string | null;
  expected_at: string | null;
  bank_reference: string | null;
  created_at: string;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  customer_id: string;
  customer_name: string | null;
  customer_number: string | null;
  location_id: string | null;
  location_name: string | null;
  currency: string;
  status: 'draft' | 'sent' | 'paid' | 'void';
  total: string;
  amount_paid: string;
  balance: string;
  due_on: string | null;
  notes: string | null;
  overdue: boolean;
  sent_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  lines: InvoiceLine[];
  payments?: InvoicePayment[];
  pay?: { card: boolean; bank_transfer_instructions: string | null };
}

/** "Paid", "Overdue", "Due Oct 24", "Draft", "Void" with a matching colour. */
export function InvoiceStatus({ invoice }: { invoice: Pick<Invoice, 'status' | 'overdue' | 'due_on'> }) {
  if (invoice.status === 'paid') return <Badge tone="green">Paid</Badge>;
  if (invoice.status === 'void') return <Badge tone="slate">Void</Badge>;
  if (invoice.status === 'draft') return <Badge tone="slate">Draft</Badge>;
  if (invoice.overdue) return <Badge tone="red">Overdue</Badge>;
  return <Badge tone="amber">{invoice.due_on ? `Due ${date(invoice.due_on)}` : 'Open'}</Badge>;
}

/** The invoice as the customer sees it: lines, totals, what was paid and what is due. */
export function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  const m = (v: string) => money(v, invoice.currency);
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-500">Invoice</dt>
          <dd className="font-medium">{invoice.invoice_number}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Billed to</dt>
          <dd>
            {invoice.customer_name ?? '—'}
            {invoice.customer_number && <span className="text-slate-500"> · {invoice.customer_number}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Issued</dt>
          <dd>{invoice.sent_at ? date(invoice.sent_at) : 'Not sent yet'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Due</dt>
          <dd className={invoice.overdue ? 'font-medium text-red-700 dark:text-red-400' : ''}>{invoice.due_on ? date(invoice.due_on) : '—'}</dd>
        </div>
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th scope="col" className="py-2 font-medium">Description</th>
              <th scope="col" className="py-2 text-right font-medium">Qty</th>
              <th scope="col" className="py-2 text-right font-medium">Price</th>
              <th scope="col" className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => (
              <tr key={l.id} className="border-b border-slate-100 dark:border-slate-800/70">
                <td className="py-2">
                  {l.description}
                  {l.appointment_number && <span className="block text-xs text-slate-500">Appointment {l.appointment_number}</span>}
                </td>
                <td className="py-2 text-right tabular-nums">{Number(l.quantity)}</td>
                <td className="py-2 text-right tabular-nums">{m(l.unit_price)}</td>
                <td className="py-2 text-right tabular-nums">{m(l.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-sm">
            <tr>
              <th scope="row" colSpan={3} className="pt-3 text-right font-medium">Total</th>
              <td className="pt-3 text-right font-semibold tabular-nums">{m(invoice.total)}</td>
            </tr>
            {Number(invoice.amount_paid) > 0 && (
              <tr>
                <th scope="row" colSpan={3} className="pt-1 text-right font-normal text-slate-500">Paid</th>
                <td className="pt-1 text-right tabular-nums text-slate-500">−{m(invoice.amount_paid)}</td>
              </tr>
            )}
            {invoice.status !== 'void' && (
              <tr>
                <th scope="row" colSpan={3} className="pt-1 text-right font-semibold">Amount due</th>
                <td className="pt-1 text-right text-base font-semibold tabular-nums">{m(invoice.balance)}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>
      {invoice.notes && <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">{invoice.notes}</p>}
      {invoice.status === 'void' && invoice.void_reason && <p className="text-sm text-slate-500">Voided: {invoice.void_reason}</p>}
    </div>
  );
}
