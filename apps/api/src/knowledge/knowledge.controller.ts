import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Can, CurrentPrincipal, EmployeesOnly, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.module';
import { actionsFor, searchKnowledge, splitSections } from './knowledge';

const audience = z.enum(['customer', 'employee', 'all']);
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase words separated by hyphens').max(80);

const articleSchema = z
  .object({
    slug,
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(500).nullable().optional(),
    body: z.string().max(100_000).default(''),
    audience: audience.default('all'),
    published: z.boolean().default(false),
  })
  .strict();

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('book'), service_id: z.string().uuid().nullable(), label: z.string().trim().max(60).optional() }).strict(),
  z.object({ type: z.literal('article'), article_id: z.string().uuid(), label: z.string().trim().max(60).optional() }).strict(),
]);

const answerSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    questions: z.array(z.string().trim().min(3).max(300)).max(30).default([]),
    body: z.string().trim().min(1).max(5000),
    actions: z.array(actionSchema).max(4).default([]),
    audience: audience.default('all'),
    active: z.boolean().default(true),
  })
  .strict();

const ARTICLE_COLUMNS = 'id, slug, title, summary, audience, published, created_at, updated_at';
const ANSWER_COLUMNS = 'id, title, questions, body, actions, audience, active, created_at, updated_at';

/**
 * Articles (Help pages) and saved answers for the assistant. Everyone reads what is meant for their
 * audience (RLS); editing needs the 'knowledge' permission (admins by default).
 */
@Controller()
export class KnowledgeController {
  constructor(private readonly db: DbService) {}

  // Articles -------------------------------------------------------------------------------------

  /** Help: published articles for this audience (editors also see drafts), optionally searched. */
  @Get('articles')
  @Can('read', 'knowledge')
  listArticles(@CurrentPrincipal() p: Principal, @Query('q') q?: string) {
    return this.db.as(p, async (db) => {
      const term = q?.trim();
      if (!term) return (await db.query(`SELECT ${ARTICLE_COLUMNS} FROM core.articles ORDER BY title`)).rows;
      return (
        await db.query(
          `SELECT ${ARTICLE_COLUMNS.split(', ').map((c) => `a.${c}`).join(', ')}
             FROM core.articles a
            WHERE a.title ILIKE '%' || $1 || '%'
               OR EXISTS (SELECT 1 FROM core.article_sections s
                           WHERE s.article_id = a.id AND s.search @@ websearch_to_tsquery('english', $1))
            ORDER BY a.title ILIKE '%' || $1 || '%' DESC, a.title`,
          [term.replace(/[\\%_]/g, '\\$&')],
        )
      ).rows;
    });
  }

  @Get('articles/:slug')
  @Can('read', 'knowledge')
  async article(@CurrentPrincipal() p: Principal, @Param('slug') s: string) {
    const row = await this.db.as(p, async (db) => (await db.query(`SELECT ${ARTICLE_COLUMNS}, body FROM core.articles WHERE slug = $1`, [s])).rows[0]);
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post('articles')
  @EmployeesOnly()
  @Can('create', 'knowledge')
  createArticle(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(articleSchema)) body: z.infer<typeof articleSchema>) {
    return this.db.as(p, async (db) => {
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO core.articles (slug, title, summary, body, audience, published, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
          [body.slug, body.title, body.summary || null, body.body, body.audience, body.published, p.id],
        )
      ).rows[0].id;
      await this.writeSections(db, id, body.body);
      return (await db.query(`SELECT ${ARTICLE_COLUMNS}, body FROM core.articles WHERE id = $1`, [id])).rows[0];
    });
  }

  @Put('articles/:id')
  @EmployeesOnly()
  @Can('update', 'knowledge')
  updateArticle(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(articleSchema)) body: z.infer<typeof articleSchema>,
  ) {
    return this.db.as(p, async (db) => {
      const updated = await db.query(
        `UPDATE core.articles SET slug = $2, title = $3, summary = $4, body = $5, audience = $6, published = $7, updated_by = $8
          WHERE id = $1`,
        [id, body.slug, body.title, body.summary || null, body.body, body.audience, body.published, p.id],
      );
      if (!updated.rowCount) throw new NotFoundException();
      await this.writeSections(db, id, body.body);
      return (await db.query(`SELECT ${ARTICLE_COLUMNS}, body FROM core.articles WHERE id = $1`, [id])).rows[0];
    });
  }

  @Delete('articles/:id')
  @HttpCode(204)
  @EmployeesOnly()
  @Can('delete', 'knowledge')
  async deleteArticle(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const deleted = await this.db.as(p, async (db) => (await db.query('DELETE FROM core.articles WHERE id = $1', [id])).rowCount);
    if (!deleted) throw new NotFoundException();
  }

  // Saved answers --------------------------------------------------------------------------------

  @Get('answers')
  @EmployeesOnly()
  @Can('update', 'knowledge')
  listAnswers(@CurrentPrincipal() p: Principal) {
    return this.db.as(p, async (db) => (await db.query(`SELECT ${ANSWER_COLUMNS} FROM core.answers ORDER BY title`)).rows);
  }

  @Post('answers')
  @EmployeesOnly()
  @Can('create', 'knowledge')
  createAnswer(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(answerSchema)) body: z.infer<typeof answerSchema>) {
    return this.db.as(p, async (db) => {
      await this.checkActions(db, body.actions);
      return (
        await db.query(
          `INSERT INTO core.answers (title, questions, body, actions, audience, active, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${ANSWER_COLUMNS}`,
          [body.title, body.questions, body.body, JSON.stringify(body.actions), body.audience, body.active, p.id],
        )
      ).rows[0];
    });
  }

  @Put('answers/:id')
  @EmployeesOnly()
  @Can('update', 'knowledge')
  updateAnswer(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(answerSchema)) body: z.infer<typeof answerSchema>,
  ) {
    return this.db.as(p, async (db) => {
      await this.checkActions(db, body.actions);
      const row = (
        await db.query(
          `UPDATE core.answers SET title = $2, questions = $3, body = $4, actions = $5, audience = $6, active = $7, updated_by = $8
            WHERE id = $1 RETURNING ${ANSWER_COLUMNS}`,
          [id, body.title, body.questions, body.body, JSON.stringify(body.actions), body.audience, body.active, p.id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException();
      return row;
    });
  }

  @Delete('answers/:id')
  @HttpCode(204)
  @EmployeesOnly()
  @Can('delete', 'knowledge')
  async deleteAnswer(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const deleted = await this.db.as(p, async (db) => (await db.query('DELETE FROM core.answers WHERE id = $1', [id])).rowCount);
    if (!deleted) throw new NotFoundException();
  }

  /** "Test a question": what the assistant would find for it when asked by a customer or by staff. */
  @Get('knowledge/match')
  @EmployeesOnly()
  @Can('update', 'knowledge')
  match(@CurrentPrincipal() p: Principal, @Query('q') q = '', @Query('as') as = 'customer') {
    const audienceFor = as === 'employee' ? 'employee' : 'customer';
    return this.db.as(p, async (db) => {
      const found = await searchKnowledge(db, q, audienceFor);
      return { ...found, actions: await actionsFor(db, found.answers, found.passages, audienceFor) };
    });
  }

  // ----------------------------------------------------------------------------------------------

  private async writeSections(db: PoolClient, articleId: string, markdown: string) {
    await db.query('DELETE FROM core.article_sections WHERE article_id = $1', [articleId]);
    const sections = splitSections(markdown);
    for (const [i, s] of sections.entries()) {
      await db.query('INSERT INTO core.article_sections (article_id, position, heading, body) VALUES ($1, $2, $3, $4)', [
        articleId,
        i,
        s.heading,
        s.body,
      ]);
    }
  }

  /** Actions must point at a real service or article. */
  private async checkActions(db: PoolClient, actions: z.infer<typeof actionSchema>[]) {
    for (const a of actions) {
      if (a.type === 'book' && a.service_id && !(await db.query('SELECT 1 FROM core.services WHERE id = $1', [a.service_id])).rowCount) {
        throw new BadRequestException('Unknown service in a Book action');
      }
      if (a.type === 'article' && !(await db.query('SELECT 1 FROM core.articles WHERE id = $1', [a.article_id])).rowCount) {
        throw new BadRequestException('Unknown article in a Read action');
      }
    }
  }
}
