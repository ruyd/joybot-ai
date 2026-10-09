import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { ChatService } from './chat.service';

const createSchema = z.object({ title: z.string().trim().max(120).optional() }).strict();
const messageSchema = z.object({ content: z.string().trim().min(1).max(2000) }).strict();
const scopeSchema = z
  .object({ customer_id: z.string().uuid().nullable().optional(), organization_id: z.string().uuid().nullable().optional() })
  .strict()
  .refine((s) => !(s.customer_id && s.organization_id), { message: 'choose a customer or an organization, not both' });

const COLUMNS = 'id, title, active_customer_id, active_organization_id, created_at, updated_at';

/** Conversations belong to their principal (RLS on app.conversations). */
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly db: DbService,
    private readonly chat: ChatService,
  ) {}

  @Get()
  list(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => (await db.query(`SELECT ${COLUMNS} FROM app.conversations ORDER BY updated_at DESC LIMIT 100`)).rows);
  }

  @Post()
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.db.as(p, async (db) =>
      (
        await db.query(
          `INSERT INTO app.conversations (principal_type, principal_id, title) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
          [p.type, p.id, body.title ?? null],
        )
      ).rows[0],
    );
  }

  @Get(':id/messages')
  async messages(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.chat.assertConversation(p, id);
    return this.db.as(p, async (db) =>
      (await db.query('SELECT id, role, content, citations, created_at FROM app.messages WHERE conversation_id = $1 ORDER BY created_at', [id])).rows,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const deleted = await this.db.as(p, async (db) => (await db.query('DELETE FROM app.conversations WHERE id = $1', [id])).rowCount);
    if (!deleted) throw new NotFoundException();
  }

  /** Employees pin (or clear) the customer or organization a conversation is about. */
  @Put(':id/scope')
  @EmployeesOnly()
  async scope(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(scopeSchema)) body: z.infer<typeof scopeSchema>,
  ) {
    await this.chat.assertConversation(p, id);
    return this.db.as(p, async (db) => {
      if (body.customer_id && !(await db.query('SELECT 1 FROM core.customers WHERE id = $1', [body.customer_id])).rowCount) {
        throw new NotFoundException('Customer not found');
      }
      if (body.organization_id && !(await db.query('SELECT 1 FROM core.organizations WHERE id = $1', [body.organization_id])).rowCount) {
        throw new NotFoundException('Organization not found');
      }
      return (
        await db.query(
          `UPDATE app.conversations SET active_customer_id = $2, active_organization_id = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
          [id, body.customer_id ?? null, body.organization_id ?? null],
        )
      ).rows[0];
    });
  }

  /** Sends a message and streams the answer as server-sent events (plan.md §5.2). */
  @Post(':id/messages')
  async send(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(messageSchema)) body: z.infer<typeof messageSchema>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.chat.assertConversation(p, id);
    await this.chat.assertQuota(p);
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    const abort = new AbortController();
    req.on('close', () => abort.abort());
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    try {
      await this.chat.respond(p, id, body.content, {
        signal: abort.signal,
        event: (name, data) => {
          if (!abort.signal.aborted) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        },
      });
    } catch (err) {
      if (!abort.signal.aborted) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Something went wrong. Please try again.' })}\n\n`);
      }
      if (!(err instanceof Error && err.name === 'AbortError')) console.error(err);
    } finally {
      clearInterval(keepAlive);
      res.end();
    }
  }
}
