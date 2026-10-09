import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { buildAbility } from './ability';
import { useApi } from './api';
import { useSession } from './auth';

export interface Me {
  type: 'employee' | 'customer';
  role: 'admin' | 'staff' | 'org_admin' | 'customer';
  profile: { id: string; first_name?: string | null; last_name?: string | null; email?: string | null; [k: string]: unknown };
  rules: { action: string; subject: string }[];
}

/** Signed-in principal + permission rules (GET /api/me). */
export function useMe() {
  const api = useApi();
  const { audience } = useSession();
  const query = useQuery({ queryKey: ['me', audience], queryFn: () => api.get<Me>('/me'), staleTime: 60_000 });
  const ability = useMemo(() => buildAbility(query.data?.rules ?? []), [query.data]);
  return { ...query, me: query.data, can: (action: string, subject: string) => ability.can(action, subject) };
}
