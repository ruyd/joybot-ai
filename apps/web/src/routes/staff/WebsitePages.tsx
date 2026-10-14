import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Page } from '../../components/Layout';
import { SiteModules } from '../../components/site/Modules';
import { SiteTheme } from '../../components/site/Theme';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { ApiError, useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useMe } from '../../lib/me';
import { MODULE_LABEL, pagePath, videoEmbed, type SiteColumn, type SiteModule } from '../../lib/site';
import { CardsEditor, CompareEditor, CtaEditor, FaqEditor, HeroEditor, IconButton, ImagePicker, SectionOptions } from './WebsiteEditors';
import { SiteSetup, useSiteSettings } from './WebsiteSetup';

interface PageRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  is_home: boolean;
  published: boolean;
  show_in_header: boolean;
  show_in_footer: boolean;
  sort_order: number;
  module_count: number;
  updated_at: string;
  updated_by_name: string | null;
}
interface PageDoc extends PageRow {
  modules: SiteModule[];
}
type Draft = Pick<PageDoc, 'slug' | 'title' | 'description' | 'published' | 'show_in_header' | 'show_in_footer' | 'sort_order' | 'modules'>;

const toDraft = (p: PageDoc): Draft => ({
  slug: p.slug,
  title: p.title,
  description: p.description,
  published: p.published,
  show_in_header: p.show_in_header,
  show_in_footer: p.show_in_footer,
  sort_order: p.sort_order,
  modules: p.modules,
});

const newId = () => crypto.randomUUID();
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function blankModule(type: SiteModule['type']): SiteModule {
  const id = newId();
  switch (type) {
    case 'columns':
      return { id, type, heading: '', columns: [{}, {}, {}] };
    case 'html':
      return { id, type, html: '<h2>Heading</h2>\n<p>Text</p>' };
    case 'image':
      return { id, type, image_id: '', alt: '', size: 'full' };
    case 'video':
      return { id, type, url: '' };
    case 'hero':
      return { id, type, heading: '', buttons: [] };
    case 'cards':
      return { id, type, variant: 'cards', columns: 3, items: [{}, {}, {}] };
    case 'faq':
      return { id, type, items: [{ question: '', answer: '' }] };
    case 'cta':
      return { id, type, heading: '', buttons: [] };
    case 'compare':
      return { id, type, before: { label: 'Before', items: [{ label: '' }] }, after: { label: 'After', items: [{ label: '' }] } };
  }
}

/** Site setup is chosen in the pages list like a page. */
const SETUP = 'setup';

/** Marketing › Website: site setup (look and header) and the public site's pages, each a list of modules. */
export function WebsitePage() {
  const api = useApi();
  const { can } = useMe();
  const pages = useQuery({ queryKey: ['website', 'pages'], queryFn: () => api.get<PageRow[]>('/website/pages') });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const dirty = useRef(false);
  const current = selected ?? pages.data?.[0]?.id ?? null;

  const select = (id: string | null, create = false) => {
    if (dirty.current && !window.confirm('Discard your unsaved changes to this page?')) return;
    dirty.current = false;
    setSelected(id);
    setCreating(create);
  };

  return (
    <Page>
      <PageHeader
        title="Website"
        description="Your public site at the root of this app: pages built from modules, shown in the header and footer as you choose, in your own colors and fonts."
        actions={
          <a href="/" target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-600">
            Open the site ↗
          </a>
        }
      />
      <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <Card
          title="Pages"
          actions={
            can('create', 'website') && (
              <Button size="sm" variant="secondary" onClick={() => select(null, true)}>
                New page
              </Button>
            )
          }
        >
          {pages.isLoading ? (
            <Spinner />
          ) : pages.error ? (
            <ErrorBanner error={pages.error} />
          ) : (
            <ul className="-mx-2 space-y-0.5">
              <li className="mb-1 border-b border-slate-200 pb-1 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => select(SETUP)}
                  aria-current={!creating && current === SETUP ? 'page' : undefined}
                  className={`press w-full rounded-lg px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800 ${!creating && current === SETUP ? 'bg-brand-50 dark:bg-slate-800' : ''}`}
                >
                  <span className="block text-sm font-medium">Site setup</span>
                  <span className="block text-xs text-slate-500">Colors, fonts, logo and header</span>
                </button>
              </li>
              {pages.data?.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => select(p.id)}
                    aria-current={!creating && p.id === current ? 'page' : undefined}
                    className={`press w-full rounded-lg px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800 ${!creating && p.id === current ? 'bg-brand-50 dark:bg-slate-800' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.title}</span>
                      {p.is_home ? <Badge tone="brand">home</Badge> : !p.published && <Badge>draft</Badge>}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {pagePath(p)}
                      {p.show_in_header && ' · header'}
                      {p.show_in_footer && ' · footer'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {creating ? (
          <NewPage
            onCreated={(id) => {
              setCreating(false);
              setSelected(id);
            }}
            onCancel={() => setCreating(false)}
          />
        ) : current === SETUP ? (
          <SiteSetup
            onDirty={(d) => {
              dirty.current = d;
            }}
          />
        ) : current ? (
          <PageEditor key={current} id={current} onDirty={(d) => {
              dirty.current = d;
            }} onDeleted={() => select(null)} />
        ) : (
          !pages.isLoading && <EmptyState>No pages yet.</EmptyState>
        )}
      </div>
    </Page>
  );
}

function NewPage({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const create = useMutation({
    mutationFn: () => api.post<PageDoc>('/website/pages', { title: title.trim(), slug, modules: [blankModule('html')] }),
    onSuccess: (p) => {
      void queryClient.invalidateQueries({ queryKey: ['website', 'pages'] });
      onCreated(p.id);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="New page">
      <form className="space-y-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title">
            <Input
              required
              autoFocus
              maxLength={120}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (!slugEdited) setSlug(slugify(e.target.value));
              }}
            />
          </Field>
          <Field label="Address" hint={`${window.location.origin}/${slug || '…'}`}>
            <Input
              required
              maxLength={60}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={slug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(slugify(e.target.value));
              }}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-500">New pages start as drafts: publish them when they're ready.</p>
        <div className="flex gap-2">
          <Button type="submit" disabled={!title.trim() || !slug || create.isPending}>
            Create page
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <SaveError error={create.error} />
      </form>
    </Card>
  );
}

function PageEditor({ id, onDirty, onDeleted }: { id: string; onDirty: (dirty: boolean) => void; onDeleted: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const page = useQuery({ queryKey: ['website', 'page', id], queryFn: () => api.get<PageDoc>(`/website/pages/${id}`) });
  const settings = useSiteSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState(false);
  // Modules start collapsed; ones added during this edit open right away.
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const saved = page.data ? toDraft(page.data) : null;
  const form = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const refresh = (p: PageDoc) => {
    queryClient.setQueryData(['website', 'page', id], p);
    void queryClient.invalidateQueries({ queryKey: ['website', 'pages'] });
    void queryClient.invalidateQueries({ queryKey: ['site'] });
    setDraft(null);
  };
  const save = useMutation({ mutationFn: (body: Partial<Draft> & { is_home?: true }) => api.put<PageDoc>(`/website/pages/${id}`, body), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api.del(`/website/pages/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['website', 'pages'] });
      void queryClient.invalidateQueries({ queryKey: ['site'] });
      onDirty(false);
      onDeleted();
    },
  });

  if (page.isLoading) return <Spinner />;
  if (page.error || !page.data || !form) return <ErrorBanner error={page.error} />;
  const p = page.data;
  const editable = can('update', 'website');
  const set = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
  const setModule = (i: number, m: SiteModule) => set({ modules: form.modules.map((x, j) => (j === i ? m : x)) });
  const move = (i: number, by: number) => {
    const list = [...form.modules];
    const [m] = list.splice(i, 1);
    list.splice(i + by, 0, m);
    set({ modules: list });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...form, description: form.description?.trim() || null });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            {p.title} {p.is_home ? <Badge tone="brand">home page</Badge> : p.published ? <Badge tone="green">published</Badge> : <Badge>draft</Badge>}
          </span>
        }
        actions={
          p.published && (
            <a href={pagePath(p)} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-600">
              View ↗
            </a>
          )
        }
      >
        <fieldset disabled={!editable} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title">
              <Input required maxLength={120} value={form.title} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="Address" hint={p.is_home ? 'The home page is shown at /' : `${window.location.origin}/${form.slug}`}>
              <Input required maxLength={60} value={form.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} />
            </Field>
          </div>
          <Field label="Description" hint="Shown by search engines under the page title.">
            <Input maxLength={300} value={form.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <Check label="Published" checked={form.published} disabled={p.is_home} onChange={(v) => set({ published: v })} />
            <Check label="Show in header" checked={form.show_in_header} onChange={(v) => set({ show_in_header: v })} />
            <Check label="Show in footer" checked={form.show_in_footer} onChange={(v) => set({ show_in_footer: v })} />
            <label className="flex items-center gap-2">
              Order
              <Input type="number" className="w-20" value={form.sort_order} onChange={(e) => set({ sort_order: Number(e.target.value) || 0 })} />
            </label>
          </div>
        </fieldset>
      </Card>

      <Card
        title={`Modules (${form.modules.length})`}
        actions={
          <div className="flex rounded-full bg-slate-100 p-0.5 text-sm dark:bg-slate-800" role="group" aria-label="View">
            {(['Edit', 'Preview'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={(v === 'Preview') === preview}
                onClick={() => setPreview(v === 'Preview')}
                className={`rounded-full px-3 py-1 font-medium ${(v === 'Preview') === preview ? 'bg-white shadow-sm dark:bg-slate-900' : 'text-slate-500'}`}
              >
                {v}
              </button>
            ))}
          </div>
        }
      >
        {preview ? (
          <SiteTheme settings={settings.data} className="-m-4 overflow-hidden rounded-b-xl bg-white dark:bg-slate-950">
            {form.modules.length ? <SiteModules modules={form.modules.filter((m) => m.type !== 'image' || m.image_id)} /> : <EmptyState>No modules yet.</EmptyState>}
          </SiteTheme>
        ) : (
          <fieldset disabled={!editable} className="space-y-3">
            {form.modules.length === 0 && <EmptyState>No modules yet: add one below.</EmptyState>}
            {form.modules.map((m, i) => (
              <ModuleCard
                key={m.id}
                initialOpen={added.has(m.id)}
                index={i}
                module={m}
                count={form.modules.length}
                onChange={(next) => setModule(i, next)}
                onMove={(by) => move(i, by)}
                onRemove={() => set({ modules: form.modules.filter((_, j) => j !== i) })}
              />
            ))}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-sm text-slate-500">Add:</span>
              {(Object.keys(MODULE_LABEL) as SiteModule['type'][]).map((t) => (
                <Button key={t} type="button" size="sm" variant="secondary" onClick={() => {
                    const next = blankModule(t);
                    setAdded((a) => new Set(a).add(next.id));
                    set({ modules: [...form.modules, next] });
                  }}>
                  {`+ ${MODULE_LABEL[t]}`}
                </Button>
              ))}
            </div>
          </fieldset>
        )}
      </Card>

      {editable && (
        <div className="sticky bottom-20 z-[5] flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <Button type="submit" disabled={!dirty || save.isPending}>
            Save
          </Button>
          <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setDraft(null)}>
            Discard changes
          </Button>
          <span className="text-xs text-slate-500">
            {dirty ? 'Unsaved changes' : `Saved ${dateTime(p.updated_at)}${p.updated_by_name ? ` by ${p.updated_by_name}` : ''}`}
          </span>
          <span className="ml-auto flex gap-2">
            {!p.is_home && (
              <Button type="button" size="sm" variant="ghost" disabled={dirty || save.isPending} onClick={() => save.mutate({ is_home: true })}>
                Make home page
              </Button>
            )}
            {!p.is_home && can('delete', 'website') && (
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={remove.isPending}
                onClick={() => window.confirm(`Delete the page “${p.title}”? This cannot be undone.`) && remove.mutate()}
              >
                Delete page
              </Button>
            )}
          </span>
          <div className="basis-full empty:hidden">
            <SaveError error={save.error ?? remove.error} />
          </div>
        </div>
      )}
    </form>
  );
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const NUMBERED: Record<string, string> = { modules: 'Module', columns: 'column', items: 'item', buttons: 'button', header_links: 'Header link' };

/** The API's validation issues, named the way the editor shows them ("Module 2 › column 1 › link"). */
function SaveError({ error }: { error: unknown }) {
  if (!error) return null;
  const issues = error instanceof ApiError ? error.body.issues : undefined;
  if (!issues?.length) return <ErrorBanner error={error} />;
  const name = (path: string) =>
    path
      .split('.')
      .map((part, i, all) => (NUMBERED[all[i - 1]] && /^\d+$/.test(part) ? `${NUMBERED[all[i - 1]]} ${Number(part) + 1}` : part))
      .filter((part, i, all) => !(NUMBERED[part] && /^\d+$/.test(all[i + 1] ?? '')))
      .map((part) => part.replace(/_/g, ' '))
      .join(' › ');
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <p className="font-medium">Not saved:</p>
      <ul className="list-disc pl-5">
        {issues.map((i, k) => (
          <li key={k}>
            {i.path ? `${name(i.path)}: ` : ''}
            {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Modules ----------------------------------------------------------------------------------------

/** A short line describing a module's content, shown on its collapsed header. */
function moduleSummary(m: SiteModule): string {
  const text = (v?: string | null) => (v ?? '').replace(/<[^>]*>/g, ' ').replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').trim();
  const first =
    text(m.heading) ||
    (m.type === 'hero' || m.type === 'cta' ? text(m.text) : '') ||
    (m.type === 'html' ? text(m.html) : '') ||
    (m.type === 'image' ? text(m.alt) : '') ||
    (m.type === 'video' ? m.url : '') ||
    (m.type === 'cards' ? text(m.items[0]?.heading) : '') ||
    (m.type === 'faq' ? text(m.items[0]?.question) : '') ||
    (m.type === 'columns' ? text(m.columns[0]?.heading) : '') ||
    text(m.eyebrow);
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

function ModuleCard({
  initialOpen = false,
  index,
  module: m,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  initialOpen?: boolean;
  index: number;
  module: SiteModule;
  count: number;
  onChange: (m: SiteModule) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const summary = moduleSummary(m);
  const bodyId = `module-${m.id}`;
  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800" aria-label={`Module ${index + 1}: ${MODULE_LABEL[m.type]}`}>
      <header className={`flex items-center gap-1 px-3 py-1.5 ${open ? 'border-b border-slate-200 dark:border-slate-800' : ''}`}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="press -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
        >
          <ChevronRight aria-hidden="true" className={`size-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {index + 1}. {MODULE_LABEL[m.type]}
          </span>
          {summary && <span className="min-w-0 truncate text-sm text-slate-600 dark:text-slate-300">{summary}</span>}
        </button>
        <span className="ml-auto flex shrink-0 gap-0.5">
          <IconButton label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </IconButton>
          <IconButton label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            ↓
          </IconButton>
          <IconButton label="Remove module" onClick={() => window.confirm(`Remove this ${MODULE_LABEL[m.type].toLowerCase()} module?`) && onRemove()}>
            ✕
          </IconButton>
        </span>
      </header>
      {open && (
        <div id={bodyId} className="space-y-3 p-3">
          <SectionOptions module={m} onChange={onChange} />
          {m.type === 'hero' && <HeroEditor module={m} onChange={onChange} />}
          {m.type === 'cards' && <CardsEditor module={m} onChange={onChange} />}
          {m.type === 'faq' && <FaqEditor module={m} onChange={onChange} />}
          {m.type === 'cta' && <CtaEditor module={m} onChange={onChange} />}
          {m.type === 'compare' && <CompareEditor module={m} onChange={onChange} />}
          {m.type === 'columns' && <ColumnsEditor module={m} onChange={onChange} />}
          {m.type === 'html' && (
            <Field label="HTML" hint="Headings, paragraphs, lists, links, images and tables. Scripts, styles, forms and embeds are removed when you save.">
              <textarea
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                rows={8}
                value={m.html}
                onChange={(e) => onChange({ ...m, html: e.target.value })}
              />
            </Field>
          )}
          {m.type === 'image' && (
            <>
              <ImagePicker value={m.image_id || null} onChange={(image_id) => onChange({ ...m, image_id: image_id ?? '' })} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Alt text" hint="Describes the image for screen readers.">
                  <Input maxLength={300} value={m.alt} onChange={(e) => onChange({ ...m, alt: e.target.value })} />
                </Field>
                <Field label="Caption">
                  <Input maxLength={300} value={m.caption ?? ''} onChange={(e) => onChange({ ...m, caption: e.target.value })} />
                </Field>
                <Field label="Size">
                  <Select value={m.size} onChange={(e) => onChange({ ...m, size: e.target.value as 'small' | 'medium' | 'full' })}>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="full">Full width</option>
                  </Select>
                </Field>
                <Field label="Link (optional)" hint="https://…, or /page on this site">
                  <Input maxLength={500} value={m.link_url ?? ''} onChange={(e) => onChange({ ...m, link_url: e.target.value })} />
                </Field>
              </div>
            </>
          )}
          {m.type === 'video' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="YouTube or Vimeo link" hint={m.url && !videoEmbed(m.url) ? 'This is not a YouTube or Vimeo link.' : 'e.g. https://www.youtube.com/watch?v=…'}>
                <Input maxLength={500} value={m.url} onChange={(e) => onChange({ ...m, url: e.target.value })} />
              </Field>
              <Field label="Caption">
                <Input maxLength={300} value={m.caption ?? ''} onChange={(e) => onChange({ ...m, caption: e.target.value })} />
              </Field>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ColumnsEditor({ module: m, onChange }: { module: Extract<SiteModule, { type: 'columns' }>; onChange: (m: SiteModule) => void }) {
  const setColumn = (i: number, patch: Partial<SiteColumn>) => onChange({ ...m, columns: m.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setCount = (n: number) => onChange({ ...m, columns: Array.from({ length: n }, (_, i) => m.columns[i] ?? {}) });
  return (
    <>
      <div className="grid gap-3 sm:max-w-[9rem]">
        <Field label="Columns">
          <Select value={m.columns.length} onChange={(e) => setCount(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className={`grid gap-3 ${m.columns.length > 1 ? 'md:grid-cols-2' : ''} ${m.columns.length > 2 ? 'xl:grid-cols-3' : ''}`}>
        {m.columns.map((c, i) => (
          <div key={i} className="space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
            <p className="text-xs font-semibold text-slate-500">Column {i + 1}</p>
            <Input placeholder="Heading" maxLength={120} value={c.heading ?? ''} onChange={(e) => setColumn(i, { heading: e.target.value })} />
            <textarea
              placeholder="Text (Markdown: **bold**, *italic*, - lists, [links](/contact))"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              rows={4}
              maxLength={4000}
              value={c.text ?? ''}
              onChange={(e) => setColumn(i, { text: e.target.value })}
            />
            <ImagePicker compact value={c.image_id ?? null} onChange={(image_id) => setColumn(i, { image_id })} />
            {c.image_id && <Input placeholder="Image alt text" maxLength={300} value={c.image_alt ?? ''} onChange={(e) => setColumn(i, { image_alt: e.target.value })} />}
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Link label" maxLength={60} value={c.link_label ?? ''} onChange={(e) => setColumn(i, { link_label: e.target.value })} />
              <Input placeholder="/page or https://…" maxLength={500} value={c.link_url ?? ''} onChange={(e) => setColumn(i, { link_url: e.target.value })} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
