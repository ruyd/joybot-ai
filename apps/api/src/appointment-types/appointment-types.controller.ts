import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const color = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'Use a color like #3b82f6');

export const createTypeSchema = z
  .object({ name: z.string().trim().min(1).max(60), color, sort_order: z.number().int().min(0).max(10_000).optional() })
  .strict();
export const updateTypeSchema = createTypeSchema
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

type CreateType = z.infer<typeof createTypeSchema>;
type UpdateType = z.infer<typeof updateTypeSchema>;

const COLUMNS = 'id, key, name, color, system, sort_order';

/** "Window cleaning!" → "window_cleaning" (letters, digits and underscores, starting with a letter). */
function keyFor(name: string): string {
  const key = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return /^[a-z]/.test(key) ? key : `type_${key}`.slice(0, 32);
}

/**
 * Appointment types: a name and a color label for each kind of appointment. Everyone signed in reads
 * them; whoever may edit services adds, renames, recolors and deletes them. System types (sales calls)
 * are read-only, which the database also enforces.
 */
@Controller('appointment-types')
export class AppointmentTypesController {
  constructor(private readonly db: DbService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => (await db.query(`SELECT ${COLUMNS} FROM core.appointment_types ORDER BY sort_order, name`)).rows);
  }

  @Post()
  @EmployeesOnly()
  @Can('create', 'services')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createTypeSchema)) body: CreateType) {
    return this.db.as(p, async (db) => {
      if ((await db.query('SELECT 1 FROM core.appointment_types WHERE lower(name) = lower($1)', [body.name])).rowCount) {
        throw new ConflictException('A type with that name already exists');
      }
      // A unique key from the name (window_cleaning, window_cleaning_2, …).
      const base = keyFor(body.name);
      const taken = new Set((await db.query<{ key: string }>('SELECT key FROM core.appointment_types WHERE key LIKE $1', [`${base}%`])).rows.map((r) => r.key));
      let key = base;
      for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 28)}_${n}`;
      const sort = body.sort_order ?? (await db.query<{ next: number }>('SELECT coalesce(max(sort_order), 0) + 10 AS next FROM core.appointment_types')).rows[0].next;
      return (
        await db.query(`INSERT INTO core.appointment_types (key, name, color, sort_order) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`, [key, body.name, body.color, sort])
      ).rows[0];
    });
  }

  @Put(':id')
  @EmployeesOnly()
  @Can('update', 'services')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateTypeSchema)) body: UpdateType) {
    return this.db.as(p, async (db) => {
      if (body.name && (await db.query('SELECT 1 FROM core.appointment_types WHERE lower(name) = lower($1) AND id <> $2', [body.name, id])).rowCount) {
        throw new ConflictException('A type with that name already exists');
      }
      const cols = Object.keys(body) as (keyof UpdateType)[];
      const row = (
        await db.query(
          `UPDATE core.appointment_types SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
          [id, ...cols.map((c) => body[c])],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Appointment type not found');
      return row;
    });
  }

  /** Only types no appointment uses (change those appointments' type first). */
  @Delete(':id')
  @HttpCode(204)
  @EmployeesOnly()
  @Can('delete', 'services')
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.as(p, async (db) => {
      const used = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM core.appointments WHERE type_id = $1', [id])).rows[0].n;
      if (used) throw new ConflictException(`${used} appointment${used === 1 ? ' uses' : 's use'} this type; change them first`);
      const res = await db.query('DELETE FROM core.appointment_types WHERE id = $1', [id]);
      if (!res.rowCount) throw new NotFoundException('Appointment type not found');
    });
  }
}
