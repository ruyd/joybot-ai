import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const listSchema = z
  .object({
    status: z.enum(['open', 'done', 'all']).default('open'),
    /** true: only tasks assigned to me. */
    mine: z.enum(['true', 'false']).optional(),
    customer_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(5000).optional(),
    due_on: isoDate.optional(),
    customer_id: z.string().uuid().optional(),
    /** Defaults to the creator. */
    assigned_to: z.string().uuid().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(5000).nullable(),
    due_on: isoDate.nullable(),
    customer_id: z.string().uuid().nullable(),
    assigned_to: z.string().uuid(),
    /** true completes the task (keeps the first completion), false reopens it. */
    done: z.boolean(),
  })
  .partial()
  .strict();

// Names come through RLS like everything else: a customer the employee cannot read shows as null.
const COLUMNS = `t.id, t.title, t.notes, t.due_on, t.customer_id, t.assigned_to, t.created_by,
  t.completed_at, t.completed_by, t.created_at, t.updated_at,
  (SELECT concat_ws(' ', s.first_name, s.last_name) FROM core.v_staff_public s WHERE s.id = t.assigned_to) AS assigned_to_name,
  (SELECT concat_ws(' ', s.first_name, s.last_name) FROM core.v_staff_public s WHERE s.id = t.created_by) AS created_by_name,
  (SELECT nullif(concat_ws(' ', c.first_name, c.last_name), '') FROM core.customers c WHERE c.id = t.customer_id) AS customer_name,
  (SELECT c.customer_number FROM core.customers c WHERE c.id = t.customer_id) AS customer_number`;

/**
 * Staff to-dos (migration 0020). RLS decides which tasks an employee sees and changes: 'own' scope
 * covers tasks assigned to or created by them, 'all' every task.
 */
@Controller('tasks')
@EmployeesOnly()
export class TasksController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Can('read', 'tasks')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replaceAll('?', `$${args.length}`));
    };
    if (q.status === 'open') where.push('t.completed_at IS NULL');
    if (q.status === 'done') where.push('t.completed_at IS NOT NULL');
    if (q.mine === 'true') add('t.assigned_to = ?', p.id);
    if (q.customer_id) add('t.customer_id = ?', q.customer_id);
    args.push(q.limit);
    const order = q.status === 'done' ? 't.completed_at DESC' : 't.completed_at IS NOT NULL, t.due_on NULLS LAST, t.created_at';
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `SELECT ${COLUMNS} FROM core.tasks t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY ${order} LIMIT $${args.length}`,
          args,
        )
      ).rows,
    );
  }

  /** Active employees a task can be assigned to (names only). */
  @Get('assignees')
  @Can('create', 'tasks')
  assignees(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) =>
      (await db.query('SELECT id, first_name, last_name FROM core.v_staff_public ORDER BY first_name, last_name')).rows,
    );
  }

  @Post()
  @Can('create', 'tasks')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.db.as(p, async (db) => {
      const assignee = body.assigned_to ?? p.id;
      await this.checkLinks(db, assignee, body.customer_id);
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO core.tasks (title, notes, due_on, customer_id, assigned_to, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [body.title, body.notes || null, body.due_on ?? null, body.customer_id ?? null, assignee, p.id],
        )
      ).rows[0].id;
      return this.load(db, id);
    });
  }

  @Put(':id')
  @Can('update', 'tasks')
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.db.as(p, async (db) => {
      await this.checkLinks(db, body.assigned_to, body.customer_id ?? undefined);
      const sets: string[] = [];
      const args: unknown[] = [id];
      const set = (column: string, v: unknown) => {
        args.push(v);
        sets.push(`${column} = $${args.length}`);
      };
      if (body.title !== undefined) set('title', body.title);
      if (body.notes !== undefined) set('notes', body.notes || null);
      if (body.due_on !== undefined) set('due_on', body.due_on);
      if (body.customer_id !== undefined) set('customer_id', body.customer_id);
      if (body.assigned_to !== undefined) set('assigned_to', body.assigned_to);
      if (body.done === true) {
        args.push(p.id);
        sets.push('completed_at = coalesce(completed_at, now())', `completed_by = coalesce(completed_by, $${args.length})`);
      }
      if (body.done === false) sets.push('completed_at = NULL', 'completed_by = NULL');
      if (sets.length) {
        const updated = (await db.query(`UPDATE core.tasks SET ${sets.join(', ')} WHERE id = $1`, args)).rowCount;
        if (!updated) await this.notUpdatable(db, id);
      }
      const task = await this.load(db, id);
      if (!task) throw new NotFoundException();
      return task;
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @Can('delete', 'tasks')
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.as(p, async (db) => {
      const deleted = (await db.query('DELETE FROM core.tasks WHERE id = $1', [id])).rowCount;
      if (!deleted) await this.notUpdatable(db, id);
    });
  }

  private async load(db: PoolClient, id: string) {
    return (await db.query(`SELECT ${COLUMNS} FROM core.tasks t WHERE t.id = $1`, [id])).rows[0];
  }

  /** Clear errors before RLS would refuse the write: unknown assignee or customer. */
  private async checkLinks(db: PoolClient, assignee?: string, customerId?: string) {
    if (assignee && !(await db.query('SELECT 1 FROM core.v_staff_public WHERE id = $1', [assignee])).rowCount) {
      throw new BadRequestException('Assignee must be an active employee');
    }
    if (customerId && !(await db.query('SELECT 1 FROM core.customers WHERE id = $1', [customerId])).rowCount) {
      throw new NotFoundException('Customer not found');
    }
  }

  /** Nothing changed: the task is either invisible (404) or visible but outside the caller's write scope (403). */
  private async notUpdatable(db: PoolClient, id: string): Promise<never> {
    if ((await db.query('SELECT 1 FROM core.tasks WHERE id = $1', [id])).rowCount) throw new ForbiddenException();
    throw new NotFoundException();
  }
}
