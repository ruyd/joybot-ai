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
            { id: 'h', type: 'hero', badge: 'Open source', eyebrow: 'Meet JoyBot AI', heading: 'Embrace the AI revolution', heading_accent: 'AI revolution', buttons: [{ label: 'Book a call', url: 'mailto:a@example.com' }, { label: 'Paths', url: '#paths' }] },
            { id: 'c', type: 'cards', anchor: 'paths', variant: 'numbered', columns: 2, heading: 'From idea to owned platform', heading_accent: 'owned platform', items: [{ heading: 'Discover', text: '- one\n- two' }, { heading: 'Build' }] },
            { id: 'f', type: 'faq', heading: 'Questions, answered', heading_accent: 'not there', items: [{ question: 'Is it for me?', answer: 'Yes.' }] },
            { id: 'x', type: 'cta', heading: 'Talk to us', buttons: [{ label: 'Contact', url: '/contact' }] },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Embrace the AI revolution');
    expect(container.querySelector('h1 em')?.textContent).toBe('AI revolution');
    expect(container.querySelector('section.site-hero p span')?.textContent).toBe('Open source'); // the badge, inside the label line
    expect(container.querySelector('section.site-hero p')?.textContent).toBe('Open sourceMeet JoyBot AI');
    expect(screen.getByRole('link', { name: 'Paths' }).getAttribute('href')).toBe('#paths');
    expect(container.querySelector('section#paths')).not.toBeNull();
    expect(container.querySelector('section#paths h2')?.innerHTML).toBe('From idea to <em class="site-accent-text italic">owned platform</em>');
    expect(screen.getByRole('heading', { name: 'Questions, answered' }).querySelector('em')).toBeNull(); // highlight not in the heading
    expect(screen.getByText('2')).toBeTruthy(); // numbered steps
    expect(container.querySelector('details summary')?.textContent).toContain('Is it for me?');
    expect(screen.getByRole('link', { name: 'Contact' }).getAttribute('href')).toBe('/contact');
  });

  it('puts card icons beside the text when asked, above it by default', () => {
    const cards = (icon_position?: 'top' | 'side') => (
      <MemoryRouter>
        <SiteModules modules={[{ id: 'c', type: 'cards', variant: 'cards', columns: 2, icon_position, items: [{ icon: 'store', heading: 'Already run a business?', text: 'Text' }, { icon: 'rocket', heading: 'Starting one?' }] }]} />
      </MemoryRouter>
    );
    const side = render(cards('side'));
    const heading = side.getByRole('heading', { name: 'Already run a business?' });
    expect(heading.parentElement?.previousElementSibling?.querySelector('svg')).not.toBeNull(); // icon, then a column with the text
    side.unmount();
    const top = render(cards());
    expect(top.getByRole('heading', { name: 'Already run a business?' }).previousElementSibling?.querySelector('svg')).not.toBeNull(); // icon block right above the heading
  });

  it('draws large cards with arrows, a divider and button links; highlighted ones in the highlight color', () => {
    const { container, getByRole } = render(
      <MemoryRouter>
        <SiteModules
          modules={[
            {
              id: 'paths',
              type: 'cards',
              variant: 'large',
              columns: 2,
              align: 'left',
              heading: 'Build your own, or quickstart with ours',
              items: [
                { eyebrow: 'Path 1', heading: 'Your own versions', text: '- Tailored\n\n---\n\n**Best for:** established businesses', link_label: 'Plan my custom build', link_url: '/contact' },
                { eyebrow: 'Path 2', heading: 'JoyBot AI', highlight: true, text: '- Out of the box', link_label: 'Explore JoyBot AI', link_url: '#joybot' },
              ],
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('header')?.className).not.toContain('text-center'); // left-aligned heading
    const cards = container.querySelectorAll('.site-arrows');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('hr')).not.toBeNull();
    expect(getByRole('heading', { name: 'Your own versions' }).className).toContain('site-heading');
    expect(getByRole('link', { name: 'Plan my custom build →' }).className).toContain('btn-gradient');
    expect(getByRole('link', { name: 'Explore JoyBot AI →' }).className).toContain('site-hl-button');
    expect(container.querySelectorAll('.site-hl')).toHaveLength(1);
  });

  it('draws before and after: chips with notes, an arrow, and the after side in the highlight color', () => {
    const { container, getByText } = render(
      <MemoryRouter>
        <SiteModules
          modules={[
            {
              id: 'vision',
              type: 'compare',
              background: 'dark',
              heading: 'Rent less. Own more.',
              heading_accent: 'Own more.',
              before: { label: 'Today: rented & scattered', items: [{ label: 'CRM', note: 'per seat' }, { label: 'Help desk', note: 'per agent' }] },
              after: { label: 'With Acme', core: 'Your core business app + AI', items: [{ label: 'Customers' }] },
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('section')?.className).toContain('site-band-dark');
    expect(getByText('per seat').tagName).toBe('SMALL');
    expect(container.querySelector('.site-compare-after .site-compare-core')?.textContent).toBe('Your core business app + AI');
    expect(container.querySelectorAll('.site-compare-chip')).toHaveLength(1);
    expect(getByText('→')).toBeTruthy();
  });

  it('puts a section’s buttons beside a left-aligned heading, with a badge label and per-button styles', () => {
    const { container, getByRole, getByText } = render(
      <MemoryRouter>
        <SiteModules
          modules={[
            {
              id: 'joybot',
              type: 'cards',
              variant: 'cards',
              columns: 4,
              align: 'left',
              eyebrow: '★ Open source',
              eyebrow_style: 'badge',
              heading: 'Quickstart with JoyBot AI',
              icon_color: 'highlight',
              buttons_position: 'header',
              buttons: [
                { label: 'View on GitHub', url: 'https://github.com/ruyd/joybot-ai', style: 'secondary' },
                { label: 'Get JoyBot', url: '/contact', style: 'highlight' },
              ],
              items: [{ icon: 'bot', heading: 'AI assistant', text: 'Answers.' }],
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(getByText('★ Open source').className).toContain('site-badge');
    const github = getByRole('link', { name: 'View on GitHub' });
    expect(github.className).toContain('btn-outline-gradient');
    expect(getByRole('link', { name: 'Get JoyBot' }).className).toContain('site-hl-button');
    expect(github.closest('header')).toBeNull(); // beside the header, not under the cards…
    expect(github.parentElement?.parentElement?.parentElement?.querySelector('header')).not.toBeNull();
    expect(container.querySelector('.site-icon-hl')).not.toBeNull();
    expect(getByRole('heading', { name: 'AI assistant' }).className).toContain('text-[17px]'); // rows of four: smaller
  });

  it('draws a call to action on the accent color as a rounded card, and on other backgrounds as a band', () => {
    const cta = (background?: 'accent' | 'dark') => (
      <MemoryRouter>
        <SiteModules modules={[{ id: 'cta', type: 'cta', background, heading: 'Your business, your software', buttons: [{ label: 'Talk to us', url: '/contact' }] }]} />
      </MemoryRouter>
    );
    const card = render(cta());
    expect(card.container.querySelector('.site-cta-card h2')?.textContent).toBe('Your business, your software');
    expect(card.container.querySelector('section')?.className).not.toContain('linear-gradient'); // the page shows around the card
    expect(card.container.querySelector('.site-cta-card a')?.className).toContain('text-slate-900');
    card.unmount();
    const band = render(cta('dark'));
    expect(band.container.querySelector('.site-cta-card')).toBeNull();
    expect(band.container.querySelector('section')?.className).toContain('site-band-dark');
  });

  it('measures contrast for the accent color warning', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrast('#0878ab', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast('#a855f7', '#ffffff')).toBeLessThan(4.5);
  });
});
