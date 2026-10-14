import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { Button, ErrorBanner, Field, Input, Select, Spinner } from '../../components/ui';
import { ApiError, useApi } from '../../lib/api';
import { appConfig } from '../../lib/config';
import { assetUrl, type SiteBackground, type SiteButton, type SiteCard, type SiteCompareSide, type SiteModule, type SiteModuleOf } from '../../lib/site';
import { SITE_ICONS, SiteIcon, type SiteIconName } from '../../lib/site-icons';

/** Editors for Marketing › Website: section options, buttons, lists, images and the newer module types. */

export interface Asset {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** 'db' while still in the database after the server switched to a bucket. */
  storage?: 'db' | 's3';
  created_at: string;
}

const textareaClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900';

export function TextArea({ value, onChange, rows = 3, maxLength, placeholder }: { value: string | undefined; onChange: (v: string) => void; rows?: number; maxLength: number; placeholder?: string }) {
  return <textarea className={textareaClass} rows={rows} maxLength={maxLength} placeholder={placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

export function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="press flex size-7 items-center justify-center rounded-full text-sm text-slate-500 hover:bg-slate-100 hover:text-brand-700 disabled:opacity-30 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  );
}

/** Move up, move down and remove for one entry of a list. */
export function ListControls({ index, count, noun, onMove, onRemove }: { index: number; count: number; noun: string; onMove: (by: number) => void; onRemove: () => void }) {
  return (
    <span className="ml-auto flex gap-0.5">
      <IconButton label={`Move ${noun} up`} disabled={index === 0} onClick={() => onMove(-1)}>
        ↑
      </IconButton>
      <IconButton label={`Move ${noun} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
        ↓
      </IconButton>
      <IconButton label={`Remove ${noun}`} onClick={onRemove}>
        ✕
      </IconButton>
    </span>
  );
}

/** A list with one entry moved by `by` places. */
export function moved<T>(list: T[], i: number, by: number): T[] {
  const next = [...list];
  const [x] = next.splice(i, 1);
  next.splice(i + by, 0, x);
  return next;
}

const BACKGROUNDS: { value: SiteBackground; label: string }[] = [
  { value: 'default', label: 'Page' },
  { value: 'alt', label: 'Tinted' },
  { value: 'dark', label: 'Dark' },
  { value: 'accent', label: 'Accent color' },
];

/**
 * The options every module has. Hero and call-to-action modules have their own headline and text, so
 * they show only the anchor, background and label here.
 */
export function SectionOptions({ module: m, onChange }: { module: SiteModule; onChange: (m: SiteModule) => void }) {
  const own = m.type === 'hero' || m.type === 'cta';
  const [open, setOpen] = useState(Boolean(m.anchor || m.background || (!own && (m.eyebrow || m.heading || m.intro)) || (own && m.eyebrow)));
  const set = (patch: Partial<SiteModule>) => onChange({ ...m, ...patch } as SiteModule);
  return (
    <div className="rounded-lg bg-slate-50 dark:bg-slate-950">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-500" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        Section: {own ? 'label, background and anchor' : 'label, heading, intro, background and anchor'}
        {!open && m.anchor && <span className="font-normal">· #{m.anchor}</span>}
      </button>
      {open && (
        <div className="grid gap-3 px-3 pb-3 sm:grid-cols-2">
          <Field label="Label" hint={m.type === 'hero' ? 'The line above the headline, e.g. Meet JoyBot AI, core software for your business' : 'Small text above the heading, e.g. HOW IT WORKS'}>
            <Input maxLength={80} value={m.eyebrow ?? ''} onChange={(e) => set({ eyebrow: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3 sm:col-span-2 lg:grid-cols-4">
            <Field label="Label style">
              <Select value={m.eyebrow_style ?? 'text'} onChange={(e) => set({ eyebrow_style: e.target.value as 'text' | 'badge' })}>
                <option value="text">Small capitals</option>
                <option value="badge">Badge (highlight color)</option>
              </Select>
            </Field>
            <Field label="Align">
              <Select value={m.align ?? 'center'} onChange={(e) => set({ align: e.target.value as 'center' | 'left' })}>
                <option value="center">Centered</option>
                <option value="left">Left</option>
              </Select>
            </Field>
            <Field label="Background">
              <Select value={m.background ?? (m.type === 'cta' ? 'accent' : 'default')} onChange={(e) => set({ background: e.target.value as SiteBackground })}>
                {BACKGROUNDS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Anchor" hint={m.anchor ? `Link: #${m.anchor}` : 'For links like #services'}>
              <Input
                maxLength={40}
                value={m.anchor ?? ''}
                onChange={(e) =>
                  set({
                    anchor: e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9-]+/g, '-')
                      .replace(/^[^a-z]+/, ''),
                  })
                }
              />
            </Field>
          </div>
          {!own && (
            <>
              <Field label="Heading">
                <Input maxLength={200} value={m.heading ?? ''} onChange={(e) => set({ heading: e.target.value })} />
              </Field>
              <HighlightField heading={m.heading} value={m.heading_accent} onChange={(heading_accent) => set({ heading_accent })} />
              <div className="sm:col-span-2">
                <Field label="Intro" hint="Markdown: **bold**, *italic*, [links](/contact)">
                  <TextArea rows={2} maxLength={2000} value={m.intro} onChange={(intro) => set({ intro })} />
                </Field>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Words of a heading to highlight, with a warning when they are not in it. */
function HighlightField({ heading, value, onChange, example = 'on demand' }: { heading?: string; value?: string; onChange: (v: string) => void; example?: string }) {
  const missing = value && !(heading ?? '').includes(value);
  return (
    <Field label="Highlight" hint={missing ? 'These words are not in the heading.' : `Words of the heading in the accent color, e.g. ${example}`}>
      <Input maxLength={80} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** Up to two buttons: by default the first is drawn filled and the second outlined; each can be set. */
export function ButtonsEditor({ buttons = [], onChange }: { buttons?: SiteButton[]; onChange: (b: SiteButton[]) => void }) {
  const set = (i: number, patch: Partial<SiteButton>) => onChange(buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Buttons</p>
      {buttons.map((b, i) => (
        <div key={i} className="grid items-center gap-2 sm:grid-cols-[11rem_minmax(0,1fr)_minmax(0,2fr)_auto]">
          <Select
            aria-label={`Button ${i + 1} style`}
            value={b.style ?? ''}
            onChange={(e) => set(i, { style: (e.target.value || undefined) as SiteButton['style'] })}
          >
            <option value="">{i === 0 ? 'Filled' : 'Outlined'} (default)</option>
            <option value="primary">Filled</option>
            <option value="secondary">Outlined</option>
            <option value="highlight">Highlight color</option>
          </Select>
          <Input aria-label={`Button ${i + 1} label`} placeholder="Label" maxLength={60} value={b.label} onChange={(e) => set(i, { label: e.target.value })} />
          <Input aria-label={`Button ${i + 1} link`} placeholder="/page, #section, https://…, mailto:…" maxLength={500} value={b.url} onChange={(e) => set(i, { url: e.target.value })} />
          <IconButton label="Remove button" onClick={() => onChange(buttons.filter((_, j) => j !== i))}>
            ✕
          </IconButton>
        </div>
      ))}
      {buttons.length < 2 && (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...buttons, { label: '', url: '' }])}>
          + Button
        </Button>
      )}
    </div>
  );
}

export function HeroEditor({ module: m, onChange }: { module: SiteModuleOf<'hero'>; onChange: (m: SiteModule) => void }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="Headline">
          <Input required maxLength={200} value={m.heading} onChange={(e) => onChange({ ...m, heading: e.target.value })} />
        </Field>
        <HighlightField heading={m.heading} value={m.heading_accent} onChange={(heading_accent) => onChange({ ...m, heading_accent })} example="AI revolution" />
      </div>
      <div className="sm:max-w-xs">
        <Field label="Badge" hint="A short rounded label before the label line, e.g. Open source">
          <Input maxLength={40} value={m.badge ?? ''} onChange={(e) => onChange({ ...m, badge: e.target.value })} />
        </Field>
      </div>
      <Field label="Text" hint="Markdown">
        <TextArea rows={3} maxLength={2000} value={m.text} onChange={(text) => onChange({ ...m, text })} />
      </Field>
      <ButtonsEditor buttons={m.buttons} onChange={(buttons) => onChange({ ...m, buttons })} />
      <div className="space-y-2">
        <p className="text-sm font-medium">Image below (optional)</p>
        <ImagePicker compact value={m.image_id ?? null} onChange={(image_id) => onChange({ ...m, image_id })} />
        {m.image_id && <Input placeholder="Image alt text" maxLength={300} value={m.image_alt ?? ''} onChange={(e) => onChange({ ...m, image_alt: e.target.value })} />}
      </div>
    </>
  );
}

export function CardsEditor({ module: m, onChange }: { module: SiteModuleOf<'cards'>; onChange: (m: SiteModule) => void }) {
  const setItem = (i: number, patch: Partial<SiteCard>) => onChange({ ...m, items: m.items.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="Style">
          <Select value={m.variant} onChange={(e) => onChange({ ...m, variant: e.target.value as SiteModuleOf<'cards'>['variant'] })}>
            <option value="cards">Cards</option>
            <option value="large">Large cards</option>
            <option value="numbered">Numbered steps</option>
            <option value="compact">Compact list</option>
          </Select>
        </Field>
        <Field label="Icons">
          <Select value={m.icon_position ?? 'top'} disabled={m.variant !== 'cards' && m.variant !== 'large'} onChange={(e) => onChange({ ...m, icon_position: e.target.value as 'top' | 'side' })}>
            <option value="top">Above the text</option>
            <option value="side">Beside the text</option>
          </Select>
        </Field>
        <Field label="Icon color">
          <Select value={m.icon_color ?? 'accent'} onChange={(e) => onChange({ ...m, icon_color: e.target.value as 'accent' | 'highlight' })}>
            <option value="accent">Accent</option>
            <option value="highlight">Highlight</option>
          </Select>
        </Field>
        <Field label="Buttons">
          <Select value={m.buttons_position ?? 'below'} onChange={(e) => onChange({ ...m, buttons_position: e.target.value as 'below' | 'header' })}>
            <option value="below">Under the cards</option>
            <option value="header">Beside the heading</option>
          </Select>
        </Field>
        <Field label="Per row">
          <Select value={m.columns} onChange={(e) => onChange({ ...m, columns: Number(e.target.value) as 2 | 3 | 4 })}>
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {m.items.map((c, i) => (
          <div key={i} className="space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-slate-500">Card {i + 1}</p>
              <ListControls
                index={i}
                count={m.items.length}
                noun="card"
                onMove={(by) => onChange({ ...m, items: moved(m.items, i, by) })}
                onRemove={() => m.items.length > 1 && onChange({ ...m, items: m.items.filter((_, j) => j !== i) })}
              />
            </div>
            {m.variant !== 'numbered' && <IconPicker value={c.icon ?? null} onChange={(icon) => setItem(i, { icon })} />}
            {(m.variant === 'cards' || m.variant === 'large') && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={Boolean(c.highlight)} onChange={(e) => setItem(i, { highlight: e.target.checked || undefined })} />
                Highlight (in the highlight color from Site setup)
              </label>
            )}
            <Input placeholder="Label (optional)" maxLength={80} value={c.eyebrow ?? ''} onChange={(e) => setItem(i, { eyebrow: e.target.value })} />
            <Input placeholder="Heading" maxLength={120} value={c.heading ?? ''} onChange={(e) => setItem(i, { heading: e.target.value })} />
            <TextArea
              rows={m.variant === 'large' ? 7 : 4}
              maxLength={4000}
              placeholder={`Text (Markdown). Lists get ${m.variant === 'large' ? 'arrows' : 'check marks'}:\n- First point\n- Second point${m.variant === 'large' ? '\n\n---\n\n**Best for:** a divider, then smaller text' : ''}`}
              value={c.text}
              onChange={(text) => setItem(i, { text })}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Link label" maxLength={60} value={c.link_label ?? ''} onChange={(e) => setItem(i, { link_label: e.target.value })} />
              <Input placeholder="/page or https://…" maxLength={500} value={c.link_url ?? ''} onChange={(e) => setItem(i, { link_url: e.target.value })} />
            </div>
            {m.variant === 'cards' && <ImagePicker compact value={c.image_id ?? null} onChange={(image_id) => setItem(i, { image_id })} />}
            {c.image_id && <Input placeholder="Image alt text" maxLength={300} value={c.image_alt ?? ''} onChange={(e) => setItem(i, { image_alt: e.target.value })} />}
          </div>
        ))}
      </div>
      {m.items.length < 12 && (
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...m, items: [...m.items, {}] })}>
          + Card
        </Button>
      )}
      <ButtonsEditor buttons={m.buttons} onChange={(buttons) => onChange({ ...m, buttons })} />
    </>
  );
}

export function FaqEditor({ module: m, onChange }: { module: SiteModuleOf<'faq'>; onChange: (m: SiteModule) => void }) {
  const setItem = (i: number, patch: Partial<SiteModuleOf<'faq'>['items'][number]>) => onChange({ ...m, items: m.items.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  return (
    <>
      {m.items.map((q, i) => (
        <div key={i} className="space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-slate-500">Question {i + 1}</p>
            <ListControls
              index={i}
              count={m.items.length}
              noun="question"
              onMove={(by) => onChange({ ...m, items: moved(m.items, i, by) })}
              onRemove={() => m.items.length > 1 && onChange({ ...m, items: m.items.filter((_, j) => j !== i) })}
            />
          </div>
          <Input placeholder="Question" required maxLength={300} value={q.question} onChange={(e) => setItem(i, { question: e.target.value })} />
          <TextArea rows={3} maxLength={4000} placeholder="Answer (Markdown)" value={q.answer} onChange={(answer) => setItem(i, { answer })} />
        </div>
      ))}
      {m.items.length < 30 && (
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...m, items: [...m.items, { question: '', answer: '' }] })}>
          + Question
        </Button>
      )}
    </>
  );
}

export function CtaEditor({ module: m, onChange }: { module: SiteModuleOf<'cta'>; onChange: (m: SiteModule) => void }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="Heading">
          <Input required maxLength={200} value={m.heading} onChange={(e) => onChange({ ...m, heading: e.target.value })} />
        </Field>
        <HighlightField heading={m.heading} value={m.heading_accent} onChange={(heading_accent) => onChange({ ...m, heading_accent })} example="your software" />
      </div>
      <Field label="Text" hint="Markdown">
        <TextArea rows={2} maxLength={2000} value={m.text} onChange={(text) => onChange({ ...m, text })} />
      </Field>
      <ButtonsEditor buttons={m.buttons} onChange={(buttons) => onChange({ ...m, buttons })} />
    </>
  );
}

export function CompareEditor({ module: m, onChange }: { module: SiteModuleOf<'compare'>; onChange: (m: SiteModule) => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <CompareSideEditor title="Before" hint="Shown in a dashed box" side={m.before} onChange={(before) => onChange({ ...m, before })} />
      <CompareSideEditor title="After" hint="Shown in the highlight color" side={m.after} onChange={(after) => onChange({ ...m, after })} />
    </div>
  );
}

function CompareSideEditor({ title, hint, side: s, onChange }: { title: string; hint: string; side: SiteCompareSide; onChange: (s: SiteCompareSide) => void }) {
  const setItem = (i: number, patch: Partial<SiteCompareSide['items'][number]>) => onChange({ ...s, items: s.items.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
      <p className="text-xs font-semibold text-slate-500">
        {title} <span className="font-normal">· {hint}</span>
      </p>
      <Input placeholder="Label, e.g. Today: rented & scattered" maxLength={80} value={s.label ?? ''} onChange={(e) => onChange({ ...s, label: e.target.value })} />
      <Input placeholder="Bar across the top (optional), e.g. Your core business app + AI" maxLength={120} value={s.core ?? ''} onChange={(e) => onChange({ ...s, core: e.target.value })} />
      {s.items.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input placeholder="Chip, e.g. CRM" maxLength={60} value={c.label} onChange={(e) => setItem(i, { label: e.target.value })} />
          <Input placeholder="Note, e.g. per seat" className="w-36" maxLength={40} value={c.note ?? ''} onChange={(e) => setItem(i, { note: e.target.value })} />
          <ListControls index={i} count={s.items.length} noun="chip" onMove={(by) => onChange({ ...s, items: moved(s.items, i, by) })} onRemove={() => onChange({ ...s, items: s.items.filter((_, j) => j !== i) })} />
        </div>
      ))}
      {s.items.length < 16 && (
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...s, items: [...s.items, { label: '' }] })}>
          + Chip
        </Button>
      )}
    </div>
  );
}

/** Choose a card icon from the site's set (or none). */
function IconPicker({ value, onChange }: { value: SiteIconName | null; onChange: (v: SiteIconName | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex size-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-brand-700 dark:border-slate-800 dark:bg-slate-900">
          {value ? <SiteIcon name={value} /> : <span className="text-xs text-slate-400">—</span>}
        </span>
        <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Close icons' : value ? 'Change icon' : 'Choose icon'}
        </Button>
        {value && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            No icon
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-8 gap-1 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900" role="listbox" aria-label="Icons">
          {(Object.keys(SITE_ICONS) as SiteIconName[]).map((name) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={name === value}
              title={name}
              aria-label={name}
              onClick={() => {
                onChange(name);
                setOpen(false);
              }}
              className={`press flex aspect-square items-center justify-center rounded-md ${name === value ? 'bg-brand-50 text-brand-700 dark:bg-slate-800' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
            >
              <SiteIcon name={name} className="size-4" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * After the server switched to a bucket for images: those uploaded before are still in the database
 * and don't show on the site until they are moved (their ids, and so the pages using them, stay the same).
 */
function MoveToBucket({ assets }: { assets: Asset[] | undefined }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const move = useMutation({
    mutationFn: () => api.post<{ moved: number; remaining: number }>('/website/assets/move', {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['website', 'assets'] }),
  });
  const waiting = assets?.filter((a) => a.storage === 'db').length ?? 0;
  if (!appConfig().assetBase || !waiting) return null;
  return (
    <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <span className="flex-1">
        {waiting === 1 ? '1 image is' : `${waiting} images are`} still stored in the database and won't show on the site until moved to image storage.
      </span>
      <Button type="button" size="sm" variant="secondary" disabled={move.isPending} onClick={() => move.mutate()}>
        {move.isPending ? 'Moving…' : 'Move them'}
      </Button>
      {move.error && <ErrorBanner error={move.error} />}
    </div>
  );
}

/** Choose an uploaded image, or upload one (PNG, JPEG, WebP or GIF, up to 5 MB). */
export function ImagePicker({ value, onChange, compact }: { value: string | null; onChange: (id: string | null) => void; compact?: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [browsing, setBrowsing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const assets = useQuery({ queryKey: ['website', 'assets'], queryFn: () => api.get<Asset[]>('/website/assets'), enabled: browsing });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 5 * 1024 * 1024) throw new Error('Images can be up to 5 MB');
      const res = await api.fetch(`/website/assets?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type }, body: file });
      const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
      if (!res.ok) throw new ApiError(res.status, data);
      return data as Asset;
    },
    onSuccess: (a) => {
      void queryClient.invalidateQueries({ queryKey: ['website', 'assets'] });
      setBrowsing(false);
      onChange(a.id);
    },
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {value && <img src={assetUrl(value)} alt="" className={`${compact ? 'h-12' : 'h-20'} rounded-md border border-slate-200 object-cover dark:border-slate-800`} />}
        <Button type="button" size="sm" variant="secondary" disabled={upload.isPending} onClick={() => input.current?.click()}>
          {upload.isPending ? 'Uploading…' : value ? 'Replace image' : 'Upload image'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing}>
          {browsing ? 'Close library' : 'Choose from library'}
        </Button>
        {value && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) upload.mutate(file);
          }}
        />
      </div>
      {upload.error && <ErrorBanner error={upload.error} />}
      {browsing && (
        <div className="rounded-lg border border-slate-200 p-2 dark:border-slate-800">
          <MoveToBucket assets={assets.data} />
          {assets.isLoading ? (
            <Spinner />
          ) : !assets.data?.length ? (
            <p className="p-2 text-xs text-slate-500">No images uploaded yet.</p>
          ) : (
            <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
              {assets.data.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  title={a.filename}
                  onClick={() => {
                    onChange(a.id);
                    setBrowsing(false);
                  }}
                  className={`press overflow-hidden rounded-md border-2 ${a.id === value ? 'border-brand-500' : 'border-transparent hover:border-brand-200'}`}
                >
                  <img src={assetUrl(a.id, a.storage)} alt={a.filename} loading="lazy" className="aspect-square w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
