/**
 * Fonts the public site can use (Website › Site setup), bundled with the app so visitors never load
 * anything from a third party. The names match the API's SITE_FONTS. Each font's files load only when
 * a site uses it.
 */
export const SITE_FONTS = {
  system: { label: 'System default', family: null, kind: 'Sans serif', headingWeight: null, load: null },
  inter: { label: 'Inter', family: "'Inter Variable'", kind: 'Sans serif', headingWeight: 650, load: () => Promise.all([import('@fontsource-variable/inter/wght.css')]) },
  'dm-sans': { label: 'DM Sans', family: "'DM Sans Variable'", kind: 'Sans serif', headingWeight: 650, load: () => Promise.all([import('@fontsource-variable/dm-sans/wght.css'), import('@fontsource-variable/dm-sans/wght-italic.css')]) },
  manrope: { label: 'Manrope', family: "'Manrope Variable'", kind: 'Sans serif', headingWeight: 700, load: () => Promise.all([import('@fontsource-variable/manrope/wght.css')]) },
  'space-grotesk': { label: 'Space Grotesk', family: "'Space Grotesk Variable'", kind: 'Sans serif', headingWeight: 600, load: () => Promise.all([import('@fontsource-variable/space-grotesk/wght.css')]) },
  'instrument-serif': { label: 'Instrument Serif', family: "'Instrument Serif'", kind: 'Serif (display, headings only)', headingWeight: 400, load: () => Promise.all([import('@fontsource/instrument-serif/400.css'), import('@fontsource/instrument-serif/400-italic.css')]) },
  'playfair-display': { label: 'Playfair Display', family: "'Playfair Display Variable'", kind: 'Serif', headingWeight: 600, load: () => Promise.all([import('@fontsource-variable/playfair-display/wght.css'), import('@fontsource-variable/playfair-display/wght-italic.css')]) },
  fraunces: { label: 'Fraunces', family: "'Fraunces Variable'", kind: 'Serif', headingWeight: 600, load: () => Promise.all([import('@fontsource-variable/fraunces/wght.css'), import('@fontsource-variable/fraunces/wght-italic.css')]) },
  lora: { label: 'Lora', family: "'Lora Variable'", kind: 'Serif', headingWeight: 600, load: () => Promise.all([import('@fontsource-variable/lora/wght.css'), import('@fontsource-variable/lora/wght-italic.css')]) },
} as const satisfies Record<string, { label: string; family: string | null; kind: string; headingWeight: number | null; load: (() => Promise<unknown>) | null }>;

export type SiteFontName = keyof typeof SITE_FONTS;

const loaded = new Set<SiteFontName>();

/** Loads a font's files once (a no-op for the system font or an unknown name). */
export function loadSiteFont(name: string): void {
  const font = SITE_FONTS[name as SiteFontName];
  if (!font?.load || loaded.has(name as SiteFontName)) return;
  loaded.add(name as SiteFontName);
  void font.load().catch(() => loaded.delete(name as SiteFontName));
}

/** The CSS font stack for a font name, falling back to the app's own. */
export function fontStack(name: string, serif = false): string | undefined {
  const family = SITE_FONTS[name as SiteFontName]?.family;
  if (!family) return undefined;
  const kind = SITE_FONTS[name as SiteFontName].kind.startsWith('Serif') || serif ? 'ui-serif, Georgia, serif' : 'ui-sans-serif, system-ui, sans-serif';
  return `${family}, ${kind}`;
}
