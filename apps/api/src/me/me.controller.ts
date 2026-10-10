import { Body, Controller, Get, Put } from '@nestjs/common';
import { packRules } from '@joybot/access';
import { z } from 'zod';
import { CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const employeeProfileSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    /** IANA name, or null to use the location or business default. */
    time_zone: z.string().min(1).max(64).nullable(),
  })
  .partial()
  .strict();

@Controller('me')
export class MeController {
  constructor(private readonly db: DbService) {}

  /** Who am I + permission rules for the frontend (@casl/react). */
  @Get()
  me(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => {
      const profile =
        p.type === 'employee'
          ? (await db.query(
              `SELECT id, employee_number, first_name, last_name, email, role, home_location_id, time_zone
                 FROM core.users WHERE id = $1`,
              [p.id],
            )).rows[0]
          : (await db.query(
              `SELECT id, customer_number, first_name, last_name, email, email_verified, phone, phone_verified,
                      organization_id, org_role, time_zone, preferred_location_id, whatsapp_opt_in_at, profile_completed_at
                 FROM core.customers WHERE id = $1`,
              [p.id],
            )).rows[0];
      return { type: p.type, role: p.role, profile, rules: packRules(p.access) };
    });
  }

  /** Employees edit their own name and time zone (customers use PUT /me in ProfileController). */
  @Put('employee')
  @EmployeesOnly()
  async updateEmployee(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(employeeProfileSchema)) body: z.infer<typeof employeeProfileSchema>) {
    await this.db.as(p, (db) => db.query('SELECT authz.update_own_employee_profile($1)', [JSON.stringify(body)]));
    return this.me(p);
  }
}
