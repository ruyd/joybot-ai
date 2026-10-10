import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date, preferredTimeZone, todayIn } from '../../lib/format';
import { useMe } from '../../lib/me';
import { CustomerPicker, type Customer } from './CustomerPicker';

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  due_on: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_number: string | null;
  assigned_to: string;
  assigned_to_name: string;
  created_by: string;
  created_by_name: string;
  completed_at: string | null;
}

interface Assignee {
  id: string;
  first_name: string;
  last_name: string;
}

function useTaskActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  const toggle = useMutation({
    mutationFn: (t: Task) => api.put<Task>(`/tasks/${t.id}`, { done: !t.completed_at }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (t: Task) => api.del(`/tasks/${t.id}`), onSuccess: refresh });
  return { toggle, remove };
}

/** "Overdue", "Today" or the date, against today in the viewer's time zone. */
function DueBadge({ due, done, zone }: { due: string | null; done: boolean; zone: string }) {
  if (!due) return null;
  const today = todayIn(zone);
  if (!done && due < today) return <Badge tone="red">overdue · {date(due)}</Badge>;
  if (!done && due === today) return <Badge tone="amber">today</Badge>;
  return <span className="text-xs text-slate-500">due {date(due)}</span>;
}

function TaskRow({ task, zone, myId, onEdit }: { task: Task; zone: string; myId?: string; onEdit?: () => void }) {
  const { toggle, remove } = useTaskActions();
  const done = !!task.completed_at;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0"
        checked={done}
        disabled={toggle.isPending}
        onChange={() => toggle.mutate(task)}
        aria-label={done ? `Reopen “${task.title}”` : `Mark “${task.title}” done`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`text-sm ${done ? 'text-slate-500 line-through' : 'font-medium'}`}>{task.title}</span>
          <DueBadge due={task.due_on} done={done} zone={zone} />
        </div>
        <p className="text-xs text-slate-500">
          {task.customer_id && (
            <>
              <Link to={`/staff/customers/${task.customer_id}`} className="text-brand-600 hover:underline">
                {task.customer_name ?? task.customer_number ?? 'Customer'}
              </Link>
              {' · '}
            </>
          )}
          {task.assigned_to === myId ? 'You' : task.assigned_to_name}
          {task.created_by !== task.assigned_to && ` · from ${task.created_by === myId ? 'you' : task.created_by_name}`}
        </p>
        {task.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{task.notes}</p>}
        {(toggle.error || remove.error) && <ErrorBanner error={toggle.error ?? remove.error} />}
      </div>
      {onEdit && (
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>Edit</Button>
          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(task)} aria-label={`Delete “${task.title}”`}>
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}

/** Add (no task) or edit a to-do. */
function TaskForm({ task, onDone }: { task?: Task; onDone?: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const assignees = useQuery({ queryKey: ['task-assignees'], queryFn: () => api.get<Assignee[]>('/tasks/assignees') });
  const [title, setTitle] = useState(task?.title ?? '');
  const [due, setDue] = useState(task?.due_on ?? '');
  const [assignee, setAssignee] = useState(task?.assigned_to ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [customer, setCustomer] = useState<Customer | null>(
    task?.customer_id
      ? ({ id: task.customer_id, customer_number: task.customer_number ?? '', first_name: task.customer_name, last_name: null } as Customer)
      : null,
  );
  const [round, setRound] = useState(0); // remounts the customer picker after adding

  const save = useMutation({
    mutationFn: () => {
      const body = { title, due_on: due || null, notes: notes || null, customer_id: customer?.id ?? null, assigned_to: assignee || me?.profile.id };
      if (task) return api.put<Task>(`/tasks/${task.id}`, body);
      const { due_on, notes: n, customer_id, ...rest } = body;
      return api.post<Task>('/tasks', { ...rest, due_on: due_on ?? undefined, notes: n ?? undefined, customer_id: customer_id ?? undefined });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      if (!task) {
        setTitle('');
        setDue('');
        setAssignee('');
        setNotes('');
        setCustomer(null);
        setRound((r) => r + 1);
      }
      onDone?.();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="grid gap-3">
      <Field label="To-do">
        <Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Call Maria about her refund" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Due (optional)">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="Assigned to">
          <Select value={assignee || me?.profile.id || ''} onChange={(e) => setAssignee(e.target.value)}>
            {assignees.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === me?.profile.id ? 'Me' : `${a.first_name} ${a.last_name}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Customer (optional)">
        <CustomerPicker key={round} value={customer} onChange={setCustomer} />
      </Field>
      <Field label="Notes (optional)">
        <textarea
          rows={2}
          maxLength={5000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </Field>
      {save.error && <ErrorBanner error={save.error} />}
      <div className="flex gap-2">
        <Button type="submit" disabled={!title.trim() || save.isPending}>{task ? 'Save' : 'Add to-do'}</Button>
        {task && onDone && <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>}
      </div>
    </form>
  );
}

const STATUS_TABS = [
  ['open', 'Open'],
  ['done', 'Done'],
  ['all', 'All'],
] as const;

export function Todos() {
  const api = useApi();
  const { me, can } = useMe();
  const zone = preferredTimeZone(me?.profile.time_zone);
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open');
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['tasks', status, mine],
    queryFn: () => api.get<Task[]>(`/tasks?status=${status}${mine ? '&mine=true' : ''}`),
  });

  return (
    <Page>
      <PageHeader title="To-dos" description="Every to-do you can see: assigned to you, created by you, or more if your role allows. “Only mine” shows your own list." />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card
          title={
            <div role="tablist" className="flex gap-1">
              {STATUS_TABS.map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={status === key}
                  onClick={() => setStatus(key)}
                  className={`rounded-lg px-3 py-1 text-sm ${status === key ? 'bg-brand-600 text-white' : 'font-normal hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
          actions={
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine
            </label>
          }
        >
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <ErrorBanner error={q.error} />
          ) : !q.data?.length ? (
            <EmptyState>{status === 'done' ? 'Nothing completed yet.' : 'Nothing to do. Add a to-do on the right.'}</EmptyState>
          ) : (
            <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.map((t) =>
                editing === t.id ? (
                  <li key={t.id} className="py-3">
                    <TaskForm task={t} onDone={() => setEditing(null)} />
                  </li>
                ) : (
                  <TaskRow key={t.id} task={t} zone={zone} myId={me?.profile.id} onEdit={can('update', 'tasks') ? () => setEditing(t.id) : undefined} />
                ),
              )}
            </ul>
          )}
        </Card>
        {can('create', 'tasks') && (
          <Card title="Add a to-do">
            <TaskForm />
          </Card>
        )}
      </div>
    </Page>
  );
}

/** Home page: my open to-dos, soonest due first, with a quick add. */
export function PendingTodos() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me, can } = useMe();
  const zone = preferredTimeZone(me?.profile.time_zone);
  const q = useQuery({ queryKey: ['tasks', 'open', true], queryFn: () => api.get<Task[]>('/tasks?status=open&mine=true') });
  const [title, setTitle] = useState('');
  const add = useMutation({
    mutationFn: () => api.post<Task>('/tasks', { title }),
    onSuccess: () => {
      setTitle('');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const shown = q.data?.slice(0, 8) ?? [];
  const overdue = q.data?.filter((t) => t.due_on && t.due_on < todayIn(zone)).length ?? 0;

  return (
    <Card
      title={
        <span>
          Pending to-dos{q.data ? ` · ${q.data.length}` : ''}
          {overdue > 0 && <span className="ml-2"><Badge tone="red">{overdue} overdue</Badge></span>}
        </span>
      }
      actions={<Link to="/staff/todos" className="text-sm text-brand-600 hover:underline">All to-dos</Link>}
    >
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBanner error={q.error} />
      ) : !shown.length ? (
        <EmptyState>Nothing pending.</EmptyState>
      ) : (
        <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
          {shown.map((t) => (
            <TaskRow key={t.id} task={t} zone={zone} myId={me?.profile.id} />
          ))}
        </ul>
      )}
      {q.data && q.data.length > shown.length && (
        <p className="mt-2 text-sm text-slate-500">
          and {q.data.length - shown.length} more · <Link to="/staff/todos" className="text-brand-600 hover:underline">see all</Link>
        </p>
      )}
      {can('create', 'tasks') && (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) add.mutate();
          }}
        >
          <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Add a to-do for yourself" aria-label="New to-do" />
          <Button type="submit" variant="secondary" disabled={!title.trim() || add.isPending}>Add</Button>
        </form>
      )}
      {add.error && <div className="mt-2"><ErrorBanner error={add.error} /></div>}
    </Card>
  );
}
