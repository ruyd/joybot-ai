import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, fullName } from '../../lib/format';
import { CustomerPicker, type Customer } from './CustomerPicker';

interface Summary extends Customer {
  email_verified: boolean;
  phone_verified: boolean;
  has_login: boolean;
  has_stripe: boolean;
  created_at: string;
}

interface LinkReview {
  id: string;
  reason: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  resolved_by_name: string | null;
  matched_on: 'email' | 'phone' | null;
  candidate: Summary | null;
  account: Summary | null;
  actions: ('link' | 'merge' | 'reject')[];
}

interface DuplicatePair {
  reason: 'same_name' | 'same_last_name_and_birth_date';
  customers: [Summary, Summary];
}

interface MergePreview {
  source: Summary;
  target: Summary;
  moves: { appointments: number; payments: number };
  filled: string[];
  dropped: string[];
  blockers: string[];
}

const REASON: Record<string, string> = {
  contact_linked_to_other_login: 'Signed up with a contact that already belongs to another login',
  contacts_match_different_customers: 'Email and phone match two different customers',
  candidate_blocked: 'Signed up with the contact of a blocked customer',
  invite_accepted_by_other_account: 'Accepted an invite while signed in with a different account',
  same_name: 'Same name',
  same_last_name_and_birth_date: 'Same last name and date of birth',
};

const FIELD: Record<string, string> = {
  first_name: 'first name',
  last_name: 'last name',
  email: 'email',
  phone: 'phone',
  organization_id: 'organization',
  preferred_location_id: 'preferred location',
};

/** Admin worklist: sign-ups waiting to be linked, and likely duplicate customers. */
export function Review() {
  return (
    <Page>
      <PageHeader title="Review" description="Portal sign-ups that need a decision, and customers that may be the same person." />
      <div className="grid gap-4">
        <LinkReviews />
        <Duplicates />
      </div>
    </Page>
  );
}

function CustomerCell({ c, label }: { c: Summary | null; label: string }) {
  if (!c) return <p className="text-sm text-slate-500">{label}: not found</p>;
  return (
    <div className="min-w-0 text-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <Link to={`/staff/customers/${c.id}`} className="font-medium text-brand-600 hover:underline">
        {fullName(c)}
      </Link>{' '}
      <span className="text-slate-500">· {c.customer_number}</span>
      <p className="truncate text-slate-500">{[c.email, c.phone].filter(Boolean).join(' · ') || 'no contact'}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {c.has_login ? <Badge tone="green">portal login</Badge> : <Badge>no login</Badge>}
        {c.status !== 'active' && <Badge tone="red">{c.status}</Badge>}
        {c.restricted && <Badge tone="red">restricted</Badge>}
      </div>
    </div>
  );
}

function LinkReviews() {
  const api = useApi();
  const [status, setStatus] = useState('open');
  const reviews = useQuery({ queryKey: ['link-reviews', status], queryFn: () => api.get<LinkReview[]>(`/link-reviews?status=${status}`) });
  return (
    <Card
      title="Sign-ups to review"
      actions={
        <div className="w-36">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="py-1">
            <option value="open">Open</option>
            <option value="linked">Linked</option>
            <option value="merged">Merged</option>
            <option value="rejected">Rejected</option>
          </Select>
        </div>
      }
    >
      {reviews.isLoading ? (
        <Spinner />
      ) : reviews.error ? (
        <ErrorBanner error={reviews.error} />
      ) : !reviews.data?.length ? (
        <EmptyState>{status === 'open' ? 'Nothing to review.' : 'None yet.'}</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {reviews.data.map((r) => (
            <li key={r.id} className="py-3 first:pt-0 last:pb-0">
              <ReviewRow review={r} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReviewRow({ review: r }: { review: LinkReview }) {
  const api = useApi();
  const qc = useQueryClient();
  const [target, setTarget] = useState<Customer | null>(null);
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: (action: 'link' | 'merge' | 'reject') =>
      api.post(`/link-reviews/${r.id}/resolve`, { action, customer_id: action === 'link' ? (target?.id ?? r.candidate?.id) : undefined, note: note || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['link-reviews'] });
      void qc.invalidateQueries({ queryKey: ['duplicates'] });
    },
  });
  const linkTarget = target ?? (r.candidate && !r.candidate.has_login ? r.candidate : null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{REASON[r.reason] ?? r.reason}</p>
        <span className="text-xs text-slate-500">{dateTime(r.created_at)}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {r.account ? <CustomerCell c={r.account} label="Signed-in account" /> : (
          <div className="text-sm">
            <p className="text-xs uppercase tracking-wide text-slate-500">New login</p>
            <p>Verified {r.matched_on ?? 'contact'} matches the customer on the right. No customer record yet.</p>
          </div>
        )}
        <CustomerCell c={r.candidate} label={r.account ? 'Invited customer' : 'Matching customer'} />
      </div>

      {r.status === 'open' ? (
        <div className="space-y-2">
          {r.actions.includes('link') && (
            <Field label="Link the new login to" hint="Only a customer without a portal login. Confirm the person's identity first (for example by phone).">
              <CustomerPicker value={linkTarget} onChange={setTarget} />
            </Field>
          )}
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional): how you checked" aria-label="Note" />
          <div className="flex flex-wrap gap-2">
            {r.actions.includes('link') && (
              <Button size="sm" disabled={!linkTarget || resolve.isPending} onClick={() => resolve.mutate('link')}>
                Link login{linkTarget ? ` to ${fullName(linkTarget)}` : ''}
              </Button>
            )}
            {r.actions.includes('merge') && (
              <Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate('merge')}>
                Merge account into invited customer
              </Button>
            )}
            <Button size="sm" variant="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate('reject')}>
              Reject
            </Button>
          </div>
          {resolve.error && <ErrorBanner error={resolve.error} />}
        </div>
      ) : (
        <p className="text-sm text-slate-500">
          {r.status} {r.resolved_by_name ? `by ${r.resolved_by_name}` : ''} {r.resolved_at ? `· ${dateTime(r.resolved_at)}` : ''}
          {r.resolution_note ? ` · “${r.resolution_note}”` : ''}
        </p>
      )}
    </div>
  );
}

/** Default direction: keep the record with a portal login, otherwise the older one. */
function keepFirst([a, b]: [Summary, Summary]): { source: Summary; target: Summary } {
  const keepA = a.has_login !== b.has_login ? a.has_login : a.created_at <= b.created_at;
  return keepA ? { source: b, target: a } : { source: a, target: b };
}

function Duplicates() {
  const api = useApi();
  const qc = useQueryClient();
  const [merging, setMerging] = useState<DuplicatePair | null>(null);
  const pairs = useQuery({ queryKey: ['duplicates'], queryFn: () => api.get<DuplicatePair[]>('/duplicates') });
  const dismiss = useMutation({
    mutationFn: (p: DuplicatePair) => api.post('/duplicates/dismiss', { customer_ids: p.customers.map((c) => c.id) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['duplicates'] }),
  });
  return (
    <Card title="Possible duplicates">
      {pairs.isLoading ? (
        <Spinner />
      ) : pairs.error ? (
        <ErrorBanner error={pairs.error} />
      ) : !pairs.data?.length ? (
        <EmptyState>No likely duplicates.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {pairs.data.map((p) => {
            const key = p.customers.map((c) => c.id).join();
            const open = merging && merging.customers.map((c) => c.id).join() === key;
            return (
              <li key={key} className="space-y-3 py-3 first:pt-0 last:pb-0">
                <p className="text-sm font-medium">{REASON[p.reason]}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <CustomerCell c={p.customers[0]} label="Customer" />
                  <CustomerCell c={p.customers[1]} label="Customer" />
                </div>
                {open ? (
                  <MergePanel
                    {...keepFirst(p.customers)}
                    onDone={() => {
                      setMerging(null);
                      void qc.invalidateQueries({ queryKey: ['duplicates'] });
                    }}
                    onCancel={() => setMerging(null)}
                  />
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setMerging(p)}>Merge…</Button>
                    <Button size="sm" variant="secondary" disabled={dismiss.isPending} onClick={() => dismiss.mutate(p)}>
                      Not the same person
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {dismiss.error && <ErrorBanner error={dismiss.error} />}
    </Card>
  );
}

/**
 * Pick which record survives, review what moves, give a reason, merge. The other record is
 * hidden afterwards; its appointments, payments, login and chats move to the surviving one.
 */
export function MergePanel({
  source: initialSource,
  target: initialTarget,
  onDone,
  onCancel,
}: {
  source: Customer;
  target: Customer | null;
  onDone: (survivor: Customer) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [pair, setPair] = useState<[Customer, Customer | null]>([initialSource, initialTarget]);
  const [reason, setReason] = useState('');
  const [source, target] = pair;
  const preview = useQuery({
    queryKey: ['merge-preview', source.id, target?.id],
    enabled: Boolean(target),
    queryFn: () => api.get<MergePreview>(`/customers/${source.id}/merge-preview?into=${target!.id}`),
  });
  const merge = useMutation({
    mutationFn: () => api.post<Customer>(`/customers/${source.id}/merge`, { into: target!.id, reason }),
    onSuccess: (survivor) => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['customer'] });
      onDone(survivor);
    },
  });
  const p = preview.data;
  const blocked = Boolean(p?.blockers.length);

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      {initialTarget ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Keep <strong>{target ? fullName(target) : ''}</strong> ({target?.customer_number}); merge <strong>{fullName(source)}</strong> ({source.customer_number}) into it.
          </span>
          <Button size="sm" variant="ghost" onClick={() => target && setPair([target, source])}>Swap</Button>
        </div>
      ) : (
        <Field label={`Merge ${fullName(source)} (${source.customer_number}) into`} hint="The customer you pick is kept; this one is hidden.">
          <CustomerPicker value={target} onChange={(c) => setPair([source, c && c.id !== source.id ? c : null])} />
        </Field>
      )}

      {preview.isLoading && <Spinner label="Checking" />}
      {preview.error && <ErrorBanner error={preview.error} />}
      {p && (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            Moves {p.moves.appointments} appointment{p.moves.appointments === 1 ? '' : 's'} and {p.moves.payments} payment{p.moves.payments === 1 ? '' : 's'}
            {p.source.has_login ? ', the portal login and its chats' : ''}.
          </li>
          {p.filled.length > 0 && <li>Fills in the kept customer's empty {p.filled.map((f) => FIELD[f] ?? f).join(', ')}.</li>}
          {p.dropped.length > 0 && (
            <li className="text-amber-700 dark:text-amber-300">
              Different {p.dropped.map((f) => FIELD[f] ?? f).join(', ')}: {p.target.customer_number}'s {p.dropped.length === 1 ? 'is' : 'are'} kept; {p.source.customer_number}'s {p.dropped.length === 1 ? 'value is' : 'values are'} only kept in the audit log.
            </li>
          )}
          {p.blockers.map((b) => (
            <li key={b} className="text-red-700 dark:text-red-300">{b}</li>
          ))}
        </ul>
      )}

      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required), e.g. same person, confirmed by phone" aria-label="Reason" />
      <div className="flex gap-2">
        <Button size="sm" variant="danger" disabled={!target || !p || blocked || reason.trim().length < 3 || merge.isPending} onClick={() => merge.mutate()}>
          Merge
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
      {merge.error && <ErrorBanner error={merge.error} />}
    </div>
  );
}

/** "Merge into…" on the customer page (admins). */
export function MergeCard({ customer }: { customer: Customer }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <Card title="Duplicate record?">
      {open ? (
        <MergePanel
          source={customer}
          target={null}
          onCancel={() => setOpen(false)}
          onDone={(survivor) => navigate(`/staff/customers/${survivor.id}`, { replace: true })}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-500">If this is the same person as another customer, merge the two records.</p>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Merge into…</Button>
        </div>
      )}
    </Card>
  );
}
