import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';

const messageSchema = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
const directSchema = z.object({ user_id: z.string().uuid() }).strict();
const groupSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    member_ids: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();
const membersSchema = z.object({ member_ids: z.array(z.string().uuid()).min(1).max(100) }).strict();
const listSchema = z
  .object({
    /** Only messages after this one (polling), or before it (older pages). */
    after: z.string().datetime({ offset: true }).optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const STAFF_NAME = (col: string) => `(SELECT nullif(concat_ws(' ', s.first_name, s.last_name), '') FROM core.v_staff_public s WHERE s.id = ${col})`;

/**
 * Team chat (migration 0024): "everyone", direct messages, group channels and each employee's
 * notifications channel. RLS limits every query to the channels the employee can see; channels are
 * created through SECURITY DEFINER functions that check who may be added. Clients poll.
 */
@Controller('team')
@EmployeesOnly()
export class TeamController {
  constructor(private readonly db: DbService) {}

  /** The caller's channels with a display name, members, the last message and the unread count. */
  @Get('channels')
  channels(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => {
      await db.query('SELECT app.team_join_defaults()');
      return (
        await db.query(
          `SELECT c.id, c.kind,
                  CASE c.kind WHEN 'everyone' THEN 'Everyone' WHEN 'notifications' THEN 'Notifications'
                    WHEN 'group' THEN c.name
                    ELSE (SELECT ${STAFF_NAME('m.user_id')} FROM app.team_members m WHERE m.channel_id = c.id AND m.user_id <> $1 LIMIT 1)
                  END AS name,
                  CASE WHEN c.kind IN ('direct', 'group') THEN
                    (SELECT coalesce(json_agg(json_build_object('id', m.user_id, 'name', ${STAFF_NAME('m.user_id')}) ORDER BY m.joined_at), '[]')
                       FROM app.team_members m WHERE m.channel_id = c.id)
                  END AS members,
                  (SELECT json_build_object('id', x.id, 'body', left(x.body, 200), 'created_at', x.created_at,
                                            'sender_id', x.sender_id, 'sender_name', ${STAFF_NAME('x.sender_id')}, 'link', x.link)
                     FROM app.team_messages x WHERE x.channel_id = c.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS last_message,
                  (SELECT count(*)::int FROM app.team_messages x
                    WHERE x.channel_id = c.id AND x.sender_id IS DISTINCT FROM $1
                      AND x.created_at > coalesce((SELECT m.last_read_at FROM app.team_members m WHERE m.channel_id = c.id AND m.user_id = $1), 'infinity')
                  ) AS unread
             FROM app.team_channels c
            ORDER BY CASE c.kind WHEN 'notifications' THEN 0 WHEN 'everyone' THEN 1 WHEN 'group' THEN 2 ELSE 3 END,
                     (SELECT max(x.created_at) FROM app.team_messages x WHERE x.channel_id = c.id) DESC NULLS LAST, c.created_at`,
          [p.id],
        )
      ).rows;
    });
  }

  /** Messages, oldest first: the newest page, or those after/before a time. */
  @Get('channels/:id/messages')
  messages(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) {
    return this.db.as(p, async (db) => {
      if (!(await db.query('SELECT 1 FROM app.team_channels WHERE id = $1', [id])).rowCount) throw new NotFoundException();
      const rows = (
        await db.query(
          `SELECT x.id, x.channel_id, x.sender_id, ${STAFF_NAME('x.sender_id')} AS sender_name, x.body, x.link, x.created_at
             FROM app.team_messages x
            WHERE x.channel_id = $1 AND ($2::timestamptz IS NULL OR x.created_at > $2) AND ($3::timestamptz IS NULL OR x.created_at < $3)
            ORDER BY x.created_at ${q.after ? 'ASC' : 'DESC'}, x.id
            LIMIT $4`,
          [id, q.after ?? null, q.before ?? null, q.limit],
        )
      ).rows;
      return q.after ? rows : rows.reverse();
    });
  }

  @Post('channels/:id/messages')
  send(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(messageSchema)) body: z.infer<typeof messageSchema>) {
    // RLS: a channel the caller can see, not a notifications channel (42501 → 403).
    return this.db.as(p, async (db) => {
      const row = (
        await db.query(`INSERT INTO app.team_messages (channel_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id, channel_id, sender_id, body, link, created_at`, [
          id,
          p.id,
          body.body,
        ])
      ).rows[0];
      await db.query(
        `INSERT INTO app.team_members (channel_id, user_id, last_read_at) VALUES ($1, $2, now())
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = now()`,
        [id, p.id],
      );
      return row;
    });
  }

  /** Marks the channel read up to now. */
  @Post('channels/:id/read')
  @HttpCode(204)
  async read(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.as(p, async (db) => {
      if (!(await db.query('SELECT 1 FROM app.team_channels WHERE id = $1', [id])).rowCount) throw new NotFoundException();
      await db.query(
        `INSERT INTO app.team_members (channel_id, user_id, last_read_at) VALUES ($1, $2, now())
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = now()`,
        [id, p.id],
      );
    });
  }

  /** Opens (or creates) the direct-message channel with a colleague. */
  @Post('direct')
  direct(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(directSchema)) body: z.infer<typeof directSchema>) {
    return this.db.as(p, async (db) => ({ id: (await db.query<{ id: string }>('SELECT app.team_open_direct($1) AS id', [body.user_id])).rows[0].id }));
  }

  /** A named channel of chosen colleagues (the caller is added). */
  @Post('channels')
  group(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(groupSchema)) body: z.infer<typeof groupSchema>) {
    return this.db.as(p, async (db) => ({
      id: (await db.query<{ id: string }>('SELECT app.team_create_group($1, $2) AS id', [body.name, body.member_ids])).rows[0].id,
    }));
  }

  @Post('channels/:id/members')
  @HttpCode(204)
  async addMembers(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(membersSchema)) body: z.infer<typeof membersSchema>) {
    await this.db.as(p, (db) => db.query('SELECT app.team_add_members($1, $2)', [id, body.member_ids]));
  }

  /** Leaves a group channel. */
  @Post('channels/:id/leave')
  @HttpCode(204)
  async leave(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const left = await this.db.as(p, async (db) => (await db.query('DELETE FROM app.team_members WHERE channel_id = $1 AND user_id = $2', [id, p.id])).rowCount);
    if (!left) throw new NotFoundException();
  }

  /** Colleagues to message (active employees, names only). */
  @Get('people')
  people(@CurrentPrincipal() p: Principal) {
    return this.db.as(
      p,
      async (db) => (await db.query('SELECT id, first_name, last_name FROM core.v_staff_public WHERE id <> $1 ORDER BY first_name, last_name', [p.id])).rows,
    );
  }
}
