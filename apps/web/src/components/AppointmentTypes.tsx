import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../lib/api';
import { useMe } from '../lib/me';
import { Badge, Button, ErrorBanner, Input, Spinner } from './ui';

export interface AppointmentType {
  id: string;
  key: string;
  name: string;
  /** '#rrggbb', the label color on the calendar. */
  color: string;
  /** Used by the app itself (sales calls): read-only. */
  system: boolean;
  sort_order: number;
}

export function useAppointmentTypes() {
  const api = useApi();
  return useQuery({ queryKey: ['appointment-types'], queryFn: () => api.get<AppointmentType[]>('/appointment-types'), staleTime: 60_000 });
}

/** A small color dot for a type. */
export function TypeDot({ color, className = '' }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={`inline-block size-2.5 shrink-0 rounded-full ${className}`} style={{ backgroundColor: color }} />;
}

/**
 * Edits appointment types in a modal dialog: rename, recolor, add and delete. System types (sales
 * calls) show locked. Those who may not edit services see the list read-only.
 */
export function AppointmentTypesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { can } = useMe();
  const types = useAppointmentTypes();
  const editable = can('update', 'services');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="appointment-types-title"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/40 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 id="appointment-types-title" className="text-sm font-semibold">
          Appointment types
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="press rounded-full p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-3 p-4">
        <p className="text-xs text-slate-500">Each type has a color label on the calendar. System types are used by the app and can't be changed.</p>
        {types.isLoading ? (
          <Spinner />
        ) : types.error ? (
          <ErrorBanner error={types.error} />
        ) : (
          <ul className="grid gap-2">
            {types.data?.map((t) => (
              <TypeRow key={`${t.id}:${t.name}:${t.color}`} type={t} editable={editable && !t.system} />
            ))}
          </ul>
        )}
        {can('create', 'services') && <NewType />}
      </div>
    </dialog>
  );
}

function TypeRow({ type, editable }: { type: AppointmentType; editable: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [name, setName] = useState(type.name);
  const [color, setColor] = useState(type.color);
  const changed = name.trim() !== type.name || color !== type.color;
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['appointment-types'] });
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
  };
  const save = useMutation({ mutationFn: () => api.put(`/appointment-types/${type.id}`, { name: name.trim(), color }), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api.del(`/appointment-types/${type.id}`), onSuccess: done });

  return (
    <li className="grid gap-1.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="flex items-center gap-2"
      >
        <input
          type="color"
          aria-label={`${type.name} color`}
          value={color}
          disabled={!editable}
          onChange={(e) => setColor(e.target.value)}
          className="size-9 shrink-0 cursor-pointer rounded-md border border-slate-300 bg-white p-0.5 disabled:cursor-not-allowed dark:border-slate-700 dark:bg-slate-900"
        />
        <Input aria-label="Name" required maxLength={60} value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />
        {type.system ? (
          <Badge tone="slate">
            <Lock className="mr-1 size-3" aria-hidden="true" />
            System
          </Badge>
        ) : (
          editable && (
            <>
              <Button type="submit" size="sm" disabled={!changed || save.isPending}>
                Save
              </Button>
              {can('delete', 'services') && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${type.name}`}
                  disabled={remove.isPending}
                  onClick={() => window.confirm(`Delete the ${type.name} type?`) && remove.mutate()}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              )}
            </>
          )
        )}
      </form>
      {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
    </li>
  );
}

function NewType() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#10b981');
  const add = useMutation({
    mutationFn: () => api.post('/appointment-types', { name: name.trim(), color }),
    onSuccess: () => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['appointment-types'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <form onSubmit={submit} className="grid gap-1.5 border-t border-slate-200 pt-3 dark:border-slate-800">
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="New type color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="size-9 shrink-0 cursor-pointer rounded-md border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900"
        />
        <Input aria-label="New type name" placeholder="New type, e.g. Repair" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" size="sm" disabled={!name.trim() || add.isPending}>
          <Plus className="size-4" aria-hidden="true" />
          Add
        </Button>
      </div>
      {add.error && <ErrorBanner error={add.error} />}
    </form>
  );
}
