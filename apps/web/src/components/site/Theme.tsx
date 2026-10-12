import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../lib/site';
import { fontStack, loadSiteFont, SITE_FONTS } from '../../lib/site-fonts';

/**
 * The site's look from Website › Site setup: its accent colors (class `site-accent`, only when they
 * differ from the app's own) and fonts (loaded on demand). Wraps the public site and the editor's preview.
 */
export function SiteTheme({ settings, className = '', children }: { settings?: Pick<SiteSettings, 'accent' | 'accent_to' | 'heading_font' | 'body_font'> | null; className?: string; children: ReactNode }) {
  const s = settings ?? DEFAULT_SITE_SETTINGS;
  const custom = s.accent !== DEFAULT_SITE_SETTINGS.accent || s.accent_to !== DEFAULT_SITE_SETTINGS.accent_to;
  const heading = fontStack(s.heading_font);
  const body = fontStack(s.body_font);
  useEffect(() => {
    loadSiteFont(s.heading_font);
    loadSiteFont(s.body_font);
  }, [s.heading_font, s.body_font]);
  const style = {
    ...(custom ? { '--site-accent': s.accent, '--site-accent-2': s.accent_to } : {}),
    ...(heading ? { '--site-font-heading': heading, '--site-heading-weight': SITE_FONTS[s.heading_font]?.headingWeight ?? 600 } : {}),
    ...(body ? { '--site-font-body': body } : {}),
  } as CSSProperties;
  return (
    <div className={`site-theme ${custom ? 'site-accent' : ''} ${className}`} style={style} data-heading-font={heading ? s.heading_font : undefined} data-body-font={body ? s.body_font : undefined}>
      {children}
    </div>
  );
}

/** WCAG contrast ratio between two #rrggbb colors. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
