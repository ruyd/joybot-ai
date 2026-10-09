import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Input } from '../../components/ui';
import { useApi } from '../../lib/api';
import { fullName } from '../../lib/format';

export interface Customer {
  id: string;
  customer_number: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  restricted: boolean;
  org_role: string | null;
  organization_id: string | null;
  notes_internal?: string | null;
  has_login?: boolean;
  whatsapp_opt_in_at?: string | null;
}

export function CustomerPicker({ value, onChange }: { value: Customer | null; onChange: (c: Customer | null) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['customer-picker', q],
    enabled: q.trim().length >= 2 && !value,
    queryFn: () => api.get<Customer[]>(`/customers?q=${encodeURIComponent(q.trim())}&limit=6`),
  });
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
        <span>{fullName(value)} <span className="text-slate-500">· {value.customer_number}</span></span>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>Change</Button>
      </div>
    );
  }
  return (
    <div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email, phone or number" aria-label="Customer" />
      {results.data && results.data.length > 0 && (
        <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {results.data.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-900" onClick={() => onChange(c)}>
                {fullName(c)} <span className="text-slate-500">· {c.customer_number} {c.email || c.phone ? `· ${c.email ?? c.phone}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
