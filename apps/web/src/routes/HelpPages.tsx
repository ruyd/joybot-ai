import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import { Page } from '../components/Layout';
import { Badge, Card, EmptyState, ErrorBanner, Input, PageHeader, Spinner } from '../components/ui';
import { useApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { date } from '../lib/format';

interface Article {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  audience: 'customer' | 'employee' | 'all';
  published: boolean;
  updated_at: string;
  body?: string;
}

const helpBase = (audience: string) => (audience === 'customer' ? '/portal/help' : '/staff/help');

/** Help: the articles meant for this audience (editors also see drafts, marked). */
export function HelpList() {
  const api = useApi();
  const { audience } = useSession();
  const [q, setQ] = useState('');
  const term = q.trim();
  const list = useQuery({
    queryKey: ['articles', term],
    queryFn: () => api.get<Article[]>(`/articles${term ? `?q=${encodeURIComponent(term)}` : ''}`),
  });
  return (
    <Page>
      <PageHeader title="Help" description="How-to guides and policies. You can also ask the assistant." />
      <div className="max-w-3xl space-y-4">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help" aria-label="Search help" />
        <Card>
          {list.isLoading ? (
            <Spinner />
          ) : list.error ? (
            <ErrorBanner error={list.error} />
          ) : !list.data?.length ? (
            <EmptyState>{term ? 'No articles match that.' : 'No articles yet.'}</EmptyState>
          ) : (
            <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
              {list.data.map((a) => (
                <li key={a.id} className="py-3">
                  <Link to={`${helpBase(audience)}/${a.slug}`} className="font-medium text-brand-600 hover:underline">
                    {a.title}
                  </Link>
                  {!a.published && <span className="ml-2"><Badge tone="amber">draft</Badge></span>}
                  {a.summary && <p className="text-sm text-slate-500">{a.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}

export function ArticleView() {
  const api = useApi();
  const { slug } = useParams();
  const { audience } = useSession();
  const q = useQuery({ queryKey: ['article', slug], queryFn: () => api.get<Article>(`/articles/${slug}`) });
  return (
    <Page>
      <Link to={helpBase(audience)} className="text-sm text-brand-600 hover:underline">← All help</Link>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <div className="mt-4"><ErrorBanner error={q.error} /></div>
      ) : (
        <article className="mt-3 max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight">{q.data!.title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Updated {date(q.data!.updated_at)}
            {!q.data!.published && <span className="ml-2"><Badge tone="amber">draft</Badge></span>}
          </p>
          <div className="prose-article mt-6">
            <ReactMarkdown>{q.data!.body ?? ''}</ReactMarkdown>
          </div>
        </article>
      )}
    </Page>
  );
}
