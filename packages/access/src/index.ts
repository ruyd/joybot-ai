import { createMongoAbility, type MongoAbility } from '@casl/ability';

/** Mirrors core.role_permissions (plan.md §4.2). The database (RLS) enforces record scope;
 *  this ability answers "may this principal do X on resource Y at all, and in which scopes?". */
export const RESOURCES = [
  'customers', 'organizations', 'appointments', 'payments', 'services', 'locations',
  'tickets', 'users', 'settings', 'audit', 'notes_internal', 'access',
] as const;
export const ACTIONS = ['read', 'create', 'update', 'delete', 'void', 'refund'] as const;
export const SCOPES = [
  'all_including_restricted', 'all', 'location', 'assigned', 'own', 'recorded', 'org', 'self',
] as const;
export const ROLES = ['admin', 'staff', 'org_admin', 'customer'] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type Scope = (typeof SCOPES)[number];
export type Role = (typeof ROLES)[number];

export interface PermissionRow {
  role: Role;
  resource: Resource;
  action: Action;
  scope: Scope;
}

export type AppAbility = MongoAbility<[Action, Resource]>;

export interface Access {
  role: Role;
  ability: AppAbility;
  can(action: Action, resource: Resource): boolean;
  scopes(action: Action, resource: Resource): Scope[];
}

export function buildAccess(role: Role, rows: readonly PermissionRow[]): Access {
  const mine = rows.filter((r) => r.role === role);
  const ability = createMongoAbility<[Action, Resource]>(
    mine.map((r) => ({ action: r.action, subject: r.resource })),
  );
  return {
    role,
    ability,
    can: (action, resource) => ability.can(action, resource),
    scopes: (action, resource) =>
      [...new Set(mine.filter((r) => r.action === action && r.resource === resource).map((r) => r.scope))],
  };
}

/** Serializable rules for the frontend (@casl/react). */
export function packRules(access: Access): { action: Action; subject: Resource }[] {
  return access.ability.rules.map((r) => ({ action: r.action as Action, subject: r.subject as Resource }));
}
