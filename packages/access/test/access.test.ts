import { describe, expect, it } from 'vitest';
import { buildAccess, type PermissionRow } from '../src';

const rows: PermissionRow[] = [
  { role: 'staff', resource: 'payments', action: 'create', scope: 'location' },
  { role: 'staff', resource: 'payments', action: 'create', scope: 'assigned' },
  { role: 'staff', resource: 'payments', action: 'update', scope: 'recorded' },
  { role: 'admin', resource: 'payments', action: 'void', scope: 'all_including_restricted' },
];

describe('buildAccess', () => {
  it('grants only the role’s own permissions', () => {
    const staff = buildAccess('staff', rows);
    expect(staff.can('create', 'payments')).toBe(true);
    expect(staff.can('void', 'payments')).toBe(false);
    expect(buildAccess('admin', rows).can('void', 'payments')).toBe(true);
  });

  it('lists scopes per action and resource', () => {
    expect(buildAccess('staff', rows).scopes('create', 'payments').sort()).toEqual(['assigned', 'location']);
    expect(buildAccess('customer', rows).scopes('read', 'payments')).toEqual([]);
  });
});
