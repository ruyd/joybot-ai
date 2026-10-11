import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { useApi } from '../../lib/api';
import { TIME_ZONES } from '../../lib/format';
import { useMe } from '../../lib/me';

interface Employee {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  role: 'admin' | 'staff';
  home_location_id: string | null;
  time_zone: string | null;
  location_ids: string[];
  active: boolean;
  has_login: boolean;
}

interface Location {
  id: string;
  name: string;
}

/** Admin › Employees: who works here, their role and locations, invitations and deactivation. */
export function EmployeesPage() {
  const api = useApi();
  const { can } = useMe();
  const employees = useQuery({ queryKey: ['employees'], queryFn: () => api.get<Employee[]>('/admin/users?include_inactive=true') });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api.get<Location[]>('/locations') });
  const [editing, setEditing] = useState<string | null>(null);
  const locationName = new Map(locations.data?.map((l) => [l.id, l.name]));
  const selected = employees.data?.find((u) => u.id === editing);

  return (
    <Page>
      <PageHeader title="Employees" description="Invite employees, set their role and locations, and deactivate anyone who leaves." />
      <div className={`grid items-start gap-4 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_26rem]' : ''}`}>
        <div className="space-y-4">
          <Card title="Employees" actions={employees.data && <span className="text-xs text-slate-500">{employees.data.filter((u) => u.active).length} active</span>}>
            {employees.isLoading ? (
              <Spinner />
            ) : employees.error ? (
              <ErrorBanner error={employees.error} />
            ) : !employees.data?.length ? (
              <EmptyState>No employees yet.</EmptyState>
            ) : (
              <Table head={['Name', 'Role', 'Locations', 'Status', '']}>
                {employees.data.map((u) => (
                  <tr key={u.id} className={u.id === editing ? 'bg-brand-50/60 dark:bg-slate-800/60' : ''}>
                    <Td>
                      <span className="font-medium">
                        {u.first_name} {u.last_name}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {u.email} · {u.employee_number}
                      </span>
                    </Td>
                    <Td className="capitalize">{u.role}</Td>
                    <Td className="text-slate-500">{u.location_ids.map((id) => locationName.get(id) ?? '…').join(', ') || '—'}</Td>
                    <Td>
                      <EmployeeStatus employee={u} />
                    </Td>
                    <Td className="text-right">
                      {can('update', 'users') && (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(u.id === editing ? null : u.id)} aria-label={`Edit ${u.first_name} ${u.last_name}`}>
                          {u.id === editing ? 'Close' : 'Edit'}
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          {can('create', 'users') && <InviteCard locations={locations.data ?? []} />}
        </div>
        {selected && (
          <div className="lg:sticky lg:top-20">
            <EditEmployee key={selected.id} employee={selected} locations={locations.data ?? []} onClose={() => setEditing(null)} />
          </div>
        )}
      </div>
    </Page>
  );
}

function EmployeeStatus({ employee: u }: { employee: Employee }) {
  if (!u.active) return <Badge tone="red">inactive</Badge>;
  return u.has_login ? <Badge tone="green">active</Badge> : <Badge tone="amber">invited</Badge>;
}

function InviteCard({ locations }: { locations: Location[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const blank = { first_name: '', last_name: '', email: '', role: 'staff', home_location_id: '' };
  const [form, setForm] = useState(blank);
  const add = useMutation({
    mutationFn: () => api.post('/admin/users', { ...form, home_location_id: form.home_location_id || null }),
    onSuccess: () => {
      setForm(blank);
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <Card title="Invite an employee">
      <form className="grid gap-3 sm:grid-cols-2 sm:items-end xl:grid-cols-3" onSubmit={submit}>
        <Field label="First name">
          <Input required value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input required value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Role">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <Field label="Location">
          <Select value={form.home_location_id} onChange={(e) => setForm({ ...form, home_location_id: e.target.value })}>
            <option value="">None</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <Button type="submit" disabled={add.isPending}>
            Invite
          </Button>
        </div>
      </form>
      <p className="mt-2 text-xs text-slate-500">They get an email with a temporary password to sign in.</p>
      {add.error && (
        <div className="mt-2">
          <ErrorBanner error={add.error} />
        </div>
      )}
    </Card>
  );
}

function EditEmployee({ employee: u, locations, onClose }: { employee: Employee; locations: Location[]; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const self = me?.profile.id === u.id;
  const [form, setForm] = useState({
    first_name: u.first_name,
    last_name: u.last_name,
    phone: u.phone ?? '',
    role: u.role,
    home_location_id: u.home_location_id ?? '',
    time_zone: u.time_zone ?? '',
    location_ids: u.location_ids,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['employees'] });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<Employee>(`/admin/users/${u.id}`, body),
    onSuccess: refresh,
  });
  const resend = useMutation({ mutationFn: () => api.post(`/admin/users/${u.id}/resend-invite`) });
  const toggleLocation = (id: string) =>
    setForm({ ...form, location_ids: form.location_ids.includes(id) ? form.location_ids.filter((l) => l !== id) : [...form.location_ids, id] });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      ...form,
      phone: form.phone.trim() || null,
      home_location_id: form.home_location_id || null,
      time_zone: form.time_zone || null,
      // The home location is always one of their locations.
      location_ids: form.home_location_id && !form.location_ids.includes(form.home_location_id) ? [...form.location_ids, form.home_location_id] : form.location_ids,
    });
  };

  return (
    <Card
      title={`${u.first_name} ${u.last_name}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-slate-500">
          {u.email} · {u.employee_number} <EmployeeStatus employee={u} />
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name">
            <Input required value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input required value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          </Field>
          <Field label="Phone" hint="International format, e.g. +12125550100">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Role" hint={self ? 'You cannot change your own role.' : undefined}>
            <Select value={form.role} disabled={self} onChange={(e) => setForm({ ...form, role: e.target.value as Employee['role'] })}>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
          <Field label="Home location">
            <Select value={form.home_location_id} onChange={(e) => setForm({ ...form, home_location_id: e.target.value })}>
              <option value="">None</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Time zone">
            <Select value={form.time_zone} onChange={(e) => setForm({ ...form, time_zone: e.target.value })}>
              <option value="">Location's</option>
              {TIME_ZONES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Works at</legend>
          <p className="mb-2 text-xs text-slate-500">Staff see customers and appointments at these locations.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.location_ids.includes(l.id) || form.home_location_id === l.id} disabled={form.home_location_id === l.id} onChange={() => toggleLocation(l.id)} />
                {l.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
          <Link to={`/staff/audit?table=users&row_id=${u.id}&record=${encodeURIComponent(`${u.first_name} ${u.last_name}`)}`} className="self-center text-sm font-medium text-brand-700 hover:underline dark:text-brand-600">
            Change history
          </Link>
        </div>
        {save.isSuccess && !save.isPending && <p className="text-sm text-emerald-700 dark:text-emerald-400">Saved.</p>}
        {save.error && <ErrorBanner error={save.error} />}
      </form>

      <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        {u.active && !u.has_login && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-500">{resend.isSuccess ? 'A new invitation was sent.' : 'Has not signed in yet.'}</p>
            <Button size="sm" variant="secondary" disabled={resend.isPending} onClick={() => resend.mutate()}>
              Resend invitation
            </Button>
          </div>
        )}
        {resend.error && <ErrorBanner error={resend.error} />}
        {!self && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-500">{u.active ? 'Deactivating stops their sign-in right away; their history is kept.' : 'Inactive: they cannot sign in.'}</p>
            <Button size="sm" variant={u.active ? 'danger' : 'secondary'} disabled={save.isPending}               onClick={() => {
                if (!u.active || window.confirm(`Deactivate ${u.first_name} ${u.last_name}? They can no longer sign in.`)) save.mutate({ active: !u.active });
              }}
            >
              {u.active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
