import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { BrandMark } from '../../components/BrandMark';
import { SiteModules } from '../../components/site/Modules';
import { contrast, SiteTheme } from '../../components/site/Theme';
import { Button, Card, ErrorBanner, Field, Input, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useMe } from '../../lib/me';
import { assetUrl, DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../lib/site';
import { SITE_FONTS, type SiteFontName } from '../../lib/site-fonts';
import { IconButton, ImagePicker, ListControls, moved } from './WebsiteEditors';

interface SettingsDoc extends SiteSettings {
  /** From the business settings: the site's name when it has none of its own. */
  business_name: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

const PRESETS: { name: string; accent: string; accent_to: string }[] = [
  { name: 'Blue and teal', accent: DEFAULT_SITE_SETTINGS.accent, accent_to: DEFAULT_SITE_SETTINGS.accent_to },
  { name: 'Purple', accent: '#6246ea', accent_to: '#9333ea' },
  { name: 'Green', accent: '#047857', accent_to: '#0f766e' },
  { name: 'Orange', accent: '#c2410c', accent_to: '#e11d48' },
  { name: 'Rose', accent: '#be123c', accent_to: '#9333ea' },
  { name: 'Slate', accent: '#334155', accent_to: '#0f766e' },
];

const fields = (s: SettingsDoc): SiteSettings => ({
  site_name: s.site_name,
  tagline: s.tagline,
  logo_asset_id: s.logo_asset_id,
  accent: s.accent,
  accent_to: s.accent_to,
  highlight_color: s.highlight_color,
  heading_font: s.heading_font,
  body_font: s.body_font,
  header_links: s.header_links,
  header_button_label: s.header_button_label,
  header_button_url: s.header_button_url,
  show_customer_login: s.show_customer_login,
});

export const useSiteSettings = () => {
  const api = useApi();
  return useQuery({ queryKey: ['website', 'settings'], queryFn: () => api.get<SettingsDoc>('/website/settings') });
};

/** Marketing › Website › Site setup: the site's colors, fonts, logo and header. */
export function SiteSetup({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const settings = useSiteSettings();
  const [draft, setDraft] = useState<SiteSettings | null>(null);
  const saved = settings.data ? fields(settings.data) : null;
  const form = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const save = useMutation({
    mutationFn: (body: SiteSettings) => api.put<SettingsDoc>('/website/settings', body),
    onSuccess: (s) => {
      queryClient.setQueryData(['website', 'settings'], s);
      void queryClient.invalidateQueries({ queryKey: ['site'] });
      setDraft(null);
    },
  });

  if (settings.isLoading) return <Spinner />;
  if (settings.error || !form || !settings.data) return <ErrorBanner error={settings.error} />;
  const editable = can('update', 'website');
  const set = (patch: Partial<SiteSettings>) => setDraft({ ...form, ...patch });
  const setLink = (i: number, patch: Partial<SiteSettings['header_links'][number]>) => set({ header_links: form.header_links.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...form, site_name: form.site_name?.trim() || null, tagline: form.tagline?.trim() || null, header_button_label: form.header_button_label?.trim() || null, header_button_url: form.header_button_url?.trim() || null });
  };
  const readable = contrast(form.accent, '#ffffff');

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={!editable} className="space-y-4">
        <Card title="Colors and fonts">
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">Color scheme</p>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => {
                  const on = p.accent === form.accent && p.accent_to === form.accent_to;
                  return (
                    <button
                      key={p.name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ accent: p.accent, accent_to: p.accent_to })}
                      className={`press flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${on ? 'border-slate-900 dark:border-white' : 'border-slate-200 dark:border-slate-700'}`}
                    >
                      <span className="size-4 rounded-full" style={{ backgroundImage: `linear-gradient(90deg, ${p.accent}, ${p.accent_to})` }} aria-hidden="true" />
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ColorField label="Accent color" hint={readable < 4.5 ? `White text on it is hard to read (${readable.toFixed(1)}:1; aim for 4.5:1). Try a darker shade.` : 'Links, buttons and highlights.'} value={form.accent} onChange={(accent) => set({ accent })} />
              <ColorField label="Gradient to" hint="Buttons and the accent background fade from the accent to this." value={form.accent_to} onChange={(accent_to) => set({ accent_to })} />
              <div className="sm:col-span-2">
                <ColorField
                  label="Highlight color"
                  hint="A second brand color for highlighted cards and the hero glow. Off: the gradient color."
                  value={form.highlight_color ?? form.accent_to}
                  onChange={(highlight_color) => set({ highlight_color })}
                  onClear={form.highlight_color ? () => set({ highlight_color: null }) : undefined}
                />
              </div>
              <FontField label="Heading font" value={form.heading_font} onChange={(heading_font) => set({ heading_font })} />
              <FontField label="Body font" value={form.body_font} onChange={(body_font) => set({ body_font })} body />
            </div>
          </div>
        </Card>

        <Card title="Header">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Site name" hint={`In the header, the footer and page titles. Leave blank to use the business name${settings.data.business_name ? ` (${settings.data.business_name})` : ''}.`}>
                <Input maxLength={80} placeholder={settings.data.business_name ?? ''} value={form.site_name ?? ''} onChange={(e) => set({ site_name: e.target.value })} />
              </Field>
              <Field label="Tagline" hint="Under the name, e.g. Software Development">
                <Input maxLength={60} value={form.tagline ?? ''} onChange={(e) => set({ tagline: e.target.value })} />
              </Field>
              <div className="text-sm">
                <p className="mb-1 font-medium">Logo</p>
                <ImagePicker compact value={form.logo_asset_id} onChange={(logo_asset_id) => set({ logo_asset_id })} />
                <p className="mt-1 text-xs text-slate-500">A square image works best. Without one, the JoyBot mark is shown.</p>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Links</p>
              <p className="text-xs text-slate-500">After the pages shown in the header. Use /#services for a section of the home page (its anchor), /about for a page, or a full https:// address.</p>
              {form.header_links.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input placeholder="Label" maxLength={40} value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />
                  <Input placeholder="/#services" maxLength={500} value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} />
                  <ListControls index={i} count={form.header_links.length} noun="link" onMove={(by) => set({ header_links: moved(form.header_links, i, by) })} onRemove={() => set({ header_links: form.header_links.filter((_, j) => j !== i) })} />
                </div>
              ))}
              {form.header_links.length < 8 && (
                <Button type="button" size="sm" variant="secondary" onClick={() => set({ header_links: [...form.header_links, { label: '', url: '' }] })}>
                  + Link
                </Button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Button label" hint="Optional, e.g. Let's talk">
                <Input maxLength={40} value={form.header_button_label ?? ''} onChange={(e) => set({ header_button_label: e.target.value })} />
              </Field>
              <Field label="Button link" hint="mailto:, /contact, #section or https://…">
                <span className="flex items-center gap-1">
                  <Input maxLength={500} value={form.header_button_url ?? ''} onChange={(e) => set({ header_button_url: e.target.value })} />
                  {(form.header_button_label || form.header_button_url) && (
                    <IconButton label="Remove button" onClick={() => set({ header_button_label: null, header_button_url: null })}>
                      ✕
                    </IconButton>
                  )}
                </span>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="switch" checked={form.show_customer_login} onChange={(e) => set({ show_customer_login: e.target.checked })} />
              Show “Customer login” in the header
            </label>
          </div>
        </Card>
      </fieldset>

      <Card title="Preview">
        <div className="-m-4 overflow-hidden rounded-b-xl">
          <SiteTheme settings={form} className="bg-white dark:bg-slate-950">
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              {form.logo_asset_id ? <img src={assetUrl(form.logo_asset_id)} alt="" className="size-7 rounded-md object-contain" /> : <BrandMark className="size-7" />}
              <span className="flex flex-col leading-tight">
                <span className="font-semibold">{form.site_name?.trim() || settings.data.business_name || 'Your business'}</span>
                {form.tagline && <span className="text-xs text-slate-500">{form.tagline}</span>}
              </span>
              <span className="ml-auto hidden gap-3 text-sm text-slate-600 sm:flex dark:text-slate-300">
                {form.header_links.slice(0, 4).map((l, i) => (
                  <span key={i}>{l.label || 'Link'}</span>
                ))}
              </span>
              {form.header_button_label && <span className="btn-gradient rounded-full px-3 py-1.5 text-xs font-semibold">{form.header_button_label}</span>}
            </div>
            <SiteModules
              modules={[
                { id: 'p-hero', type: 'hero', eyebrow: 'A short label', heading: 'A headline with highlighted words', heading_accent: 'highlighted words', text: 'Body text in the body font, with a [link](#).', buttons: [{ label: 'Primary', url: '#' }, { label: 'Secondary', url: '#' }] },
                { id: 'p-cards', type: 'cards', background: 'alt', variant: 'cards', columns: 3, eyebrow: 'Section label', heading: 'A section heading', heading_accent: 'heading', items: [{ icon: 'sparkles', heading: 'A card', text: '- With a point\n- And another' }, { icon: 'star', highlight: true, heading: 'A highlighted card', text: '- In the highlight color' }, { icon: 'calendar', heading: 'Another card', text: 'Short text.' }] },
                { id: 'p-cta', type: 'cta', heading: 'A call to action', heading_accent: 'action', buttons: [{ label: 'Get started', url: '#' }] },
              ]}
            />
          </SiteTheme>
        </div>
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
            {dirty ? 'Unsaved changes' : `Saved ${dateTime(settings.data.updated_at)}${settings.data.updated_by_name ? ` by ${settings.data.updated_by_name}` : ''}`}
          </span>
          <div className="basis-full empty:hidden">{save.error ? <ErrorBanner error={save.error} /> : null}</div>
        </div>
      )}
    </form>
  );
}

function ColorField({ label, hint, value, onChange, onClear }: { label: string; hint: string; value: string; onChange: (v: string) => void; onClear?: () => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Field label={label} hint={hint}>
      <span className="flex items-center gap-2">
        <input type="color" aria-label={`${label} picker`} className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900" value={value} onChange={(e) => onChange(e.target.value)} />
        <Input
          className="w-32 font-mono"
          maxLength={7}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
        />
        {onClear && (
          <Button type="button" size="sm" variant="ghost" onClick={onClear}>
            Use the gradient color
          </Button>
        )}
      </span>
    </Field>
  );
}

function FontField({ label, value, onChange, body }: { label: string; value: SiteFontName; onChange: (v: SiteFontName) => void; body?: boolean }) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value as SiteFontName)}>
        {(Object.keys(SITE_FONTS) as SiteFontName[])
          .filter((name) => !body || name !== 'instrument-serif' || name === value)
          .map((name) => (
            <option key={name} value={name}>
              {SITE_FONTS[name].label} · {SITE_FONTS[name].kind}
            </option>
          ))}
      </Select>
    </Field>
  );
}
