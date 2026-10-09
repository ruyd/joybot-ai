import { Controller, Get } from '@nestjs/common';
import { packRules } from '@joybot/access';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { DbService } from '../db/db.module';

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
              `SELECT id, customer_number, first_name, last_name, email, phone, organization_id, org_role,
                      time_zone, preferred_location_id, whatsapp_opt_in_at, profile_completed_at
                 FROM core.customers WHERE id = $1`,
              [p.id],
            )).rows[0];
      return { type: p.type, role: p.role, profile, rules: packRules(p.access) };
    });
  }
}
