import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Access, Action, Resource, Role } from '@joybot/access';
import type { DbPrincipal } from '@joybot/db';

export interface Principal extends DbPrincipal {
  role: Role;
  access: Access;
}

export const IS_PUBLIC = 'joybot:public';
export const REQUIRES = 'joybot:requires';

/** Route needs no authentication (health checks, signed webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route requires the principal's role to allow this action on this resource (any scope).
 *  Record-level scope is enforced by Postgres RLS. */
export const Can = (action: Action, resource: Resource) => SetMetadata(REQUIRES, { action, resource });

/** Route is for one audience only. */
export const AUDIENCE = 'joybot:audience';
export const EmployeesOnly = () => SetMetadata(AUDIENCE, 'employee');
export const CustomersOnly = () => SetMetadata(AUDIENCE, 'customer');

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().principal;
});
