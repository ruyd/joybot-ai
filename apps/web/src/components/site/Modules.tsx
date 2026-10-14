import DOMPurify from 'dompurify';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { MouseEvent, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { assetUrl, videoEmbed, type SiteBackground, type SiteButton, type SiteCard, type SiteColumn, type SiteCompareSide, type SiteModule, type SiteModuleOf } from '../../lib/site';
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
  dark: 'dark site-band-dark bg-slate-950 text-slate-100',
  accent: 'bg-[linear-gradient(135deg,var(--grad-from),var(--grad-to))] text-white',
};

export function SiteModuleView({ module: m }: { module: SiteModule }) {
  const background = m.background ?? (m.type === 'cta' ? 'accent' : 'default');
  const onAccent = background === 'accent';
  // A call to action on the accent color is a rounded card on the page, as on appjoy.dev.
  const ctaCard = m.type === 'cta' && onAccent;
  const aside = m.type === 'cards' && m.buttons_position === 'header' ? <SiteButtons buttons={m.buttons} onAccent={onAccent} /> : null;
  return (
    <section id={m.anchor || undefined} className={`scroll-mt-20 ${ctaCard ? '' : BACKGROUND[background]} ${m.type === 'hero' ? 'site-hero relative isolate overflow-hidden' : ''}`}>
      <div className={`mx-auto max-w-6xl px-4 ${m.type === 'hero' ? 'py-16 sm:py-24' : 'py-12 sm:py-16'}`}>
        {m.type !== 'hero' && m.type !== 'cta' && <SectionHeader module={m} onAccent={onAccent} aside={aside} />}
        {ctaCard ? (
          <div className="site-cta-card rounded-[20px] px-5 py-14 text-white sm:rounded-[28px] sm:px-8 sm:py-[88px]">
            <ModuleBody module={m} onAccent />
          </div>
        ) : (
          <ModuleBody module={m} onAccent={onAccent} />
        )}
      </div>
    </section>
  );
}

/**
 * The small label, heading and intro every module may have, above its content (centered or left).
 * `aside` (a section's buttons) sits beside a left-aligned header on wide screens, else under it.
 */
function SectionHeader({ module: m, onAccent, aside }: { module: SiteModule; onAccent: boolean; aside?: ReactNode }) {
  if (!m.eyebrow && !m.heading && !m.intro) return aside ? <div className="mb-10 flex justify-center sm:mb-14">{aside}</div> : null;
  const left = m.align === 'left';
  const header = (
    <header className={`max-w-[780px] ${aside && left ? '' : 'mb-10 sm:mb-14'} ${left ? '' : 'mx-auto text-center'}`}>
      {m.eyebrow && (
        <Eyebrow onAccent={onAccent} badge={m.eyebrow_style === 'badge'}>
          {m.eyebrow}
        </Eyebrow>
      )}
      {m.heading && (
        <h2 className={HEADING}>
          <Accented text={m.heading} accent={m.heading_accent} onAccent={onAccent} />
        </h2>
      )}
      {m.intro && (
        <div className={`site-prose mt-5 max-w-[680px] text-[clamp(18px,1.6vw,21px)] ${left ? '' : 'mx-auto'} ${onAccent ? 'text-white/85' : 'text-slate-600 dark:text-slate-300'}`}>
          <Markdown>{m.intro}</Markdown>
        </div>
      )}
      {aside && !left && <div className="mt-8 flex justify-center">{aside}</div>}
    </header>
  );
  if (!aside || !left) return header;
  return (
    <div className="mb-10 grid gap-8 sm:mb-14 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:items-end">
      {header}
      <div className="flex md:justify-end">{aside}</div>
    </div>
  );
}

/** Section headings: the original appjoy.dev sizes (36 px on phones up to 56 px). */
const HEADING = 'text-[clamp(36px,4.6vw,56px)] leading-[1.1] font-semibold tracking-[-0.02em] text-balance';

/** Small capitals in the accent color, or (badge) a rounded label in the highlight color. */
function Eyebrow({ onAccent, badge, children }: { onAccent: boolean; badge?: boolean; children: ReactNode }) {
  if (badge) {
    return (
      <p className={`mb-[18px] inline-flex items-center rounded-full px-3 py-1 text-[13px] font-semibold ${onAccent ? 'bg-white/20 text-white' : 'site-badge'}`}>{children}</p>
    );
  }
  return <p className={`site-eyebrow mb-3 text-xs font-semibold uppercase tracking-[0.14em] ${onAccent ? 'text-white/80' : 'text-brand-700 dark:text-brand-600'}`}>{children}</p>;
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
        // Left-aligned sections run the list across the page, as appjoy.dev does; centered ones keep it narrower.
        <div className={`divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800 ${m.align === 'left' ? '' : 'mx-auto max-w-3xl'}`}>
          {m.items.map((q, i) => (
            <details key={i} className="group py-[22px]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left text-lg font-semibold [&::-webkit-details-marker]:hidden">
                {q.question}
                <span aria-hidden="true" className="text-2xl leading-none text-brand-600 transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <div className="site-prose mt-3 max-w-[760px] text-[17px] text-slate-600 dark:text-slate-300 [&_p]:my-0">
                <Markdown>{q.answer}</Markdown>
              </div>
            </details>
          ))}
        </div>
      );
    case 'compare':
      return (
        <div className="grid items-center gap-7 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <CompareSide side={m.before} />
          <span aria-hidden="true" className="site-hl-text justify-self-center text-3xl leading-none max-md:rotate-90">
            →
          </span>
          <CompareSide side={m.after} after />
        </div>
      );
    case 'cta':
      return (
        <div className="text-center">
          {m.eyebrow && <Eyebrow onAccent={onAccent}>{m.eyebrow}</Eyebrow>}
          <h2 className={HEADING}>
            <Accented text={m.heading} accent={m.heading_accent} onAccent={onAccent} />
          </h2>
          {m.text && (
            <div className={`site-prose mx-auto mt-5 max-w-[680px] text-[clamp(18px,1.6vw,21px)] ${onAccent ? 'text-white/85' : 'text-slate-600 dark:text-slate-300'}`}>
              <Markdown>{m.text}</Markdown>
            </div>
          )}
          <SiteButtons buttons={m.buttons} onAccent={onAccent} className="mt-9 justify-center" />
        </div>
      );
  }
}

/** A heading with its highlighted words in the accent gradient and italic (plain italic on the accent background). */
function Accented({ text, accent, onAccent }: { text: string; accent?: string; onAccent: boolean }) {
  const at = accent ? text.indexOf(accent) : -1;
  if (!accent || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <em className={onAccent ? 'italic' : 'site-accent-text italic'}>{accent}</em>
      {text.slice(at + accent.length)}
    </>
  );
}

/** One side of a before-and-after: a dashed box (before) or one in the highlight color (after), with chips. */
function CompareSide({ side: s, after }: { side: SiteCompareSide; after?: boolean }) {
  return (
    <div
      className={`rounded-[18px] border p-7 ${
        after ? 'site-compare-after' : 'border-dashed border-[color-mix(in_oklab,currentColor_25%,transparent)]'
      }`}
    >
      {s.label && <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.08em] opacity-60">{s.label}</h3>}
      {s.core && <p className="site-compare-core mb-3 rounded-xl p-4 text-center font-bold">{s.core}</p>}
      <ul className="flex flex-wrap gap-2">
        {s.items.map((c, i) => (
          <li key={i} className={`rounded-[10px] border px-3 py-2 text-sm ${after ? 'site-compare-chip' : 'border-[color-mix(in_oklab,currentColor_14%,transparent)] bg-[color-mix(in_oklab,currentColor_8%,transparent)]'}`}>
            {c.label}
            {c.note && <small className="ml-1.5 text-xs opacity-60">{c.note}</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Hero({ module: m, onAccent }: { module: SiteModuleOf<'hero'>; onAccent: boolean }) {
  return (
    <div className="mx-auto max-w-4xl text-center">
      {(m.badge || m.eyebrow) && (
        <p
          className={`mb-8 inline-flex items-center gap-2 rounded-full border py-1.5 pl-1.5 text-sm ${m.eyebrow ? 'pr-3.5' : 'pr-1.5'} ${!m.badge ? 'pl-3.5' : ''} ${
            onAccent ? 'border-white/40 text-white' : 'border-slate-200 bg-white text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
          }`}
        >
          {m.badge && (
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${onAccent ? 'bg-white/20 text-white' : 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-600'}`}>{m.badge}</span>
          )}
          {m.eyebrow}
        </p>
      )}
      <h1 className="mx-auto max-w-[1000px] text-[clamp(44px,7vw,88px)] leading-[1.1] font-semibold tracking-[-0.02em] text-balance">
        <Accented text={m.heading} accent={m.heading_accent} onAccent={onAccent} />
      </h1>
      {m.text && (
        <div className={`site-prose mx-auto mt-7 max-w-[680px] text-[clamp(18px,1.6vw,21px)] ${onAccent ? 'text-white/85' : 'text-slate-600 dark:text-slate-300'}`}>
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
          <Card
            key={i}
            card={c}
            number={m.variant === 'numbered' ? i + 1 : undefined}
            compact={compact}
            large={m.variant === 'large'}
            small={m.columns === 4}
            side={m.icon_position === 'side'}
            iconHighlight={m.icon_color === 'highlight'}
            onAccent={onAccent}
          />
        ))}
      </div>
      {m.buttons_position !== 'header' && <SiteButtons buttons={m.buttons} onAccent={onAccent} className="mt-10 justify-center" />}
    </>
  );
}

/**
 * One card. Regular cards follow appjoy.dev's sizes: 32 px padding, 44 px icons, 19 px headings and
 * 16 px text; in rows of four, 40 px icons, 17 px headings and 15 px text.
 */
function Card({
  card: c,
  number,
  compact,
  large,
  small,
  side,
  iconHighlight,
  onAccent,
}: {
  card: SiteCard;
  number?: number;
  compact: boolean;
  large?: boolean;
  small?: boolean;
  side?: boolean;
  iconHighlight?: boolean;
  onAccent: boolean;
}) {
  const hl = Boolean(c.highlight) && !compact && number === undefined && !onAccent;
  const box = small ? 'size-10' : 'size-11';
  const glyph = small ? 'size-5' : 'size-[22px]';
  const mark =
    number !== undefined ? (
      <span className={`flex ${box} shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-on-brand`}>{number}</span>
    ) : c.icon ? (
      <span
        className={`site-icon flex ${box} shrink-0 items-center justify-center rounded-xl ${
          onAccent ? 'bg-white/15 text-white' : iconHighlight || hl ? 'site-icon-hl' : 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-600'
        }`}
      >
        <SiteIcon name={c.icon} className={glyph} />
      </span>
    ) : null;
  const muted = onAccent ? 'text-white/85' : 'text-slate-600 dark:text-slate-300';
  const tag = onAccent ? 'text-white/80' : hl ? 'site-hl-text' : 'text-brand-700 dark:text-brand-600';
  const body = large ? (
    <>
      {c.eyebrow && <p className={`text-[13px] font-bold uppercase tracking-[0.08em] ${tag}`}>{c.eyebrow}</p>}
      {c.heading && <h3 className="site-heading mt-3 mb-1 text-[30px] leading-[1.1] font-semibold tracking-[-0.02em] sm:text-[36px]">{c.heading}</h3>}
      {c.text && (
        <div className={`site-prose site-arrows mt-3 flex-1 text-[17px] [&_strong]:text-slate-900 dark:[&_strong]:text-white ${muted}`}>
          <Markdown>{c.text}</Markdown>
        </div>
      )}
      {c.link_url && c.link_label && (
        <SiteLink
          href={c.link_url}
          className={`press mt-6 inline-flex items-center gap-2 self-start rounded-full px-6 py-3.5 text-base font-semibold ${onAccent ? 'bg-white text-slate-900' : hl ? 'site-hl-button' : 'btn-gradient shadow-sm'}`}
        >
          {c.link_label} →
        </SiteLink>
      )}
    </>
  ) : (
    <>
      {c.eyebrow && <p className={`text-xs font-semibold uppercase tracking-[0.12em] ${tag}`}>{c.eyebrow}</p>}
      {c.heading && (
        <h3 className={`${compact ? 'text-base' : small ? 'text-[17px]' : 'text-[19px]'} leading-[1.2] font-semibold tracking-[-0.01em] ${c.eyebrow ? 'mt-1' : ''}`}>{c.heading}</h3>
      )}
      {c.text && (
        <div className={`site-prose site-checks mt-2.5 flex-1 ${compact ? 'text-sm' : small ? 'text-[15px]' : 'text-base'} leading-[1.6] [&_p]:my-0 ${muted}`}>
          <Markdown>{c.text}</Markdown>
        </div>
      )}
      {c.link_url && c.link_label && (
        <SiteLink href={c.link_url} className={`mt-4 self-start text-sm font-semibold hover:underline ${onAccent ? 'text-white' : hl ? 'site-hl-text' : 'text-brand-700 dark:text-brand-600'}`}>
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
      className={`flex flex-col rounded-[18px] border ${large ? 'p-6 sm:p-10' : small ? 'p-6 sm:p-7' : 'p-6 sm:p-8'} ${
        onAccent
          ? 'border-white/20 bg-white/10'
          : hl
            ? 'site-hl bg-white shadow-sm dark:bg-slate-900'
            : 'border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900'
      }`}
    >
      {c.image_id && <img src={assetUrl(c.image_id)} alt={c.image_alt ?? ''} loading="lazy" className="mb-4 aspect-[4/3] w-full rounded-lg object-cover" />}
      {mark && side ? (
        <div className="flex flex-1 gap-4">
          {mark}
          <div className="flex min-w-0 flex-1 flex-col">{body}</div>
        </div>
      ) : (
        <>
          {mark && <div className={small ? 'mb-[18px]' : 'mb-[22px]'}>{mark}</div>}
          {body}
        </>
      )}
    </div>
  );
}

/**
 * Up to two buttons: by default the first filled and the second outlined (white on the accent
 * background); a button's style can make it filled, outlined or in the highlight color.
 */
export function SiteButtons({ buttons, onAccent, className = '' }: { buttons?: SiteButton[]; onAccent?: boolean; className?: string }) {
  if (!buttons?.length) return null;
  const base = 'press inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-base font-semibold';
  return (
    <div className={`flex flex-wrap gap-3 ${className}`}>
      {buttons.map((b, i) => {
        const style = b.style ?? (i === 0 ? 'primary' : 'secondary');
        const look = onAccent
          ? style === 'secondary'
            ? 'border border-white/60 text-white hover:bg-white/10'
            : 'bg-white text-slate-900 shadow-sm hover:bg-white/90'
          : style === 'highlight'
            ? 'site-hl-button shadow-sm'
            : style === 'primary'
              ? 'btn-gradient shadow-sm'
              : 'btn-outline-gradient';
        return (
          <SiteLink key={i} href={b.url} className={`${base} ${look}`}>
            {b.label}
          </SiteLink>
        );
      })}
    </div>
  );
}

/** Markdown from editors (no raw HTML); links to this site stay in the app. */
const MARKDOWN: Components = {
  a: ({ href, children }) => (href ? <SiteLink href={href}>{children}</SiteLink> : <>{children}</>),
};
export function Markdown({ children }: { children: string }) {
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
