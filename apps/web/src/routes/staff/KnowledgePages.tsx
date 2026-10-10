import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date } from '../../lib/format';
import { useMe } from '../../lib/me';

type Audience = 'customer' | 'employee' | 'all';
const AUDIENCE_LABEL: Record<Audience, string> = { all: 'Everyone', customer: 'Customers', employee: 'Staff' };

type AnswerAction = { type: 'book'; service_id: string | null; label?: string } | { type: 'article'; article_id: string; label?: string };

interface Answer {
  id: string;
  title: string;
  questions: string[];
  body: string;
  actions: AnswerAction[];
  audience: Audience;
  active: boolean;
  updated_at: string;
}

interface Article {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  body?: string;
  audience: Audience;
  published: boolean;
  updated_at: string;
}

interface Service {
  id: string;
  name: string;
}

/** Full-width list row: hover, pressed and selected states, and a keyboard focus ring. */
const rowClass = (selected: boolean) =>
  `block w-full px-4 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
    selected
      ? 'bg-brand-50 shadow-[inset_3px_0_0] shadow-brand-600 dark:bg-slate-800'
      : 'hover:bg-slate-100 active:bg-slate-200 dark:hover:bg-slate-800/70 dark:active:bg-slate-700'
  }`;

const PAGE_SIZE = 50;

/** The value after it has stopped changing for `ms` (search as you type without a request per key). */
function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const textarea =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900';

const TABS = [
  ['answers', 'Saved answers'],
  ['articles', 'Articles'],
  ['test', 'Test a question'],
] as const;

/** Admin: what the assistant knows (saved answers, help articles) and a preview of what it finds. */
export function Knowledge() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('answers');
  return (
    <Page>
      <PageHeader
        title="Answers"
        description="Saved answers and articles the assistant uses. It cites them and offers their buttons (book, read an article)."
      />
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${tab === key ? 'bg-brand-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-900'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'answers' && <Answers />}
      {tab === 'articles' && <Articles />}
      {tab === 'test' && <TestQuestion />}
    </Page>
  );
}

// Saved answers --------------------------------------------------------------------------------

function Answers() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [audience, setAudience] = useState<'' | Audience>('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [sort, setSort] = useState<'title' | 'updated'>('title');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Answer | 'new' | null>(null);
  const term = useDebounced(q.trim());

  // A new search or filter starts from the first page.
  useEffect(() => setOffset(0), [term, audience, active, sort]);

  const params = new URLSearchParams({ sort, limit: String(PAGE_SIZE), offset: String(offset) });
  if (term) params.set('q', term);
  if (audience) params.set('audience', audience);
  if (active) params.set('active', active);
  const list = useQuery({
    queryKey: ['answers', params.toString()],
    queryFn: () => api.get<{ items: Answer[]; total: number }>(`/answers?${params}`),
    placeholderData: keepPreviousData,
  });
  const total = list.data?.total ?? 0;
  const items = list.data?.items ?? [];
  const filtered = Boolean(term || audience || active);

  return (
    <div className={`grid items-start gap-4 ${editing ? 'lg:grid-cols-[minmax(0,1fr)_32rem] xl:grid-cols-[minmax(0,1fr)_38rem]' : ''}`}>
      <Card title="Saved answers" actions={<Button size="sm" onClick={() => setEditing('new')}>New answer</Button>}>
        <div className="mb-3 grid gap-2">
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, questions and text" aria-label="Search answers" />
          <div className="flex flex-wrap gap-2 [&>select]:min-w-36 [&>select]:flex-1">
            <Select aria-label="Shown to" value={audience} onChange={(e) => setAudience(e.target.value as '' | Audience)}>
              <option value="">Any audience</option>
              {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((k) => (
                <option key={k} value={k}>{AUDIENCE_LABEL[k]}</option>
              ))}
            </Select>
            <Select aria-label="Status" value={active} onChange={(e) => setActive(e.target.value as '' | 'true' | 'false')}>
              <option value="">On and off</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </Select>
            <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as 'title' | 'updated')}>
              <option value="title">A–Z</option>
              <option value="updated">Recently edited</option>
            </Select>
          </div>
        </div>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <ErrorBanner error={list.error} />
        ) : !items.length ? (
          <EmptyState>{filtered ? 'No answers match.' : 'No saved answers yet.'}</EmptyState>
        ) : (
          <>
            <ul className={`-mx-4 divide-y divide-slate-100 border-y border-slate-100 dark:divide-slate-800 dark:border-slate-800 ${list.isPlaceholderData ? 'opacity-60' : ''}`}>
              {items.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setEditing(a)}
                    aria-current={editing !== 'new' && editing?.id === a.id ? 'true' : undefined}
                    className={rowClass(editing !== 'new' && editing?.id === a.id)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate font-medium">{a.title}</span>
                      <span className="flex shrink-0 gap-1 whitespace-nowrap">
                        <Badge>{AUDIENCE_LABEL[a.audience]}</Badge>
                        {!a.active && <Badge tone="amber">off</Badge>}
                        {a.actions.length > 0 && <Badge tone="brand">{a.actions.length} button{a.actions.length === 1 ? '' : 's'}</Badge>}
                      </span>
                      <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-slate-400">{date(a.updated_at)}</span>
                    </span>
                    <span className="block truncate text-sm text-slate-500">{a.questions.join(' · ') || 'No example questions'}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center justify-between gap-2 text-sm text-slate-500">
              <span aria-live="polite">
                {offset + 1}–{offset + items.length} of {total}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={offset === 0 || list.isFetching} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  Previous
                </Button>
                <Button size="sm" variant="secondary" disabled={offset + PAGE_SIZE >= total || list.isFetching} onClick={() => setOffset(offset + PAGE_SIZE)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
      {editing && (
        <div className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-10rem)] lg:overflow-y-auto">
          <AnswerEditor key={editing === 'new' ? 'new' : editing.id} answer={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />
        </div>
      )}
    </div>
  );
}

function AnswerEditor({ answer, onDone }: { answer?: Answer; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get<Service[]>('/services') });
  const articles = useQuery({ queryKey: ['articles', ''], queryFn: () => api.get<Article[]>('/articles') });
  const [title, setTitle] = useState(answer?.title ?? '');
  const [questions, setQuestions] = useState(answer?.questions.join('\n') ?? '');
  const [body, setBody] = useState(answer?.body ?? '');
  const [audience, setAudience] = useState<Audience>(answer?.audience ?? 'all');
  const [active, setActive] = useState(answer?.active ?? true);
  const [actions, setActions] = useState<AnswerAction[]>(answer?.actions ?? []);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['answers'] });
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        title,
        questions: questions.split('\n').map((q) => q.trim()).filter(Boolean),
        body,
        audience,
        active,
        actions: actions.map((a) => (a.label?.trim() ? { ...a, label: a.label.trim() } : { ...a, label: undefined })),
      };
      return answer ? api.put(`/answers/${answer.id}`, payload) : api.post('/answers', payload);
    },
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/answers/${answer!.id}`),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const setAction = (i: number, a: AnswerAction) => setActions(actions.map((x, j) => (j === i ? a : x)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Card title={answer ? 'Edit answer' : 'New answer'}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Title">
          <Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Rescheduling or cancelling" />
        </Field>
        <Field label="Example questions" hint="One per line. The assistant matches questions like these, in other words too.">
          <textarea rows={4} className={textarea} value={questions} onChange={(e) => setQuestions(e.target.value)} placeholder={'How do I reschedule?\nCan I move my booking?'} />
        </Field>
        <Field label="Answer" hint="What the assistant should say. It may adapt the wording but keeps the meaning.">
          <textarea
            required
            rows={14}
            maxLength={5000}
            className={`${textarea} min-h-72 resize-y leading-relaxed`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className={`block text-right text-xs ${body.length > 4500 ? 'text-amber-700' : 'text-slate-400'}`}>{body.length.toLocaleString()} / 5,000</span>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shown to">
            <Select value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
              {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((k) => (
                <option key={k} value={k}>{AUDIENCE_LABEL[k]}</option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
          </label>
        </div>

        <fieldset className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-sm font-medium">Buttons (up to 4)</legend>
          {actions.length === 0 && <p className="text-sm text-slate-500">No buttons. Add one to let people book or read an article from the answer.</p>}
          {actions.map((a, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Select
                aria-label="Button type"
                value={a.type}
                onChange={(e) =>
                  setAction(i, e.target.value === 'book' ? { type: 'book', service_id: null } : { type: 'article', article_id: articles.data?.[0]?.id ?? '' })
                }
              >
                <option value="book">Book</option>
                <option value="article">Read article</option>
              </Select>
              {a.type === 'book' ? (
                <Select aria-label="Service" value={a.service_id ?? ''} onChange={(e) => setAction(i, { ...a, service_id: e.target.value || null })}>
                  <option value="">Any service</option>
                  {services.data?.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              ) : (
                <Select aria-label="Article" required value={a.article_id} onChange={(e) => setAction(i, { ...a, article_id: e.target.value })}>
                  <option value="">Choose an article</option>
                  {articles.data?.map((art) => (
                    <option key={art.id} value={art.id}>{art.title}</option>
                  ))}
                </Select>
              )}
              <Input aria-label="Button label (optional)" placeholder="Label (optional)" maxLength={60} value={a.label ?? ''} onChange={(e) => setAction(i, { ...a, label: e.target.value })} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setActions(actions.filter((_, j) => j !== i))} aria-label="Remove button">
                Remove
              </Button>
            </div>
          ))}
          {actions.length < 4 && (
            <div>
              <Button type="button" size="sm" variant="secondary" onClick={() => setActions([...actions, { type: 'book', service_id: null }])}>
                Add a button
              </Button>
            </div>
          )}
        </fieldset>

        {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!title.trim() || !body.trim() || save.isPending}>Save</Button>
          <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
          {answer && can('delete', 'knowledge') && (
            <Button type="button" variant="ghost" className="ml-auto" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete</Button>
          )}
        </div>
      </form>
    </Card>
  );
}

// Articles -------------------------------------------------------------------------------------

function Articles() {
  const api = useApi();
  const list = useQuery({ queryKey: ['articles', ''], queryFn: () => api.get<Article[]>('/articles') });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <div className={`grid items-start gap-4 ${editing ? 'lg:grid-cols-[minmax(0,1fr)_40rem]' : ''}`}>
      <Card title="Articles" actions={<Button size="sm" onClick={() => setEditing('new')}>New article</Button>}>
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.length ? (
          <EmptyState>No articles yet.</EmptyState>
        ) : (
          <ul className="-mx-4 -my-4 divide-y divide-slate-100 dark:divide-slate-800">
            {list.data.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setEditing(a.slug)}
                  aria-current={editing === a.slug ? 'true' : undefined}
                  className={rowClass(editing === a.slug)}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.title}</span>
                    <Badge>{AUDIENCE_LABEL[a.audience]}</Badge>
                    {!a.published && <Badge tone="amber">draft</Badge>}
                  </span>
                  <span className="block text-sm text-slate-500">/{a.slug} · updated {date(a.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && (
        <div className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-10rem)] lg:overflow-y-auto">
          {editing === 'new' ? (
            <ArticleEditor key="new" onDone={() => setEditing(null)} />
          ) : (
            <LoadedArticleEditor key={editing} slug={editing} onDone={() => setEditing(null)} />
          )}
        </div>
      )}
    </div>
  );
}

function LoadedArticleEditor({ slug, onDone }: { slug: string; onDone: () => void }) {
  const api = useApi();
  const q = useQuery({ queryKey: ['article', slug], queryFn: () => api.get<Article>(`/articles/${slug}`) });
  if (!q.data) return <Card>{q.error ? <ErrorBanner error={q.error} /> : <Spinner />}</Card>;
  return <ArticleEditor article={q.data} onDone={onDone} />;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

function ArticleEditor({ article, onDone }: { article?: Article; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [title, setTitle] = useState(article?.title ?? '');
  const [slug, setSlug] = useState(article?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(article));
  const [summary, setSummary] = useState(article?.summary ?? '');
  const [body, setBody] = useState(article?.body ?? '');
  const [audience, setAudience] = useState<Audience>(article?.audience ?? 'all');
  const [published, setPublished] = useState(article?.published ?? false);
  const [preview, setPreview] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['articles'] });
    void queryClient.invalidateQueries({ queryKey: ['article'] });
  };
  const save = useMutation({
    mutationFn: () => {
      const payload = { slug, title, summary: summary.trim() || null, body, audience, published };
      return article ? api.put(`/articles/${article.id}`, payload) : api.post('/articles', payload);
    },
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/articles/${article!.id}`),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Card title={article ? 'Edit article' : 'New article'} actions={article && <Link to={`/staff/help/${article.slug}`} className="text-sm text-brand-600 hover:underline">View</Link>}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Title">
          <Input
            required
            maxLength={200}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label="Address" hint="Lowercase words separated by hyphens; used in links.">
          <Input
            required
            maxLength={80}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Field>
        <Field label="Summary (optional)">
          <Input maxLength={500} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium">Body</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</Button>
          </div>
          {preview ? (
            <div className="prose-article min-h-40 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <ReactMarkdown>{body}</ReactMarkdown>
            </div>
          ) : (
            <textarea rows={14} className={`${textarea} font-mono`} value={body} onChange={(e) => setBody(e.target.value)} placeholder={'## First heading\nText…\n\n## Second heading\nMore text…'} />
          )}
          <p className="mt-1 text-xs text-slate-500">Markdown. Each heading becomes a passage the assistant can find and quote.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shown to">
            <Select value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
              {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((k) => (
                <option key={k} value={k}>{AUDIENCE_LABEL[k]}</option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /> Published
          </label>
        </div>
        {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!title.trim() || !slug || save.isPending}>Save</Button>
          <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
          {article && can('delete', 'knowledge') && (
            <Button type="button" variant="ghost" className="ml-auto" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete</Button>
          )}
        </div>
      </form>
    </Card>
  );
}

// Test a question ------------------------------------------------------------------------------

interface Match {
  answers: { id: string; title: string; body: string; score: number }[];
  passages: { slug: string; title: string; heading: string | null; body: string; score: number }[];
  actions: { type: string; label: string }[];
}

function TestQuestion() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [as, setAs] = useState<'customer' | 'employee'>('customer');
  const [asked, setAsked] = useState<{ q: string; as: string } | null>(null);
  const match = useQuery({
    queryKey: ['knowledge-match', asked],
    enabled: Boolean(asked),
    queryFn: () => api.get<Match>(`/knowledge/match?as=${asked!.as}&q=${encodeURIComponent(asked!.q)}`),
  });
  return (
    <Card title="What would the assistant find?">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) setAsked({ q: q.trim(), as });
        }}
      >
        <Input className="min-w-64 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Can I move my booking?" aria-label="Question" />
        <Select aria-label="Asked by" value={as} onChange={(e) => setAs(e.target.value as 'customer' | 'employee')}>
          <option value="customer">asked by a customer</option>
          <option value="employee">asked by staff</option>
        </Select>
        <Button type="submit" disabled={!q.trim()}>Test</Button>
      </form>
      {match.isFetching && <Spinner />}
      {match.error && <ErrorBanner error={match.error} />}
      {match.data && (
        <div className="mt-4 grid gap-4 text-sm">
          <section>
            <h3 className="mb-1 font-medium">Saved answers</h3>
            {match.data.answers.length ? (
              match.data.answers.map((a) => (
                <p key={a.id}>
                  <span className="font-medium">{a.title}</span> <span className="text-slate-500">· match {Math.round(a.score * 100)}%</span>
                  <span className="block text-slate-600 dark:text-slate-300">{a.body}</span>
                </p>
              ))
            ) : (
              <p className="text-slate-500">None. Add this question to an answer's examples if one should match.</p>
            )}
          </section>
          <section>
            <h3 className="mb-1 font-medium">Article passages</h3>
            {match.data.passages.length ? (
              match.data.passages.map((p) => (
                <p key={p.slug}>
                  <span className="font-medium">{p.title}{p.heading ? ` — ${p.heading}` : ''}</span>
                  <span className="block text-slate-600 dark:text-slate-300">{p.body}</span>
                </p>
              ))
            ) : (
              <p className="text-slate-500">None.</p>
            )}
          </section>
          <section>
            <h3 className="mb-1 font-medium">Buttons offered</h3>
            {match.data.actions.length ? (
              <div className="flex flex-wrap gap-2">
                {match.data.actions.map((a) => (
                  <span key={a.label} className="rounded-lg border border-brand-500 px-3 py-1 text-brand-700 dark:text-brand-100">{a.label}</span>
                ))}
              </div>
            ) : (
              <p className="text-slate-500">None.</p>
            )}
          </section>
        </div>
      )}
    </Card>
  );
}
