import { createMongoAbility, type MongoAbility } from '@casl/ability';

/** Permission rules from GET /api/me (mirrors core.role_permissions; the API and RLS enforce them). */
export type Ability = MongoAbility<[string, string]>;

export function buildAbility(rules: { action: string; subject: string }[]): Ability {
  return createMongoAbility<[string, string]>(rules);
}
