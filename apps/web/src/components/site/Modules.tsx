import DOMPurify from 'dompurify';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { MouseEvent, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { assetUrl, videoEmbed, type SiteBackground, type SiteButton, type SiteCard, type SiteColumn, type SiteModule, type SiteModuleOf } from '../../lib/site';
import { SiteIcon } from '../../lib/site-icons';

/** A page's modules, as visitors see them (also the editor's preview): one full-width section each. */
export function SiteModules({ modules }: { modules: SiteModule[] }) {
  return (
    <>
      {modules.map((m) => (
        <SiteModuleView key={m.id} module={m} />
      ))}
    </>
  );
}

const BACKGROUND: Record<SiteBackground, string> = {
  default: '',
  alt: 'bg-slate-50 dark:bg-slate-900/60',
  // `dark` makes everything inside draw as in dark mode, whatever the viewer's theme.
  dark: 'dark bg-slate-950 text-slate-100',
  accent: 'bg-[linear-gradient(135deg,var(--grad-from),var(--grad-to))] text-white',
};

export function SiteModuleView({ module: m }: { module: SiteModule }) {
  const background = m.background ?? (m.type === 'cta' ? 'accent' : 'default');
  const onAccent = background === 'accent';
  return (
    <section id={m.anchor || undefined} className={`scroll-mt-20 ${BACKGROUND[background]}`}>
      <div className={`mx-auto max-w-6xl px-4 ${m.type === 'hero' ? 'py-16 sm:py-24' : 'py-12 sm:py-16'}`}>
        {m.type !== 'hero' && m.type !== 'cta' && <SectionHeader module={m} onAccent={onAccent} />}
        <ModuleBody module={m} onAccent={onAccent} />
      </div>
    </section>
  );
}

/** The small label, heading and intro every module may have, centered above its content. */
function SectionHeader({ module: m, onAccent }: { module: SiteModule; onAccent: boolean }) {
  if (!m.eyebrow && !m.heading && !m.intro) return null;
  return (
    <header className="mx-auto mb-8 max-w-3xl text-center sm:mb-10">
      {m.eyebrow && <Eyebrow onAccent={onAccent}>{m.eyebrow}</Eyebrow>}
      {m.heading && <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{m.heading}</h2>}
      {m.intro && (
        <div className={`site-prose mt-4 text-lg ${onAccent ? 'text-white/85' : 'text-slate-600 dark:text-slate-300'}`}>
          <Markdown>{m.intro}</Markdown>
        </div>
      )}
    </header>
  );
}

function Eyebrow({ onAccent, children }: { onAccent: boolean; children: ReactNode }) {
  return <p className={`mb-3 text-xs font-semibold uppercase tracking-[0.14em] ${onAccent ? 'text-white/80' : 'text-brand-700 dark:text-brand-600'}`}>{children}</p>;
}

function ModuleBody({ module: m, onAccent }: { module: SiteModule; onAccent: boolean }) {
  switch (m.type) {
    case 'html':
      return <HtmlModule html={m.html} />;
    case 'columns':
      return (
        <div className={`grid gap-6 ${COLUMNS[m.columns.length] ?? COLUMNS[3]}`}>
          {m.columns.map((c, i) => (
            <Column key={i} column={c} />
          ))}
        </div>
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
    case 'hero':
      return <Hero module={m} onAccent={onAccent} />;
    case 'cards':
      return <Cards module={m} onAccent={onAccent} />;
    case 'faq':
      return (
        <div className="mx-auto max-w-3xl divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {m.items.map((q, i) => (
            <details key={i} className="group py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left font-medium [&::-webkit-details-marker]:hidden">
                {q.question}
                <span aria-hidden="true" className="text-xl leading-none text-slate-400 transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <div className="site-prose mt-3 text-slate-600 dark:text-slate-300">
                <Markdown>{q.answer}</Markdown>
              </div>
            </details>
          ))}
        </div>
      );
    case 'cta':
      return (
        <div className="mx-auto max-w-3xl text-center">
          {m.eyebrow && <Eyebrow onAccent={onAccent}>{m.eyebrow}</Eyebrow>}
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{m.heading}</h2>
          {m.text && (
            <div className={`site-prose mt-4 text-lg ${onAccent ? 'text-white/85' : 'text-slate-600 dark:text-slate-300'}`}>
              <Markdown>{m.text}</Markdown>
            </div>
          )}
          <SiteButtons buttons={m.buttons} onAccent={onAccent} className="mt-8 justify-center" />
        </div>
      );
  }
}

function Hero({ module: m, onAccent }: { module: SiteModuleOf<'hero'>; onAccent: boolean }) {
  const at = m.heading_accent ? m.heading.indexOf(m.heading_accent) : -1;
  return (
    <div className="mx-auto max-w-4xl text-center">
      {m.eyebrow && (
        <p
          className={`mb-6 inline-flex rounded-full border px-3 py-1 text-xs font-medium ${
            onAccent ? 'border-white/40 text-white' : 'border-brand-200 bg-brand-50 text-brand-800 dark:border-slate-700 dark:bg-slate-900 dark:text-brand-600'
          }`}
        >
          {m.eyebrow}
        </p>
      )}
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
        {at >= 0 ? (
          <>
            {m.heading.slice(0, at)}
            <em className={onAccent ? 'italic' : 'site-accent-text italic'}>{m.heading_accent}</em>
            {m.heading.slice(at + m.heading_accent!.length)}
          </>
        ) : (
          m.heading
        )}
      </h1>
      {m.text && (
        <div className={`site-prose mx-auto mt-6 max-w-2xl text-lg ${onAccent ? 'text-white/85' : 'text-slate-600 dark:text-slate-300'}`}>
          <Markdown>{m.text}</Markdown>
        </div>
      )}
      <SiteButtons buttons={m.buttons} onAccent={onAccent} className="mt-8 justify-center" />
      {m.image_id && <img src={assetUrl(m.image_id)} alt={m.image_alt ?? ''} className="mx-auto mt-12 w-full rounded-2xl border border-slate-200 shadow-lg dark:border-slate-800" />}
    </div>
  );
}

const GRID: Record<2 | 3 | 4, string> = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' };

function Cards({ module: m, onAccent }: { module: SiteModuleOf<'cards'>; onAccent: boolean }) {
  const compact = m.variant === 'compact';
  return (
    <>
      <div className={`grid ${compact ? 'gap-x-8 gap-y-6' : 'gap-5'} ${GRID[m.columns] ?? GRID[3]} ${m.items.length === 1 ? 'mx-auto max-w-xl sm:grid-cols-1 lg:grid-cols-1' : ''}`}>
        {m.items.map((c, i) => (
          <Card key={i} card={c} number={m.variant === 'numbered' ? i + 1 : undefined} compact={compact} onAccent={onAccent} />
        ))}
      </div>
      <SiteButtons buttons={m.buttons} onAccent={onAccent} className="mt-10 justify-center" />
    </>
  );
}

function Card({ card: c, number, compact, onAccent }: { card: SiteCard; number?: number; compact: boolean; onAccent: boolean }) {
  const mark =
    number !== undefined ? (
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-on-brand">{number}</span>
    ) : c.icon ? (
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${onAccent ? 'bg-white/15 text-white' : 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-600'}`}>
        <SiteIcon name={c.icon} />
      </span>
    ) : null;
  const muted = onAccent ? 'text-white/85' : 'text-slate-600 dark:text-slate-300';
  const body = (
    <>
      {c.eyebrow && <p className={`text-xs font-semibold uppercase tracking-[0.12em] ${onAccent ? 'text-white/80' : 'text-brand-700 dark:text-brand-600'}`}>{c.eyebrow}</p>}
      {c.heading && <h3 className={`${compact ? 'text-base' : 'text-lg'} font-semibold ${c.eyebrow ? 'mt-1' : ''}`}>{c.heading}</h3>}
      {c.text && (
        <div className={`site-prose site-checks mt-2 flex-1 text-sm ${muted}`}>
          <Markdown>{c.text}</Markdown>
        </div>
      )}
      {c.link_url && c.link_label && (
        <SiteLink href={c.link_url} className={`mt-4 self-start text-sm font-semibold hover:underline ${onAccent ? 'text-white' : 'text-brand-700 dark:text-brand-600'}`}>
          {c.link_label} →
        </SiteLink>
      )}
    </>
  );
  if (compact) {
    return (
      <div className="flex gap-4">
        {mark}
        <div className="flex min-w-0 flex-col">{body}</div>
      </div>
    );
  }
  return (
    <div
      className={`flex flex-col rounded-2xl border p-6 ${
        onAccent ? 'border-white/20 bg-white/10' : 'border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900'
      }`}
    >
      {c.image_id && <img src={assetUrl(c.image_id)} alt={c.image_alt ?? ''} loading="lazy" className="mb-4 aspect-[4/3] w-full rounded-lg object-cover" />}
      {mark && <div className="mb-4">{mark}</div>}
      {body}
    </div>
  );
}

/** Up to two buttons: the first filled, the second outlined (white on the accent background). */
export function SiteButtons({ buttons, onAccent, className = '' }: { buttons?: SiteButton[]; onAccent?: boolean; className?: string }) {
  if (!buttons?.length) return null;
  const base = 'press inline-flex items-center rounded-full px-5 py-2.5 text-sm font-semibold';
  return (
    <div className={`flex flex-wrap gap-3 ${className}`}>
      {buttons.map((b, i) => (
        <SiteLink
          key={i}
          href={b.url}
          className={`${base} ${
            onAccent
              ? i === 0
                ? 'bg-white text-brand-800 shadow-sm hover:bg-white/90'
                : 'border border-white/60 text-white hover:bg-white/10'
              : i === 0
                ? 'btn-gradient shadow-sm'
                : 'btn-outline-gradient'
          }`}
        >
          {b.label}
        </SiteLink>
      ))}
    </div>
  );
}

/** Markdown from editors (no raw HTML); links to this site stay in the app. */
const MARKDOWN: Components = {
  a: ({ href, children }) => (href ? <SiteLink href={href}>{children}</SiteLink> : <>{children}</>),
};
function Markdown({ children }: { children: string }) {
  return <ReactMarkdown components={MARKDOWN}>{children}</ReactMarkdown>;
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
  return <div className="site-prose mx-auto max-w-3xl" onClick={onClick} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] }) }} />;
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
          <Markdown>{c.text}</Markdown>
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

/** In-app links stay in the app (with their #section); "#section" stays on the page; others open as usual. */
export function SiteLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    return (
      <Link to={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className} rel={href.startsWith('http') ? 'noopener noreferrer' : undefined} target={href.startsWith('http') ? '_blank' : undefined}>
      {children}
    </a>
  );
}
