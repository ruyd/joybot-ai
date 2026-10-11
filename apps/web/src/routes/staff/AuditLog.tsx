import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Button, Card, EmptyState, ErrorBanner, Field, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';

export interface Change {
  id: string;
  table_name: string;
  row_id: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  changed_at: string;
  changed_by: string | null;
  principal_type: string | null;
  changed_by_name: string | null;
  changed_via: string;
  label: string | null;
  diff: Record<string, unknown>;
}

/** Every audited table, by what people call it. */
const TABLE_LABEL: Record<string, string> = {
  appointments: 'Appointment',
  customers: 'Customer',
  organizations: 'Organization',
  invoices: 'Invoice',
  invoice_lines: 'Invoice line',
  payments: 'Payment',
  tasks: 'To-do',
  working_hours: 'Working hours',
  time_off: 'Time off',
  users: 'Employee',
  user_locations: 'Employee location',
  services: 'Service',
  locations: 'Location',
  settings: 'Settings',
  answers: 'Answer',
  articles: 'Article',
  external_links: 'Linked account',
  role_permissions: 'Permission',
  assignments: 'Assignment',
  record_grants: 'Record access',
  api_tokens: 'Claude token',
};

/** Where a change came from (core.change_log.changed_via). */
const SOURCE_LABEL: Record<string, string> = {
  api: 'App',
  mcp: 'Claude',
  chat: 'Assistant',
  cognito: 'Sign-in',
  worker: 'Background job',
  stripe_webhook: 'Stripe',
  stripe_reconcile: 'Stripe sync',
  seed: 'Sample data',
  migration: 'Upgrade',
  unknown: 'System',
};

const ACTION_LABEL = { INSERT: 'created', UPDATE: 'changed', DELETE: 'deleted' } as const;

/** Where a record can be opened, when the app has a page for it. */
function recordLink(c: Change): string | null {
  if (c.action === 'DELETE') return null;
  if (c.table_name === 'invoices') return `/staff/invoices/${c.row_id}`;
  if (c.table_name === 'customers') return `/staff/customers/${c.row_id}`;
  if (c.table_name === 'tasks') return '/staff/todos';
  return null;
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

export interface AuditFilter {
  via?: string;
  table?: string;
  changed_by?: string;
  row_id?: string;
}

/**
 * The change log, newest first, a page at a time from the server (only the page is loaded), with the
 * total. Rows expand to show what changed; "History" narrows to one record.
 */
export function AuditTable({ filter, pageSize = 25, onHistory }: { filter: AuditFilter; pageSize?: number; onHistory?: (c: Change) => void }) {
  const api = useApi();
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
  const q = useQuery({
    queryKey: ['audit', params.toString()],
    queryFn: () => api.get<{ items: Change[]; total: number }>(`/admin/audit?${params}`),
    placeholderData: keepPreviousData,
  });
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBanner error={q.error} />;
  if (!total) return <EmptyState>No changes.</EmptyState>;
  return (
    <>
      <Table head={['When', 'Change', 'Record', 'By', 'Source', '']}>
        {items.map((c) => {
          const link = recordLink(c);
          const expanded = open === c.id;
          return (
            <Fragment key={c.id}>
              <tr>
                <Td className="whitespace-nowrap text-slate-500">{dateTime(c.changed_at)}</Td>
                <Td>
                  <span className="font-medium">{TABLE_LABEL[c.table_name] ?? c.table_name}</span> {ACTION_LABEL[c.action]}
                  {c.action === 'UPDATE' && <span className="block text-xs text-slate-500">{Object.keys(c.diff).join(', ')}</span>}
                </Td>
                <Td>
                  {link ? (
                    <Link to={link} className="text-brand-700 hover:underline dark:text-brand-600">
                      {c.label ?? 'Open'}
                    </Link>
                  ) : (
                    (c.label ?? <span className="text-slate-400">—</span>)
                  )}
                </Td>
                <Td className="whitespace-nowrap">{c.changed_by_name ?? <span className="text-slate-400">{c.changed_by ? 'Someone' : 'System'}</span>}</Td>
                <Td className="whitespace-nowrap text-slate-500">{SOURCE_LABEL[c.changed_via] ?? c.changed_via}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : c.id)}>
                    {expanded ? 'Hide' : 'Details'}
                  </Button>
                </Td>
              </tr>
              {expanded && (
                <tr>
                  <td colSpan={6} className="bg-slate-50 px-4 py-3 dark:bg-slate-950">
                    <ChangeDetails change={c} />
                    {onHistory && !filter.row_id && (
                      <Button size="sm" variant="secondary" className="mt-3" onClick={() => onHistory(c)}>
                        History of this record
                      </Button>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </Table>
      <div className="mt-3 flex items-center justify-between gap-2 text-sm text-slate-500">
        <span aria-live="polite">
          {offset + 1}–{offset + items.length} of {total.toLocaleString()}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={offset === 0 || q.isFetching} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
            Previous
          </Button>
          <Button size="sm" variant="secondary" disabled={offset + pageSize >= total || q.isFetching} onClick={() => setOffset(offset + pageSize)}>
            Next
          </Button>
        </div>
      </div>
    </>
  );
}

/** Old → new for an update; the record's fields for a create or delete. */
function ChangeDetails({ change: c }: { change: Change }) {
  const entries = Object.entries(c.diff).filter(([k]) => c.action === 'UPDATE' || k !== 'id');
  if (!entries.length) return <p className="text-sm text-slate-500">No field details.</p>;
  return (
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {entries.map(([k, v]) => {
        const change = c.action === 'UPDATE' ? (v as { old: unknown; new: unknown }) : null;
        return (
          <Fragment key={k}>
            <dt className="font-medium text-slate-600 dark:text-slate-300">{k}</dt>
            <dd className="min-w-0 break-words font-mono">
              {change ? (
                <>
                  <span className="text-slate-400 line-through">{show(change.old)}</span> → {show(change.new)}
                </>
              ) : (
                show(v)
              )}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

interface Employee {
  id: string;
  first_name: string;
  last_name: string;
}

/** Admin › Audit log: every change to the business's records, filterable by source, record type and person. */
export function AuditLogPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const filter: AuditFilter = {
    via: params.get('via') ?? undefined,
    table: params.get('table') ?? undefined,
    changed_by: params.get('changed_by') ?? undefined,
    row_id: params.get('row_id') ?? undefined,
  };
  const recordLabel = params.get('record');
  const employees = useQuery({ queryKey: ['employees'], queryFn: () => api.get<Employee[]>('/admin/users?include_inactive=true') });
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  return (
    <Page>
      <PageHeader title="Audit log" description="Every change to this business's records: who made it, when, where from, and what changed." />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Field label="Record type">
            <Select value={filter.table ?? ''} onChange={(e) => set({ table: e.target.value, row_id: null, record: null })}>
              <option value="">All</option>
              {Object.entries(TABLE_LABEL)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Person">
            <Select value={filter.changed_by ?? ''} onChange={(e) => set({ changed_by: e.target.value })}>
              <option value="">Anyone</option>
              {employees.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.first_name} {u.last_name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={filter.via ?? ''} onChange={(e) => set({ via: e.target.value })}>
              <option value="">Any</option>
              {Object.entries(SOURCE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {filter.row_id && (
          <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            History of <span className="font-medium">{recordLabel ?? 'one record'}</span>
            <Button size="sm" variant="ghost" onClick={() => set({ row_id: null, record: null })}>
              Show all
            </Button>
          </p>
        )}
        {/* A new filter starts again from the first page. */}
        <AuditTable
          key={params.toString()}
          filter={filter}
          onHistory={(c) => set({ table: c.table_name, row_id: c.row_id, record: c.label ?? TABLE_LABEL[c.table_name] ?? c.table_name })}
        />
      </Card>
    </Page>
  );
}
