import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date, dateTime } from '../../lib/format';

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  owner_name: string | null;
  mine: boolean;
  active: boolean;
}

/**
 * Settings card: personal access tokens that let Claude (Claude Code, Claude Desktop) read this
 * business's data as the admin who created them, through the MCP endpoint. A new token is shown once.
 */
export function McpTokensCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.get<ApiToken[]>('/admin/api-tokens') });
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const endpoint = `${window.location.origin}/api/mcp`;

  const create = useMutation({
    mutationFn: () => api.post<ApiToken & { token: string }>('/admin/api-tokens', { name: name.trim(), expires_in_days: Number(days) }),
    onSuccess: (t) => {
      setCreated({ name: t.name, token: t.token });
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/admin/api-tokens/${id}/revoke`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-tokens'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    create.mutate();
  };

  return (
    <Card title="Claude access (MCP)">
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Let Claude read this business's data (customers, calendar, payments, invoices, to-dos, knowledge) as you. Read-only: it cannot change anything. Each token works until it
          expires or is revoked, and stops if you are no longer an admin.
        </p>

        {created ? (
          <div role="status" className="space-y-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950">
            <p className="font-medium">Token “{created.name}” created. Copy it now: it won't be shown again.</p>
            <CopyField label="Token" value={created.token} />
            <CopyField label="Claude Code" value={`claude mcp add --transport http joybot ${endpoint} --header "Authorization: Bearer ${created.token}"`} />
            <CopyField label="Claude Desktop (claude_desktop_config.json, via mcp-remote)" value={desktopConfig(endpoint, created.token)} multiline />
            <Button size="sm" variant="secondary" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end">
            <Field label="Token name">
              <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code on my laptop" />
            </Field>
            <Field label="Expires after">
              <Select value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </Select>
            </Field>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Create token
            </Button>
          </form>
        )}
        {create.error && <ErrorBanner error={create.error} />}

        {tokens.isLoading ? (
          <Spinner />
        ) : tokens.error ? (
          <ErrorBanner error={tokens.error} />
        ) : !tokens.data?.length ? (
          <EmptyState>No tokens yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {tokens.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium">
                    {t.name} <span className="font-mono text-xs text-slate-500">{t.prefix}…</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {t.mine ? 'Yours' : t.owner_name} · created {date(t.created_at)} · {t.revoked_at ? `revoked ${date(t.revoked_at)}` : `expires ${date(t.expires_at)}`} ·{' '}
                    {t.last_used_at ? `last used ${dateTime(t.last_used_at)}` : 'never used'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={t.active ? 'green' : 'slate'}>{t.active ? 'active' : t.revoked_at ? 'revoked' : 'expired'}</Badge>
                  {t.active && (
                    <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(t.id)} aria-label={`Revoke ${t.name}`}>
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {revoke.error && <ErrorBanner error={revoke.error} />}
      </div>
    </Card>
  );
}

function desktopConfig(endpoint: string, token: string) {
  return JSON.stringify(
    { mcpServers: { joybot: { command: 'npx', args: ['-y', 'mcp-remote', endpoint, '--header', `Authorization: Bearer ${token}`] } } },
    null,
    2,
  );
}

function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <button
          type="button"
          className="press rounded-full px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-white/70 dark:text-brand-600 dark:hover:bg-slate-900"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={`overflow-x-auto rounded-md bg-white p-2 font-mono text-xs dark:bg-slate-900 ${multiline ? '' : 'whitespace-nowrap'}`}>{value}</pre>
    </div>
  );
}
