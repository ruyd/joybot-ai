import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SiteModules } from '../src/components/site/Modules';
import { contrast } from '../src/components/site/Theme';
import { SITE_FONTS } from '../src/lib/site-fonts';
import { SITE_ICONS } from '../src/lib/site-icons';

/** The names the API accepts (website.schemas.ts), read from its source. */
function apiList(name: string): string[] {
  const src = readFileSync(path.resolve(__dirname, '../../api/src/website/website.schemas.ts'), 'utf8');
  const list = new RegExp(`${name} = \\[([\\s\\S]*?)\\]`).exec(src)?.[1] ?? '';
  return [...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

describe('website', () => {
  it('draws every icon and font the API accepts, and no others', () => {
    expect(Object.keys(SITE_ICONS).sort()).toEqual(apiList('SITE_ICONS').sort());
    expect(Object.keys(SITE_FONTS).sort()).toEqual(apiList('SITE_FONTS').sort());
  });

  it('renders hero, cards, faq and cta sections with anchors', () => {
    const { container } = render(
      <MemoryRouter>
        <SiteModules
          modules={[
            { id: 'h', type: 'hero', eyebrow: 'Open source', heading: 'Embrace the AI revolution', heading_accent: 'AI revolution', buttons: [{ label: 'Book a call', url: 'mailto:a@example.com' }, { label: 'Paths', url: '#paths' }] },
            { id: 'c', type: 'cards', anchor: 'paths', variant: 'numbered', columns: 2, heading: 'How it works', items: [{ heading: 'Discover', text: '- one\n- two' }, { heading: 'Build' }] },
            { id: 'f', type: 'faq', heading: 'FAQ', items: [{ question: 'Is it for me?', answer: 'Yes.' }] },
            { id: 'x', type: 'cta', heading: 'Talk to us', buttons: [{ label: 'Contact', url: '/contact' }] },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Embrace the AI revolution');
    expect(container.querySelector('h1 em')?.textContent).toBe('AI revolution');
    expect(screen.getByRole('link', { name: 'Paths' }).getAttribute('href')).toBe('#paths');
    expect(container.querySelector('section#paths')).not.toBeNull();
    expect(screen.getByText('2')).toBeTruthy(); // numbered steps
    expect(container.querySelector('details summary')?.textContent).toContain('Is it for me?');
    expect(screen.getByRole('link', { name: 'Contact' }).getAttribute('href')).toBe('/contact');
  });

  it('measures contrast for the accent color warning', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrast('#0878ab', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast('#a855f7', '#ffffff')).toBeLessThan(4.5);
  });
});
