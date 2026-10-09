import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date, fullName } from '../../lib/format';
import { useMe } from '../../lib/me';
import { CustomerPicker, OrganizationPicker, type Customer, type Organization } from './CustomerPicker';

interface Employee {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  active: boolean;
}

interface Assignment {
  id: string;
  user_id: string;
  user_name: string;
  customer_id: string | null;
  organization_id: string | null;
  customer_name: string | null;
  customer_number: string | null;
  organization_name: string | null;
  org_number: string | null;
  starts_at: string;
  ends_at: string | null;
  active: boolean;
}

interface Grant {
  id: string;
  user_id: string;
  user_name: string;
  granted_by_name: string | null;
  resource: 'customer' | 'organization';
  record_id: string;
  customer_name: string | null;
  customer_number: string | null;
  organization_name: string | null;
  org_number: string | null;
  actions: string[];
  reason: string;
  expires_at: string;
  created_at: string;
}

/** The record an assignment or grant is for, when the card is shown on that record's page. */
export type RecordRef = { kind: 'customer'; customer: Customer } | { kind: 'organization'; organization: Organization };

const MAX_GRANT_DAYS = 90;

/** Admin page: who can see which customers, beyond the usual location rules. */
export function Access() {
  return (
    <Page>
      <PageHeader
        title="Access"
        description="Staff see customers at their locations. Use assignments, temporary access and restricted flags for everything else."
      />
      <div className="grid gap-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <AssignmentsCard />
          <GrantsCard />
        </div>
        <RestrictedCard />
        <StaffPermissionsCard />
      </div>
    </Page>
  );
}

function useEmployees() {
  const api = useApi();
  return useQuery({ queryKey: ['employees', 'active'], queryFn: () => api.get<Employee[]>('/admin/users') });
}

function EmployeeSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const employees = useEmployees();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Employee" required>
      <option value="">Choose an employee…</option>
      {employees.data
        ?.filter((e) => e.role === 'staff')
        .map((e) => (
          <option key={e.id} value={e.id}>
            {fullName(e)}
          </option>
        ))}
    </Select>
  );
}

/** Customer or organization picker, or the fixed record when shown on its page. */
function RecordField({ fixed, onChange }: { fixed?: RecordRef; onChange: (r: RecordRef | null) => void }) {
  const [kind, setKind] = useState<'customer' | 'organization'>('customer');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  useEffect(() => {
    if (fixed) return;
    onChange(kind === 'customer' ? (customer ? { kind, customer } : null) : org ? { kind, organization: org } : null);
  }, [fixed, kind, customer, org, onChange]);
  if (fixed) return null;
  return (
    <Field label="For">
      <div className="mb-2 flex gap-1">
        {(['customer', 'organization'] as const).map((k) => (
          <Button key={k} type="button" size="sm" variant={kind === k ? 'primary' : 'secondary'} onClick={() => setKind(k)}>
            {k === 'customer' ? 'Customer' : 'Organization'}
          </Button>
        ))}
      </div>
      {kind === 'customer' ? <CustomerPicker value={customer} onChange={setCustomer} /> : <OrganizationPicker value={org} onChange={setOrg} />}
    </Field>
  );
}

function recordLabel(r: Pick<Assignment, 'customer_id' | 'customer_name' | 'customer_number' | 'organization_id' | 'organization_name' | 'org_number'>) {
  if (r.customer_id) {
    return (
      <Link to={`/staff/customers/${r.customer_id}`} className="text-brand-600 hover:underline">
        {r.customer_name ?? r.customer_number ?? 'Customer'}
      </Link>
    );
  }
  return (
    <span>
      {r.organization_name ?? 'Organization'} <span className="text-slate-500">· organization</span>
    </span>
  );
}

const filterFor = (fixed?: RecordRef) =>
  !fixed ? '' : fixed.kind === 'customer' ? `customer_id=${fixed.customer.id}` : `organization_id=${fixed.organization.id}`;

// Assignments -------------------------------------------------------------------------------

/** Staff assigned to a customer or organization see it (even when restricted) until the assignment ends. */
export function AssignmentsCard({ fixed }: { fixed?: RecordRef }) {
  const api = useApi();
  const qc = useQueryClient();
  const { can } = useMe();
  const [userId, setUserId] = useState('');
  const [record, setRecord] = useState<RecordRef | null>(fixed ?? null);
  const [until, setUntil] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['assignments', filterFor(fixed)], queryFn: () => api.get<Assignment[]>(`/admin/assignments?${filterFor(fixed)}`) });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['assignments'] });
    void qc.invalidateQueries({ queryKey: ['access'] });
  };
  const create = useMutation({
    mutationFn: () =>
      api.post('/admin/assignments', {
        user_id: userId,
        ...(record!.kind === 'customer' ? { customer_id: record!.customer.id } : { organization_id: record!.organization.id }),
        ...(until ? { ends_at: new Date(`${until}T23:59:59`).toISOString() } : {}),
      }),
    onSuccess: () => {
      setAdding(false);
      setUserId('');
      setUntil('');
      done();
    },
  });
  const end = useMutation({ mutationFn: (id: string) => api.post(`/admin/assignments/${id}/end`), onSuccess: done });
  const canEdit = can('update', 'access');

  return (
    <Card
      title="Assignments"
      actions={canEdit && !adding && <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Assign staff</Button>}
    >
      {adding && (
        <form
          className="mb-4 space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Employee">
            <EmployeeSelect value={userId} onChange={setUserId} />
          </Field>
          <RecordField fixed={fixed} onChange={setRecord} />
          <Field label="Until (optional)" hint="Leave empty to keep the assignment until you end it.">
            <Input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!userId || !record || create.isPending}>Assign</Button>
            <Button size="sm" type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
          {create.error && <ErrorBanner error={create.error} />}
        </form>
      )}
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBanner error={list.error} />
      ) : !list.data?.length ? (
        <EmptyState>No active assignments.</EmptyState>
      ) : (
        <Table head={fixed ? ['Employee', 'Until', ''] : ['Employee', 'Assigned to', 'Until', '']}>
          {list.data.map((a) => (
            <tr key={a.id}>
              <Td>{a.user_name}</Td>
              {!fixed && <Td>{recordLabel(a)}</Td>}
              <Td>{a.ends_at ? date(a.ends_at) : 'until ended'}</Td>
              <Td className="text-right">
                {canEdit && (
                  <Button size="sm" variant="ghost" disabled={end.isPending} onClick={() => end.mutate(a.id)}>
                    End
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {end.error && <ErrorBanner error={end.error} />}
    </Card>
  );
}

// Temporary access (record grants) ----------------------------------------------------------

/** Time-limited access for one employee to one record, with a reason (at most 90 days). */
export function GrantsCard({ fixed }: { fixed?: RecordRef }) {
  const api = useApi();
  const qc = useQueryClient();
  const { can } = useMe();
  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState('');
  const [record, setRecord] = useState<RecordRef | null>(fixed ?? null);
  const [actions, setActions] = useState<string[]>(['read']);
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const recordId = fixed ? (fixed.kind === 'customer' ? fixed.customer.id : fixed.organization.id) : null;
  const list = useQuery({
    queryKey: ['grants', recordId],
    queryFn: () => api.get<Grant[]>(`/admin/record-grants${recordId ? `?record_id=${recordId}` : ''}`),
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['grants'] });
    void qc.invalidateQueries({ queryKey: ['access'] });
  };
  const create = useMutation({
    mutationFn: () =>
      api.post('/admin/record-grants', {
        user_id: userId,
        resource: record!.kind,
        record_id: record!.kind === 'customer' ? record!.customer.id : record!.organization.id,
        actions,
        reason,
        expires_at: new Date(Date.now() + Number(days) * 86_400_000).toISOString(),
      }),
    onSuccess: () => {
      setAdding(false);
      setUserId('');
      setReason('');
      done();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/admin/record-grants/${id}/revoke`), onSuccess: done });
  const canEdit = can('update', 'access');
  const toggle = (a: string) => setActions((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]));

  return (
    <Card
      title="Temporary access"
      actions={canEdit && !adding && <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Give access</Button>}
    >
      {adding && (
        <form
          className="mb-4 space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Employee">
            <EmployeeSelect value={userId} onChange={setUserId} />
          </Field>
          <RecordField fixed={fixed} onChange={setRecord} />
          <fieldset className="text-sm">
            <legend className="mb-1 font-medium">Can</legend>
            <div className="flex gap-4">
              {['read', 'create', 'update'].map((a) => (
                <label key={a} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={actions.includes(a)} onChange={() => toggle(a)} />
                  {a === 'read' ? 'View' : a === 'create' ? 'Add records' : 'Edit'}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="For" hint={`Access ends automatically; at most ${MAX_GRANT_DAYS} days.`}>
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              {['1', '7', '30', String(MAX_GRANT_DAYS)].map((d) => (
                <option key={d} value={d}>
                  {d === '1' ? '1 day' : `${d} days`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. covering for Lia this week" required minLength={3} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!userId || !record || !actions.length || reason.trim().length < 3 || create.isPending}>
              Give access
            </Button>
            <Button size="sm" type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
          {create.error && <ErrorBanner error={create.error} />}
        </form>
      )}
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBanner error={list.error} />
      ) : !list.data?.length ? (
        <EmptyState>No temporary access.</EmptyState>
      ) : (
        <Table head={fixed ? ['Employee', 'Can', 'Until', ''] : ['Employee', 'Record', 'Can', 'Until', '']}>
          {list.data.map((g) => (
            <tr key={g.id}>
              <Td>
                {g.user_name}
                <span className="block text-xs text-slate-500" title={`Given by ${g.granted_by_name ?? 'unknown'}`}>{g.reason}</span>
              </Td>
              {!fixed && (
                <Td>
                  {recordLabel({
                    customer_id: g.resource === 'customer' ? g.record_id : null,
                    organization_id: g.resource === 'organization' ? g.record_id : null,
                    customer_name: g.customer_name,
                    customer_number: g.customer_number,
                    organization_name: g.organization_name,
                    org_number: g.org_number,
                  })}
                </Td>
              )}
              <Td>
                <div className="flex flex-wrap gap-1">
                  {g.actions.map((a) => (
                    <Badge key={a} tone="brand">{a}</Badge>
                  ))}
                </div>
              </Td>
              <Td>{date(g.expires_at)}</Td>
              <Td className="text-right">
                {canEdit && (
                  <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(g.id)}>
                    Revoke
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {revoke.error && <ErrorBanner error={revoke.error} />}
    </Card>
  );
}

// Restricted records ------------------------------------------------------------------------

interface RestrictedList {
  customers: (Customer & { updated_at: string })[];
  organizations: { id: string; org_number: string; name: string; members: number }[];
}

/** Restricted records are hidden from location-wide access: only admins and assigned staff see them. */
function RestrictedCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { can } = useMe();
  const [kind, setKind] = useState<'customer' | 'organization'>('customer');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const list = useQuery({ queryKey: ['restricted'], queryFn: () => api.get<RestrictedList>('/admin/restricted') });
  const set = useMutation({
    mutationFn: ({ kind, id, restricted }: { kind: 'customer' | 'organization'; id: string; restricted: boolean }) =>
      api.put(`/${kind === 'customer' ? 'customers' : 'organizations'}/${id}`, { restricted }),
    onSuccess: () => {
      setCustomer(null);
      setOrg(null);
      void qc.invalidateQueries({ queryKey: ['restricted'] });
      void qc.invalidateQueries({ queryKey: ['customer'] });
    },
  });
  const canEdit = can('update', 'access');
  const picked = kind === 'customer' ? customer : org;

  return (
    <Card title="Restricted records">
      <p className="mb-3 text-sm text-slate-500">
        Only admins and staff assigned to them can see restricted customers and organizations, including all of an organization’s members.
      </p>
      {canEdit && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="flex gap-1">
            {(['customer', 'organization'] as const).map((k) => (
              <Button key={k} type="button" size="sm" variant={kind === k ? 'primary' : 'secondary'} onClick={() => setKind(k)}>
                {k === 'customer' ? 'Customer' : 'Organization'}
              </Button>
            ))}
          </div>
          <div className="min-w-64 flex-1">
            {kind === 'customer' ? <CustomerPicker value={customer} onChange={setCustomer} /> : <OrganizationPicker value={org} onChange={setOrg} />}
          </div>
          <Button size="sm" disabled={!picked || set.isPending} onClick={() => picked && set.mutate({ kind, id: picked.id, restricted: true })}>
            Restrict
          </Button>
        </div>
      )}
      {set.error && <ErrorBanner error={set.error} />}
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBanner error={list.error} />
      ) : !list.data?.customers.length && !list.data?.organizations.length ? (
        <EmptyState>No restricted records.</EmptyState>
      ) : (
        <Table head={['Record', 'Type', '']}>
          {list.data!.organizations.map((o) => (
            <tr key={o.id}>
              <Td>{o.name} <span className="text-slate-500">· {o.org_number}</span></Td>
              <Td>Organization · {o.members} member{o.members === 1 ? '' : 's'}</Td>
              <Td className="text-right">
                {canEdit && <Button size="sm" variant="ghost" onClick={() => set.mutate({ kind: 'organization', id: o.id, restricted: false })}>Unrestrict</Button>}
              </Td>
            </tr>
          ))}
          {list.data!.customers.map((c) => (
            <tr key={c.id}>
              <Td>
                <Link to={`/staff/customers/${c.id}`} className="text-brand-600 hover:underline">{fullName(c)}</Link>{' '}
                <span className="text-slate-500">· {c.customer_number}</span>
              </Td>
              <Td>Customer</Td>
              <Td className="text-right">
                {canEdit && <Button size="sm" variant="ghost" onClick={() => set.mutate({ kind: 'customer', id: c.id, restricted: false })}>Unrestrict</Button>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

// Staff permissions -------------------------------------------------------------------------

type Perm = { role: string; resource: string; action: string; scope: string };

const RECORD_SCOPES = ['all', 'location', 'assigned', 'own'] as const;
const SCOPE_LABEL: Record<string, string> = {
  all: 'All',
  location: 'Their locations',
  assigned: 'Assigned',
  own: 'Own',
  recorded: 'Recorded by them',
};

/** Rows of the matrix: what staff could be allowed, and which scopes make sense for each. */
const MATRIX: { resource: string; label: string; actions: string[]; scopes: readonly string[] }[] = [
  { resource: 'customers', label: 'Customers', actions: ['read', 'create', 'update'], scopes: RECORD_SCOPES },
  { resource: 'organizations', label: 'Organizations', actions: ['read', 'create', 'update'], scopes: RECORD_SCOPES },
  { resource: 'appointments', label: 'Appointments', actions: ['read', 'create', 'update'], scopes: RECORD_SCOPES },
  { resource: 'payments', label: 'Payments', actions: ['read', 'create', 'update'], scopes: [...RECORD_SCOPES, 'recorded'] },
  { resource: 'tickets', label: 'Support tickets', actions: ['read'], scopes: RECORD_SCOPES },
  { resource: 'notes_internal', label: 'Internal notes', actions: ['read', 'update'], scopes: RECORD_SCOPES },
  { resource: 'services', label: 'Services', actions: ['read', 'create', 'update', 'delete'], scopes: ['all'] },
  { resource: 'locations', label: 'Locations', actions: ['read', 'create', 'update', 'delete'], scopes: ['all'] },
  { resource: 'users', label: 'Employees', actions: ['read'], scopes: ['all'] },
  { resource: 'settings', label: 'Settings', actions: ['read'], scopes: ['all'] },
  { resource: 'audit', label: 'Audit log', actions: ['read'], scopes: ['all'] },
  { resource: 'access', label: 'Access rules', actions: ['read'], scopes: ['all'] },
];
const ACTION_LABEL: Record<string, string> = { read: 'View', create: 'Add', update: 'Edit', delete: 'Delete' };
const key = (p: Pick<Perm, 'resource' | 'action' | 'scope'>) => `${p.resource}:${p.action}:${p.scope}`;

/** What staff may do, and where. Admin, organization admin and customer permissions are fixed. */
function StaffPermissionsCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { can } = useMe();
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Perm[]>('/admin/permissions') });
  const saved = useMemo(() => new Set((perms.data ?? []).filter((p) => p.role === 'staff').map(key)), [perms.data]);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const current = draft ?? saved;
  const dirty = draft !== null && (draft.size !== saved.size || [...draft].some((k) => !saved.has(k)));
  const save = useMutation({
    mutationFn: () =>
      api.put('/admin/permissions/staff', {
        permissions: [...current].map((k) => {
          const [resource, action, scope] = k.split(':');
          return { resource, action, scope };
        }),
      }),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['permissions'] });
    },
  });
  const canEdit = can('update', 'access');
  const toggle = (k: string) =>
    setDraft(() => {
      const next = new Set(current);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const scopes = [...RECORD_SCOPES, 'recorded'];

  return (
    <Card
      title="What staff can do"
      actions={
        canEdit && (
          <div className="flex gap-2">
            {dirty && <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>Discard</Button>}
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save</Button>
          </div>
        )
      }
    >
      <p className="mb-3 text-sm text-slate-500">
        Applies to every staff member; admins can always do everything. Staff can never manage employees, settings or access, void or refund payments, or merge customers.
      </p>
      {perms.isLoading ? (
        <Spinner />
      ) : perms.error ? (
        <ErrorBanner error={perms.error} />
      ) : (
        <Table head={['Permission', ...scopes.map((s) => SCOPE_LABEL[s])]}>
          {MATRIX.flatMap((row) =>
            row.actions.map((action) => (
              <tr key={`${row.resource}:${action}`}>
                <Td>
                  {ACTION_LABEL[action]} {row.label.toLowerCase()}
                </Td>
                {scopes.map((scope) => {
                  const allowed = row.scopes.includes(scope) && (scope !== 'recorded' || action === 'update');
                  const k = key({ resource: row.resource, action, scope });
                  return (
                    <Td key={scope} className="text-center">
                      {allowed ? (
                        <input
                          type="checkbox"
                          aria-label={`${ACTION_LABEL[action]} ${row.label}: ${SCOPE_LABEL[scope]}`}
                          checked={current.has(k)}
                          disabled={!canEdit}
                          onChange={() => toggle(k)}
                        />
                      ) : (
                        <span className="text-slate-300 dark:text-slate-700">—</span>
                      )}
                    </Td>
                  );
                })}
              </tr>
            )),
          )}
        </Table>
      )}
      {save.error && <ErrorBanner error={save.error} />}
    </Card>
  );
}
