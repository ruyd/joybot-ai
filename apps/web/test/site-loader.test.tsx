import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberBrand, SiteLoader, SiteUnavailable } from '../src/components/site/SiteLoader';

/** A fresh in-memory localStorage (Node's own global can shadow jsdom's). */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SiteLoader', () => {
  it('says the site is waking up after a few seconds, and that it can take a minute after more', () => {
    render(<SiteLoader />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByText(/waking up/)).toBeNull();
    act(() => void vi.advanceTimersByTime(5_000));
    expect(screen.getByText(/the site is waking up/)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(11_000));
    expect(screen.getByText(/up to a minute/)).toBeInTheDocument();
  });

  it("shows the site's name and logo from the last visit, and a dot if the logo can't load", () => {
    rememberBrand({ name: 'appjoy', logo: 'https://cdn.example.com/site/logo', accent: '#5b3df5' });
    const { container } = render(<SiteLoader />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading appjoy…');
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/site/logo');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
  });

  it('ignores a broken remembered value', () => {
    localStorage.setItem('joybot.site.brand', '{"name":1,"accent":"red"}');
    render(<SiteLoader />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});

describe('SiteUnavailable', () => {
  it('offers to try again', () => {
    const retry = vi.fn();
    render(<SiteUnavailable onRetry={retry} retrying={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });
});
