import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, Tabs } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date } from '../../lib/format';
import { useMe } from '../../lib/me';

type Audience = 'customer' | 'employee' | 'all';
const AUDIENCE_LABEL: Record<Audience, string> = { all: 'Any audience', customer: 'Customers', employee: 'Employees' };

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
const panel = 'rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900';

/** A list row: a dot (on or off), the title and one line under it. */
function ListRow({ on, title, sub, selected, onClick }: { on: boolean; title: string; sub: ReactNode; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${
        selected ? 'bg-brand-50 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
      }`}
    >
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</span>
        <span className="block truncate text-xs text-slate-500">{sub}</span>
      </span>
    </button>
  );
}

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Search titles, questions and text" aria-label={label} className="pl-9" />
    </div>
  );
}

/** Admin: what the assistant knows (saved answers, help articles), and a test of what it finds for a question. */
export function Knowledge() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'articles' ? 'articles' : 'answers';
  const [creating, setCreating] = useState(0);
  // Totals for the tabs (everything, not just a search).
  const answerCount = useQuery({
    queryKey: ['answers', 'count'],
    queryFn: () => api.get<{ total: number }>('/answers?limit=1').then((r) => r.total),
  });
  const articles = useQuery({ queryKey: ['articles', ''], queryFn: () => api.get<Article[]>('/articles') });
  return (
    <Page>
      <PageHeader
        title="Knowledge"
        description="The assistant searches saved answers and article passages for every question, and cites them."
        actions={<Button onClick={() => setCreating((n) => n + 1)}>{tab === 'articles' ? 'New article' : 'New answer'}</Button>}
      />
      <Tabs
        label="Knowledge"
        tabs={[
          { key: 'answers', label: 'Saved answers', count: answerCount.data ?? null },
          { key: 'articles', label: 'Articles', count: articles.data?.length ?? null },
        ]}
        value={tab}
        onChange={(key) => {
          setCreating(0);
          setParams(key === 'answers' ? {} : { tab: key }, { replace: true });
        }}
      />
      <TestQuestion onOpenAnswer={(id) => setParams({ answer: id }, { replace: true })} />
      {tab === 'answers' ? <Answers creating={creating} /> : <Articles creating={creating} />}
    </Page>
  );
}

// Saved answers --------------------------------------------------------------------------------

function Answers({ creating }: { creating: number }) {
  const api = useApi();
  const [urlParams, setUrlParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [audience, setAudience] = useState<'' | Audience>('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Answer | 'new' | null>(null);
  const term = useDebounced(q.trim());

  // "New answer" in the header.
  useEffect(() => {
    if (creating) setSelected('new');
  }, [creating]);

  // ?answer=<id> (from a chat source or the test above) opens that answer.
  const requested = urlParams.get('answer');
  useEffect(() => {
    if (!requested) return;
    let live = true;
    api
      .get<Answer>(`/answers/${requested}`)
      .then((a) => live && setSelected(a))
      .catch(() => undefined) // deleted since: just show the list
      .finally(() => live && setUrlParams({}, { replace: true }));
    return () => {
      live = false;
    };
  }, [requested, api, setUrlParams]);

  // A new search or filter starts from the first page.
  useEffect(() => setOffset(0), [term, audience, active]);

  const params = new URLSearchParams({ sort: 'title', limit: String(PAGE_SIZE), offset: String(offset) });
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
  // Nothing chosen yet: show the first answer.
  const current = selected ?? (requested ? null : (items[0] ?? null));

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
      <section className={`${panel} overflow-hidden`}>
        <div className="grid gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
          <SearchBox value={q} onChange={setQ} label="Search answers" />
          <div className="grid grid-cols-2 gap-2">
            <Select aria-label="Shown to" value={audience} onChange={(e) => setAudience(e.target.value as '' | Audience)} className="py-1 text-xs">
              <option value="">Anyone</option>
              {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((k) => (
                <option key={k} value={k}>{AUDIENCE_LABEL[k]}</option>
              ))}
            </Select>
            <Select aria-label="On or off" value={active} onChange={(e) => setActive(e.target.value as '' | 'true' | 'false')} className="py-1 text-xs">
              <option value="">On and off</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </Select>
          </div>
        </div>
        {list.isLoading ? (
          <div className="p-4"><Spinner /></div>
        ) : list.error ? (
          <div className="p-4"><ErrorBanner error={list.error} /></div>
        ) : !items.length ? (
          <div className="p-4"><EmptyState>{filtered ? 'No answers match.' : 'No saved answers yet.'}</EmptyState></div>
        ) : (
          <>
            <ul className={`grid gap-0.5 p-1.5 lg:max-h-[calc(100dvh-24rem)] lg:overflow-y-auto ${list.isPlaceholderData ? 'opacity-60' : ''}`}>
              {items.map((a) => (
                <li key={a.id}>
                  <ListRow
                    on={a.active}
                    title={a.title}
                    sub={`${AUDIENCE_LABEL[a.audience]} · edited ${date(a.updated_at)}`}
                    selected={current !== 'new' && current?.id === a.id}
                    onClick={() => setSelected(a)}
                  />
                </li>
              ))}
            </ul>
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-500 dark:border-slate-800">
                <span aria-live="polite">
                  {offset + 1}–{offset + items.length} of {total}
                </span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={offset === 0 || list.isFetching} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                    Previous
                  </Button>
                  <Button size="sm" variant="ghost" disabled={offset + PAGE_SIZE >= total || list.isFetching} onClick={() => setOffset(offset + PAGE_SIZE)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
      {current && (
        <AnswerEditor
          key={current === 'new' ? `new-${creating}` : `${current.id}-${current.updated_at}`}
          answer={current === 'new' ? undefined : current}
          onSaved={(a) => setSelected(a)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** A removable chip. */
function Chip({ children, onRemove, tone = 'slate', onClick, pressed }: { children: ReactNode; onRemove?: () => void; tone?: 'slate' | 'brand'; onClick?: () => void; pressed?: boolean }) {
  const colors =
    tone === 'brand'
      ? 'border border-brand-200 bg-brand-50 font-semibold text-brand-700 dark:border-slate-700 dark:bg-slate-800 dark:text-brand-100'
      : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full text-sm ${colors} ${pressed ? 'ring-2 ring-brand-500' : ''}`}>
      {onClick ? (
        <button type="button" onClick={onClick} aria-expanded={pressed} className="py-1.5 pl-3 pr-1 text-left">
          {children}
        </button>
      ) : (
        <span className="py-1.5 pl-3 pr-1">{children}</span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="mr-1 rounded-full p-1 text-slate-400 hover:bg-black/5 hover:text-slate-700 dark:hover:bg-white/10" aria-label={`Remove ${typeof children === 'string' ? children : ''}`.trim()}>
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

const addButton =
  'inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:border-brand-500 hover:text-brand-700 dark:border-slate-600 dark:text-slate-300';

function AnswerEditor({ answer, onSaved, onClose }: { answer?: Answer; onSaved: (a: Answer) => void; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get<Service[]>('/services') });
  const articles = useQuery({ queryKey: ['articles', ''], queryFn: () => api.get<Article[]>('/articles') });
  const [title, setTitle] = useState(answer?.title ?? '');
  const [questions, setQuestions] = useState<string[]>(answer?.questions ?? []);
  const [question, setQuestion] = useState<string | null>(null);
  const [body, setBody] = useState(answer?.body ?? '');
  const [audience, setAudience] = useState<Audience>(answer?.audience ?? 'all');
  const [active, setActive] = useState(answer?.active ?? true);
  const [actions, setActions] = useState<AnswerAction[]>(answer?.actions ?? []);
  const [openAction, setOpenAction] = useState<number | null>(null);
  const [reset, setReset] = useState(0);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['answers'] });
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        title,
        questions,
        body,
        audience,
        active,
        actions: actions.map((a) => (a.label?.trim() ? { ...a, label: a.label.trim() } : { ...a, label: undefined })),
      };
      return answer ? api.put<Answer>(`/answers/${answer.id}`, payload) : api.post<Answer>('/answers', payload);
    },
    onSuccess: (saved) => {
      refresh();
      onSaved(saved);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/answers/${answer!.id}`),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const setAction = (i: number, a: AnswerAction) => setActions(actions.map((x, j) => (j === i ? a : x)));
  const actionLabel = (a: AnswerAction) =>
    a.label?.trim() ||
    (a.type === 'book'
      ? `Book · ${services.data?.find((s) => s.id === a.service_id)?.name ?? 'Any service'}`
      : `Read article · ${articles.data?.find((x) => x.id === a.article_id)?.title ?? 'choose one'}`);
  const addQuestion = () => {
    const v = question?.trim();
    if (v && !questions.includes(v)) setQuestions([...questions, v]);
    setQuestion(null);
  };
  const cancel = () => {
    if (!answer) return onClose();
    setTitle(answer.title);
    setQuestions(answer.questions);
    setBody(answer.body);
    setAudience(answer.audience);
    setActive(answer.active);
    setActions(answer.actions);
    setOpenAction(null);
    setQuestion(null);
    setReset(reset + 1);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className={`${panel} grid gap-5 p-6`} aria-label={answer ? `Edit ${answer.title}` : 'New answer'}>
      <div className="flex items-center gap-4">
        <input
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={answer ? 'Title' : 'New answer title, e.g. Rescheduling or cancelling'}
          aria-label="Title"
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 -ml-1 text-xl font-bold tracking-tight hover:border-slate-200 focus:border-slate-300 focus:outline-none dark:hover:border-slate-700"
        />
        <label className="flex shrink-0 items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> On
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shown to">
          <Select value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
            {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((k) => (
              <option key={k} value={k}>{AUDIENCE_LABEL[k]}</option>
            ))}
          </Select>
        </Field>
        {answer && <p className="self-end pb-2.5 text-xs text-slate-500 sm:text-right">Last edited {date(answer.updated_at)}</p>}
      </div>
      <Field label="Answer" hint="What the assistant should say. It may adapt the wording but keeps the meaning.">
        <textarea
          required
          rows={5}
          maxLength={5000}
          className={`${textarea} min-h-28 resize-y leading-relaxed`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {body.length > 4000 && <span className={`block text-right text-xs ${body.length > 4500 ? 'text-amber-700' : 'text-slate-400'}`}>{body.length.toLocaleString()} / 5,000</span>}
      </Field>

      <div>
        <p className="mb-2 text-sm font-medium">Example questions</p>
        <div className="flex flex-wrap items-center gap-2">
          {questions.map((x) => (
            <Chip key={x} onRemove={() => setQuestions(questions.filter((y) => y !== x))}>{x}</Chip>
          ))}
          {question !== null ? (
            <input
              autoFocus
              maxLength={300}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onBlur={addQuestion}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addQuestion();
                } else if (e.key === 'Escape') setQuestion(null);
              }}
              placeholder="Type a question, then Enter"
              aria-label="New example question"
              className="min-w-56 rounded-full border border-brand-500 bg-white px-3 py-1.5 text-sm focus:outline-none dark:bg-slate-900"
            />
          ) : (
            <button type="button" className={addButton} onClick={() => setQuestion('')}>
              <Plus className="size-3.5" aria-hidden="true" /> Add
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-slate-500">The assistant matches questions like these, in other words too.</p>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">
          Buttons offered <span className="font-normal text-slate-500">(up to 4)</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((a, i) => (
            <Chip
              key={i}
              tone="brand"
              pressed={openAction === i}
              onClick={() => setOpenAction(openAction === i ? null : i)}
              onRemove={() => {
                setActions(actions.filter((_, j) => j !== i));
                setOpenAction(null);
              }}
            >
              {actionLabel(a)}
            </Chip>
          ))}
          {actions.length < 4 && (
            <button
              type="button"
              className={addButton}
              onClick={() => {
                setActions([...actions, { type: 'book', service_id: null }]);
                setOpenAction(actions.length);
              }}
            >
              <Plus className="size-3.5" aria-hidden="true" /> Add
            </button>
          )}
          {!actions.length && <span className="text-xs text-slate-500">None. A button lets people book or read an article from the answer.</span>}
        </div>
        {openAction !== null && actions[openAction] && (
          <ActionFields
            key={`${openAction}-${reset}`}
            action={actions[openAction]}
            services={services.data ?? []}
            articles={articles.data ?? []}
            onChange={(a) => setAction(openAction, a)}
          />
        )}
      </div>

      {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-5 dark:border-slate-800">
        {answer && can('delete', 'knowledge') && (
          <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => window.confirm(`Delete “${answer.title}”?`) && remove.mutate()}>
            Delete
          </Button>
        )}
        <span className="ml-auto" />
        <Button type="button" variant="secondary" onClick={cancel}>Cancel</Button>
        <Button type="submit" disabled={!title.trim() || !body.trim() || save.isPending}>Save answer</Button>
      </div>
    </form>
  );
}

/** The type, target and optional label of one button. */
function ActionFields({ action: a, services, articles, onChange }: { action: AnswerAction; services: Service[]; articles: Article[]; onChange: (a: AnswerAction) => void }) {
  return (
    <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)] dark:border-slate-800 dark:bg-slate-900/60">
      <Select
        aria-label="Button type"
        value={a.type}
        onChange={(e) => onChange(e.target.value === 'book' ? { type: 'book', service_id: null } : { type: 'article', article_id: articles[0]?.id ?? '' })}
      >
        <option value="book">Book</option>
        <option value="article">Read article</option>
      </Select>
      {a.type === 'book' ? (
        <Select aria-label="Service" value={a.service_id ?? ''} onChange={(e) => onChange({ ...a, service_id: e.target.value || null })}>
          <option value="">Any service</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
      ) : (
        <Select aria-label="Article" required value={a.article_id} onChange={(e) => onChange({ ...a, article_id: e.target.value })}>
          <option value="">Choose an article</option>
          {articles.map((art) => (
            <option key={art.id} value={art.id}>{art.title}</option>
          ))}
        </Select>
      )}
      <Input aria-label="Button label (optional)" placeholder="Label (optional)" maxLength={60} value={a.label ?? ''} onChange={(e) => onChange({ ...a, label: e.target.value })} />
    </div>
  );
}

// Articles -------------------------------------------------------------------------------------

function Articles({ creating }: { creating: number }) {
  const api = useApi();
  const list = useQuery({ queryKey: ['articles', ''], queryFn: () => api.get<Article[]>('/articles') });
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (creating) setSelected('new');
  }, [creating]);
  const term = q.trim().toLowerCase();
  const items = (list.data ?? []).filter((a) => !term || `${a.title} ${a.summary ?? ''} ${a.slug}`.toLowerCase().includes(term));
  const current = selected ?? items[0]?.slug ?? null;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
      <section className={`${panel} overflow-hidden`}>
        <div className="border-b border-slate-100 p-3 dark:border-slate-800">
          <SearchBox value={q} onChange={setQ} label="Search articles" />
        </div>
        {list.isLoading ? (
          <div className="p-4"><Spinner /></div>
        ) : list.error ? (
          <div className="p-4"><ErrorBanner error={list.error} /></div>
        ) : !items.length ? (
          <div className="p-4"><EmptyState>{term ? 'No articles match.' : 'No articles yet.'}</EmptyState></div>
        ) : (
          <ul className="grid gap-0.5 p-1.5 lg:max-h-[calc(100dvh-24rem)] lg:overflow-y-auto">
            {items.map((a) => (
              <li key={a.id}>
                <ListRow
                  on={a.published}
                  title={a.title}
                  sub={`${a.published ? AUDIENCE_LABEL[a.audience] : 'Draft'} · /${a.slug}`}
                  selected={current === a.slug}
                  onClick={() => setSelected(a.slug)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      {current &&
        (current === 'new' ? (
          <ArticleEditor key={`new-${creating}`} onDone={() => setSelected(null)} />
        ) : (
          <LoadedArticleEditor key={current} slug={current} onDone={() => setSelected(null)} />
        ))}
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
            <input type="checkbox" className="switch" checked={published} onChange={(e) => setPublished(e.target.checked)} /> Published
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

const resultChip = 'inline-flex max-w-full items-center truncate rounded-md px-2.5 py-1.5 text-xs';

/** What the assistant would find for a question: saved answers, article passages and the buttons it would offer. */
function TestQuestion({ onOpenAnswer }: { onOpenAnswer: (id: string) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [as, setAs] = useState<'customer' | 'employee'>('customer');
  const [asked, setAsked] = useState<{ q: string; as: string } | null>(null);
  const match = useQuery({
    queryKey: ['knowledge-match', asked],
    enabled: Boolean(asked),
    queryFn: () => api.get<Match>(`/knowledge/match?as=${asked!.as}&q=${encodeURIComponent(asked!.q)}`),
  });
  const m = match.data;
  const none = m && !m.answers.length && !m.passages.length;
  return (
    <section className="mb-5 rounded-xl bg-slate-950 p-5 text-white shadow-xs dark:border dark:border-slate-800">
      <h2 className="mb-3 text-sm font-semibold">What would the assistant find?</h2>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) setAsked({ q: q.trim(), as });
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Can I move my booking to next week?"
          aria-label="Question"
          className="h-11 min-w-0 flex-[1_1_16rem] rounded-lg border border-white/15 bg-white/5 px-3.5 text-sm text-white placeholder:text-slate-400 focus:border-white/40 focus:outline-none"
        />
        <select
          aria-label="Asked by"
          value={as}
          onChange={(e) => setAs(e.target.value as 'customer' | 'employee')}
          className="h-11 rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-white focus:outline-none [&>option]:text-slate-900"
        >
          <option value="customer">asked by a customer</option>
          <option value="employee">asked by staff</option>
        </select>
        <button type="submit" disabled={!q.trim()} className="press h-11 rounded-lg bg-emerald-300 px-5 text-sm font-semibold text-slate-950 hover:bg-emerald-200 disabled:opacity-50">
          Test
        </button>
      </form>
      {match.isFetching && <p className="mt-3 text-xs text-slate-400">Searching…</p>}
      {match.error && (
        <div className="mt-3">
          <ErrorBanner error={match.error} />
        </div>
      )}
      {m && !match.isFetching && (
        <div className="mt-3 flex flex-wrap gap-2" aria-live="polite">
          {m.answers.map((a, i) => (
            <button
              key={a.id}
              type="button"
              title={a.body}
              onClick={() => onOpenAnswer(a.id)}
              className={`${resultChip} ${i === 0 ? 'bg-emerald-900/60 text-emerald-100 hover:bg-emerald-900' : 'bg-white/10 text-slate-200 hover:bg-white/15'}`}
            >
              <span className="font-semibold">{a.title}</span>&nbsp;· saved answer{i === 0 ? ' · best match' : ''} · {Math.round(a.score * 100)}%
            </button>
          ))}
          {m.passages.map((p) => (
            <Link key={`${p.slug}-${p.heading}`} to={`/staff/help/${p.slug}`} title={p.body} className={`${resultChip} bg-white/10 text-slate-200 hover:bg-white/15`}>
              {p.title}
              {p.heading ? ` › ${p.heading}` : ''}&nbsp;· article passage
            </Link>
          ))}
          {m.actions.map((a) => (
            <span key={a.label} className={`${resultChip} border border-white/15 text-slate-300`}>
              {a.label} · button
            </span>
          ))}
          {none && <p className="text-xs text-slate-400">Nothing found. Add this question to an answer's examples if one should match.</p>}
        </div>
      )}
    </section>
  );
}
