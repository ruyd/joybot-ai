import DOMPurify from 'dompurify';
import ReactMarkdown from 'react-markdown';
import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { assetUrl, videoEmbed, type SiteColumn, type SiteModule } from '../../lib/site';

/** A page's modules, as visitors see them (also the editor's preview). */
export function SiteModules({ modules }: { modules: SiteModule[] }) {
  return (
    <div className="space-y-12">
      {modules.map((m) => (
        <SiteModuleView key={m.id} module={m} />
      ))}
    </div>
  );
}

export function SiteModuleView({ module: m }: { module: SiteModule }) {
  switch (m.type) {
    case 'html':
      return <HtmlModule html={m.html} />;
    case 'columns':
      return (
        <section>
          {m.heading && <h2 className="mb-6 text-center text-2xl font-semibold tracking-tight sm:text-3xl">{m.heading}</h2>}
          <div className={`grid gap-6 ${COLUMNS[m.columns.length] ?? COLUMNS[3]}`}>
            {m.columns.map((c, i) => (
              <Column key={i} column={c} />
            ))}
          </div>
        </section>
      );
    case 'image': {
      const img = <img src={assetUrl(m.image_id)} alt={m.alt} loading="lazy" className="w-full rounded-xl object-cover" />;
      return (
        <figure className={`mx-auto ${IMAGE_WIDTH[m.size]}`}>
          {m.link_url ? <SiteLink href={m.link_url}>{img}</SiteLink> : img}
          {m.caption && <figcaption className="mt-2 text-center text-sm text-slate-500">{m.caption}</figcaption>}
        </figure>
      );
    }
    case 'video': {
      const src = videoEmbed(m.url);
      if (!src) return null;
      return (
        <figure className="mx-auto max-w-4xl">
          <div className="aspect-video overflow-hidden rounded-xl bg-slate-900">
            <iframe
              src={src}
              title={m.caption || 'Video'}
              className="size-full"
              loading="lazy"
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              allowFullScreen
            />
          </div>
          {m.caption && <figcaption className="mt-2 text-center text-sm text-slate-500">{m.caption}</figcaption>}
        </figure>
      );
    }
  }
}

/** Cleaned by the API on save; cleaned again here in case anything got in another way. Links to this site stay in the app. */
function HtmlModule({ html }: { html: string }) {
  const navigate = useNavigate();
  const onClick = (e: MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href?.startsWith('/') || href.startsWith('//') || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  };
  return <section className="site-prose mx-auto max-w-3xl" onClick={onClick} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] }) }} />;
}

const COLUMNS: Record<number, string> = { 1: 'mx-auto max-w-2xl', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' };
const IMAGE_WIDTH = { small: 'max-w-sm', medium: 'max-w-2xl', full: 'max-w-none' } as const;

function Column({ column: c }: { column: SiteColumn }) {
  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
      {c.image_id && <img src={assetUrl(c.image_id)} alt={c.image_alt ?? ''} loading="lazy" className="mb-4 aspect-[4/3] w-full rounded-lg object-cover" />}
      {c.heading && <h3 className="text-lg font-semibold">{c.heading}</h3>}
      {c.text && (
        <div className="site-prose mt-2 flex-1 text-slate-600 dark:text-slate-300">
          <ReactMarkdown>{c.text}</ReactMarkdown>
        </div>
      )}
      {c.link_url && c.link_label && (
        <SiteLink href={c.link_url} className="mt-4 self-start text-sm font-semibold text-brand-700 hover:underline dark:text-brand-600">
          {c.link_label} →
        </SiteLink>
      )}
    </div>
  );
}

/** In-app links stay in the app; others open as usual. */
function SiteLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  if (href.startsWith('/')) {
    return (
      <Link to={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className} rel="noopener noreferrer" target={href.startsWith('http') ? '_blank' : undefined}>
      {children}
    </a>
  );
}
