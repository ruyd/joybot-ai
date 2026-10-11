import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { COLUMNS, createSchema, listSchema, TasksService, updateSchema, type CreateTask, type UpdateTask } from './tasks.service';

/**
 * Staff to-dos (migration 0020). RLS decides which tasks an employee sees and changes: 'own' scope
 * covers tasks assigned to or created by them, 'all' every task.
 */
@Controller('tasks')
@EmployeesOnly()
export class TasksController {
  constructor(
    private readonly db: DbService,
    private readonly tasks: TasksService,
  ) {}

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
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: CreateTask) {
    return this.tasks.create(p, body);
  }

  @Put(':id')
  @Can('update', 'tasks')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateSchema)) body: UpdateTask) {
    return this.tasks.update(p, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @Can('delete', 'tasks')
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.as(p, async (db) => {
      const deleted = (await db.query('DELETE FROM core.tasks WHERE id = $1', [id])).rowCount;
      if (!deleted) await this.tasks.notUpdatable(db, id);
    });
  }


}
