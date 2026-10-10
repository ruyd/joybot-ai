import type { PoolClient } from 'pg';

/**
 * Knowledge for the assistant (migration 0021): saved answers and articles. Shared by chat (on the
 * reader role) and the API (editing, Help pages, "test a question"). Everything runs under RLS, so a
 * principal only finds what is meant for their audience.
 */

/** Buttons offered with an answer. The model never writes them: they come from saved answers and articles. */
export type ChatAction =
  | { type: 'book'; label: string; service_id: string | null }
  | { type: 'article'; label: string; slug: string };

/** Stored on a saved answer (validated when saved). */
export type AnswerAction = { type: 'book'; service_id: string | null; label?: string } | { type: 'article'; article_id: string; label?: string };

export interface AnswerHit {
  id: string;
  title: string;
  body: string;
  actions: AnswerAction[];
  score: number;
}

export interface PassageHit {
  article_id: string;
  slug: string;
  title: string;
  heading: string | null;
  body: string;
  score: number;
}

/**
 * A matched example question this close (trigram similarity) counts even without shared keywords.
 * Measured on the sample answers: real matches score 0.62+, look-alikes such as "Do I have any
 * appointments?" against "How do I cancel an appointment?" up to 0.50.
 */
const QUESTION_SIMILARITY = 0.55;
/** A second answer is kept only when it scores this close to the best one (avoids stray buttons). */
const RUNNER_UP = 0.75;
/** Normalized ts_rank_cd (rank / (rank + 1)) a passage needs to be offered. */
const PASSAGE_RANK = 0.1;
const SECTION_MAX = 1200;

/**
 * Splits markdown into passages for search: one per heading, long ones cut at paragraph breaks.
 * Text before the first heading is the introduction (no heading).
 */
export function splitSections(markdown: string): { heading: string | null; body: string }[] {
  const out: { heading: string | null; body: string }[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join('\n').trim();
    lines = [];
    if (!text && !heading) return;
    let chunk = '';
    for (const para of text.split(/\n\s*\n/)) {
      if (chunk && chunk.length + para.length > SECTION_MAX) {
        out.push({ heading, body: chunk.trim() });
        chunk = '';
      }
      chunk += `${para}\n\n`;
    }
    if (chunk.trim() || heading) out.push({ heading, body: chunk.trim() || heading! });
  };
  for (const line of markdown.split('\n')) {
    const h = /^#{1,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      heading = h[1];
    } else {
      lines.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Saved answers and article passages for a question, as seen by `audience`: only active answers and
 * published articles meant for it (editors can read everything, so the audience is applied here too).
 */
export async function searchKnowledge(
  db: PoolClient,
  query: string,
  audience: 'customer' | 'employee',
  limits = { answers: 2, passages: 2 },
) {
  const q = query.trim().slice(0, 500);
  if (q.length < 3) return { answers: [] as AnswerHit[], passages: [] as PassageHit[] };
  const answers = (
    await db.query<AnswerHit>(
      `SELECT a.id, a.title, a.body, a.actions,
              greatest((SELECT max(similarity(lower($1), lower(x))) FROM unnest(a.questions) x),
                       ts_rank_cd(a.search, websearch_to_tsquery('english', $1), 32)) AS score
         FROM core.answers a
        WHERE a.active AND a.audience IN ($4, 'all')
          -- Keywords count when at least two of them match: one shared word ("appointment") is not enough.
          AND ((numnode(websearch_to_tsquery('english', $1)) >= 3 AND a.search @@ websearch_to_tsquery('english', $1))
               OR (SELECT max(similarity(lower($1), lower(x))) FROM unnest(a.questions) x) >= $2)
        ORDER BY score DESC, a.title
        LIMIT $3`,
      [q, QUESTION_SIMILARITY, limits.answers, audience],
    )
  ).rows.filter((a, _, all) => a.score >= all[0].score * RUNNER_UP);
  // Best passage per article.
  const passages = (
    await db.query<PassageHit>(
      `SELECT DISTINCT ON (s.article_id) s.article_id, a.slug, a.title, s.heading, s.body,
              ts_rank_cd(s.search, websearch_to_tsquery('english', $1), 32) AS score
         FROM core.article_sections s JOIN core.articles a ON a.id = s.article_id
        WHERE a.published AND a.audience IN ($3, 'all')
          AND numnode(websearch_to_tsquery('english', $1)) >= 3 -- two or more keywords, as for answers
          AND s.search @@ websearch_to_tsquery('english', $1)
          AND ts_rank_cd(s.search, websearch_to_tsquery('english', $1), 32) >= $2
        ORDER BY s.article_id, score DESC`,
      [q, PASSAGE_RANK, audience],
    )
  ).rows
    .sort((x, y) => y.score - x.score)
    .slice(0, limits.passages);
  return { answers, passages };
}

/**
 * Buttons for the matched answers and articles, checked against what is live and visible now:
 * an inactive service or an article the principal cannot read is dropped. At most four.
 */
export async function actionsFor(
  db: PoolClient,
  answers: AnswerHit[],
  passages: PassageHit[],
  audience: 'customer' | 'employee',
): Promise<ChatAction[]> {
  const out: ChatAction[] = [];
  const seen = new Set<string>();
  const add = (key: string, action: ChatAction) => {
    if (!seen.has(key) && out.length < 4) {
      seen.add(key);
      out.push(action);
    }
  };
  for (const a of answers) {
    for (const act of a.actions ?? []) {
      if (act.type === 'book') {
        if (act.service_id) {
          const s = (await db.query<{ name: string }>('SELECT name FROM core.services WHERE id = $1 AND active', [act.service_id])).rows[0];
          if (s) add(`book:${act.service_id}`, { type: 'book', label: act.label || `Book ${s.name.toLowerCase()}`, service_id: act.service_id });
        } else {
          add('book:', { type: 'book', label: act.label || 'Book an appointment', service_id: null });
        }
      } else if (act.type === 'article') {
        const art = (
          await db.query<{ slug: string; title: string }>(
            `SELECT slug, title FROM core.articles WHERE id = $1 AND published AND audience IN ($2, 'all')`,
            [act.article_id, audience],
          )
        ).rows[0];
        if (art) add(`article:${art.slug}`, { type: 'article', label: act.label || `Read: ${art.title}`, slug: art.slug });
      }
    }
  }
  for (const p of passages) add(`article:${p.slug}`, { type: 'article', label: `Read: ${p.title}`, slug: p.slug });
  return out;
}
