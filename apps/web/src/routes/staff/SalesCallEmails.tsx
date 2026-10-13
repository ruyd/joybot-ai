import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';

export interface EmailTemplate {
  id: string;
  kind: 'sales_call_confirmation' | 'sales_call_thank_you';
  name: string;
  subject: string;
  body: string;
}

interface CallOption {
  id: string;
  name: string;
  email: string;
  starts_at: string;
  status: string;
  outcome: string | null;
  thank_you_sent_at: string | null;
}

/** The placeholders a sales call email can use (the API's SALES_CALL_FIELDS). */
const FIELDS: [string, string][] = [
  ['first_name', 'First name'],
  ['name', 'Full name'],
  ['call_title', 'Call title'],
  ['date', 'Date'],
  ['time', 'Time'],
  ['time_zone', 'Time zone'],
  ['duration', 'Minutes'],
  ['host_name', 'Host'],
  ['site_name', 'Site name'],
  ['meeting_link', 'Meeting link'],
  ['phone', 'Phone'],
  ['meeting_details', 'Meeting details'],
  ['booking_link', 'Booking link'],
];

function useTemplates(kind: EmailTemplate['kind']) {
  const api = useApi();
  return useQuery({ queryKey: ['email-templates', kind], queryFn: () => api.get<EmailTemplate[]>(`/website/email-templates?kind=${kind}`) });
}

/**
 * Subject and body with clickable placeholders and a live preview (filled in for `callId`, or a
 * sample call). Controlled: the parent keeps the text.
 */
function TemplateEditor({
  subject,
  body,
  onChange,
  callId,
  disabled,
}: {
  subject: string;
  body: string;
  onChange: (next: { subject: string; body: string }) => void;
  callId?: string;
  disabled?: boolean;
}) {
  const api = useApi();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState<'subject' | 'body'>('body');
  const [debounced, setDebounced] = useState({ subject, body, callId });
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ subject, body, callId }), 300);
    return () => clearTimeout(t);
  }, [subject, body, callId]);
  const preview = useQuery({
    queryKey: ['email-preview', debounced],
    enabled: Boolean(debounced.subject.trim() && debounced.body.trim()),
    queryFn: () => api.post<{ subject: string; body: string }>('/website/email-templates/preview', { subject: debounced.subject, body: debounced.body, call_id: debounced.callId }),
    placeholderData: (prev) => prev,
    retry: false,
  });

  // Inserts {{field}} where the cursor was, in the subject or the body.
  const insert = (field: string) => {
    const el = focus === 'subject' ? subjectRef.current : bodyRef.current;
    const text = focus === 'subject' ? subject : body;
    const token = `{{${field}}}`;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + token + text.slice(end);
    onChange(focus === 'subject' ? { subject: next, body } : { subject, body: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="grid content-start gap-3">
        <Field label="Subject">
          <Input ref={subjectRef} required maxLength={200} value={subject} disabled={disabled} onFocus={() => setFocus('subject')} onChange={(e) => onChange({ subject: e.target.value, body })} />
        </Field>
        <Field label="Message">
          <textarea
            ref={bodyRef}
            rows={12}
            maxLength={10000}
            value={body}
            disabled={disabled}
            onFocus={() => setFocus('body')}
            onChange={(e) => onChange({ subject, body: e.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </Field>
        {!disabled && (
          <div>
            <p className="mb-1.5 text-xs text-slate-500">Insert into the {focus === 'subject' ? 'subject' : 'message'}:</p>
            <div className="flex flex-wrap gap-1.5">
              {FIELDS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  title={`{{${key}}}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(key)}
                  className="press rounded-full border border-slate-300 px-2.5 py-0.5 text-xs text-slate-700 hover:border-brand-600 hover:text-brand-700 dark:border-slate-700 dark:text-slate-200"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="grid content-start gap-2">
        <p className="text-sm font-medium">Preview{callId ? '' : ' (a sample call)'}</p>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60">
          {preview.error ? (
            <ErrorBanner error={preview.error} />
          ) : !preview.data ? (
            <Spinner />
          ) : (
            <>
              <p className="border-b border-slate-200 pb-2 text-sm font-semibold dark:border-slate-700">{preview.data.subject}</p>
              <p className="mt-3 text-sm whitespace-pre-wrap">{preview.data.body}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The confirmation every visitor gets when they book. */
export function ConfirmationEmailTab({ editable }: { editable: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const templates = useTemplates('sales_call_confirmation');
  const template = templates.data?.[0];
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (template && !draft) setDraft({ subject: template.subject, body: template.body });
  }, [template, draft]);
  const save = useMutation({
    mutationFn: () => api.put<EmailTemplate>(`/website/email-templates/${template!.id}`, draft),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['email-templates'] });
    },
  });
  const changed = Boolean(template && draft && (draft.subject !== template.subject || draft.body !== template.body));

  return (
    <Card title="Confirmation email">
      <p className="mb-4 text-sm text-slate-500">Sent automatically to the visitor as soon as they book a call.</p>
      {templates.isLoading || !draft ? (
        templates.error ? <ErrorBanner error={templates.error} /> : <Spinner />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(false);
            save.mutate();
          }}
          className="grid gap-4"
        >
          <TemplateEditor
            subject={draft.subject}
            body={draft.body}
            disabled={!editable}
            onChange={(next) => {
              setSaved(false);
              setDraft(next);
            }}
          />
          {save.error && <ErrorBanner error={save.error} />}
          {editable && (
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!changed || save.isPending}>
                Save
              </Button>
              {changed && (
                <Button type="button" variant="ghost" onClick={() => template && setDraft({ subject: template.subject, body: template.body })}>
                  Discard changes
                </Button>
              )}
              {saved && !changed && (
                <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
                  Saved
                </span>
              )}
            </div>
          )}
        </form>
      )}
    </Card>
  );
}

/** Thank-you presets, edited and sent by hand to someone after their call. */
export function ThankYouEmailTab({ editable, callId }: { editable: boolean; callId?: string | null }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const presets = useTemplates('sales_call_thank_you');
  const calls = useQuery({
    queryKey: ['sales-calls', 'thank-you-options'],
    queryFn: () => api.get<{ items: CallOption[] }>('/website/sales-calls?when=past&limit=100'),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [to, setTo] = useState<string>(callId ?? '');
  const [sent, setSent] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');

  const preset = presets.data?.find((p) => p.id === selected) ?? presets.data?.[0];
  useEffect(() => {
    if (preset && (!draft || selected !== preset.id)) {
      setSelected(preset.id);
      setDraft({ subject: preset.subject, body: preset.body });
    }
  }, [preset?.id]); // a different preset loads its text
  useEffect(() => {
    if (callId) setTo(callId);
  }, [callId]);
  const options = (calls.data?.items ?? []).filter((c) => c.status !== 'cancelled');
  const changed = Boolean(preset && draft && (draft.subject !== preset.subject || draft.body !== preset.body));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['email-templates', 'sales_call_thank_you'] });

  const save = useMutation({ mutationFn: () => api.put<EmailTemplate>(`/website/email-templates/${preset!.id}`, draft), onSuccess: refresh });
  const create = useMutation({
    mutationFn: () => api.post<EmailTemplate>('/website/email-templates', { name: newName.trim(), subject: draft?.subject || 'Thank you, {{first_name}}', body: draft?.body || 'Hi {{first_name}},\n\n' }),
    onSuccess: (t) => {
      setNaming(false);
      setNewName('');
      setSelected(t.id);
      setDraft({ subject: t.subject, body: t.body });
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/website/email-templates/${preset!.id}`),
    onSuccess: () => {
      setSelected(null);
      setDraft(null);
      refresh();
    },
  });
  const send = useMutation({
    mutationFn: () => api.post(`/website/sales-calls/${to}/thank-you`, { template_id: preset?.id, ...draft }),
    onSuccess: () => {
      const c = options.find((o) => o.id === to);
      setSent(`Thank-you sent to ${c?.name ?? 'the visitor'} (${c?.email ?? ''}).`);
      void queryClient.invalidateQueries({ queryKey: ['sales-calls'] });
    },
  });
  const target = options.find((o) => o.id === to);

  return (
    <Card title="Thank you email">
      <p className="mb-4 text-sm text-slate-500">Choose a preset, adjust it if you like, and send it to someone after their call. Presets are shared by everyone.</p>
      {presets.isLoading ? (
        <Spinner />
      ) : presets.error ? (
        <ErrorBanner error={presets.error} />
      ) : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Presets">
            {presets.data?.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === preset?.id}
                onClick={() => {
                  setSelected(p.id);
                  setDraft({ subject: p.subject, body: p.body });
                  setSent(null);
                }}
                className={`press rounded-full border px-3 py-1 text-sm ${
                  p.id === preset?.id ? 'border-brand-600 bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100' : 'border-slate-300 dark:border-slate-700'
                }`}
              >
                {p.name}
              </button>
            ))}
            {editable &&
              (naming ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                  }}
                  className="flex items-center gap-1.5"
                >
                  <Input autoFocus aria-label="Preset name" placeholder="Preset name" maxLength={80} value={newName} onChange={(e) => setNewName(e.target.value)} className="w-44 py-1" />
                  <Button type="submit" size="sm" disabled={!newName.trim() || create.isPending}>
                    Add
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(true)}>
                  <Plus className="size-4" aria-hidden="true" /> New preset
                </Button>
              ))}
          </div>
          {create.error && <ErrorBanner error={create.error} />}

          {!preset || !draft ? (
            <EmptyState>No presets yet: add one.</EmptyState>
          ) : (
            <>
              <TemplateEditor subject={draft.subject} body={draft.body} callId={to || undefined} onChange={setDraft} disabled={!editable} />
              {editable && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
                    Save preset
                  </Button>
                  {changed && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ subject: preset.subject, body: preset.body })}>
                      Discard changes
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={remove.isPending}
                    onClick={() => window.confirm(`Delete the “${preset.name}” preset?`) && remove.mutate()}
                  >
                    <Trash2 className="size-4" aria-hidden="true" /> Delete preset
                  </Button>
                </div>
              )}
              {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}

              {editable && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setSent(null);
                    if (target?.thank_you_sent_at && !window.confirm(`${target.name} already got a thank-you on ${dateTime(target.thank_you_sent_at)}. Send another?`)) return;
                    send.mutate();
                  }}
                  className="grid gap-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800"
                >
                  <label htmlFor="thank-you-to" className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    Send it to
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select id="thank-you-to" required value={to} onChange={(e) => setTo(e.target.value)} disabled={calls.isLoading} className="min-w-72 flex-1">
                      <option value="">{calls.isLoading ? 'Loading…' : options.length ? 'Choose a past call' : 'No past calls yet'}</option>
                      {options.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {dateTime(c.starts_at)}
                          {c.thank_you_sent_at ? ' · thank-you sent' : ''}
                        </option>
                      ))}
                    </Select>
                    <Button type="submit" disabled={!to || send.isPending}>
                      <Send className="size-4" aria-hidden="true" />
                      {send.isPending ? 'Sending…' : 'Send thank-you'}
                    </Button>
                  </div>
                  {target && (
                    <p className="text-xs text-slate-500">
                      To {target.email}. The preview above is filled in for this call.
                      {target.thank_you_sent_at && (
                        <>
                          {' '}
                          <Badge tone="green">thank-you sent {dateTime(target.thank_you_sent_at)}</Badge>
                        </>
                      )}
                    </p>
                  )}
                  {send.error && <ErrorBanner error={send.error} />}
                  {sent && (
                    <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
                      {sent}
                    </p>
                  )}
                </form>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
