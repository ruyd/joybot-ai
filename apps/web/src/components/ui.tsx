import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      {...props}
      className={cx(
        'press inline-flex items-center justify-center gap-1.5 rounded-full font-semibold disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-3 py-1 text-sm' : 'px-4.5 py-2 text-sm',
        variant === 'primary' && 'btn-gradient shadow-sm',
        variant === 'secondary' && 'btn-outline-gradient text-brand-700 dark:text-brand-600',
        variant === 'ghost' && 'font-medium text-slate-600 hover:bg-slate-100 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-brand-600',
        variant === 'danger' && 'bg-red-600 text-white shadow-sm hover:bg-red-700 hover:shadow-md hover:shadow-red-600/25',
        className,
      )}
    >
      {/* Outlined buttons with a text label get gradient text, like their border. */}
      {variant === 'secondary' && typeof children === 'string' ? <span className="text-gradient">{children}</span> : children}
    </button>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  brand: 'bg-brand-100 text-brand-700 dark:bg-slate-800 dark:text-brand-100',
};

export function Badge({ tone = 'slate', children }: { tone?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', BADGE[tone])}>{children}</span>;
}

/** Badge colour for appointment/payment statuses. */
export function StatusBadge({ status }: { status: string }) {
  const tone =
    ['succeeded', 'completed', 'confirmed', 'active'].includes(status)
      ? 'green'
      : ['pending', 'processing', 'scheduled', 'partially_refunded'].includes(status)
        ? 'amber'
        : ['failed', 'cancelled', 'canceled', 'no_show', 'disputed', 'voided', 'blocked'].includes(status)
          ? 'red'
          : 'slate';
  return <Badge tone={tone}>{status.replaceAll('_', ' ')}</Badge>;
}

/**
 * Loading, for screen readers only: the accent line under the header (lib/loading.ts) is the one
 * visible loading indicator, so screens don't flicker with small spinners.
 */
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="sr-only">
      {label}…
    </span>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputClass, props.className)} />;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cx('px-4 py-2 align-top', className)}>{children}</td>;
}

/** Page numbers to show: the first, the last, and the current page with its neighbours; null is a gap. */
export function pageList(page: number, pages: number): (number | null)[] {
  const sorted = [...new Set([1, pages, page - 1, page, page + 1])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  // A gap of exactly one page shows that page; longer gaps show an ellipsis.
  return sorted.flatMap((p, i) => {
    const gap = i > 0 ? p - sorted[i - 1] : 1;
    return gap === 2 ? [p - 1, p] : gap > 2 ? [null, p] : [p];
  });
}

/**
 * Under a table: "1–25 of 506", rows per page, and page numbers with previous and next arrows.
 * `offset` is the first row shown (0-based).
 */
export function Pager({
  total,
  offset,
  limit,
  onOffset,
  onLimit,
  sizes = [10, 25, 50, 100],
  busy,
  label = 'records',
}: {
  total: number;
  offset: number;
  limit: number;
  onOffset: (offset: number) => void;
  onLimit: (limit: number) => void;
  sizes?: number[];
  busy?: boolean;
  label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(pages, Math.floor(offset / limit) + 1);
  const go = (p: number) => onOffset((p - 1) * limit);
  const arrow = 'press grid size-8 place-items-center rounded-full text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-slate-300 dark:hover:bg-slate-800';
  return (
    <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-live="polite">
          {total ? `${(offset + 1).toLocaleString()}–${Math.min(offset + limit, total).toLocaleString()} of ` : ''}
          <strong className="font-semibold text-slate-700 dark:text-slate-200">{total.toLocaleString()}</strong> {label}
        </span>
        <label className="flex items-center gap-1.5">
          Rows per page
          <select
            value={limit}
            onChange={(e) => onLimit(Number(e.target.value))}
            className="rounded-md border border-slate-300 bg-white py-1 pr-7 pl-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            {sizes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          <button type="button" className={arrow} aria-label="Previous page" disabled={page <= 1 || busy} onClick={() => go(page - 1)}>
            <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M12.5 15l-5-5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {pageList(page, pages).map((p, i) =>
            p === null ? (
              <span key={`gap${i}`} className="px-1 text-slate-400" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                aria-label={`Page ${p}`}
                aria-current={p === page ? 'page' : undefined}
                disabled={busy && p !== page}
                onClick={() => p !== page && go(p)}
                className={`press min-w-8 rounded-full px-2 py-1 text-sm ${
                  p === page ? 'btn-gradient font-semibold' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {p}
              </button>
            ),
          )}
          <button type="button" className={arrow} aria-label="Next page" disabled={page >= pages || busy} onClick={() => go(page + 1)}>
            <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
    </nav>
  );
}
