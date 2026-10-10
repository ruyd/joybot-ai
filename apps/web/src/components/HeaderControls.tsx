import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { fullName } from '../lib/format';
import type { Me } from '../lib/me';
import { useTheme } from '../lib/theme';

const iconButton =
  'inline-flex size-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900';

/** Switches between light and dark (the first click leaves "follow the system"). */
export function ThemeToggle() {
  const { resolved, setTheme } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className={iconButton} onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      {resolved === 'dark' ? (
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
        </svg>
      )}
    </button>
  );
}

function initials(me: Me) {
  const p = me.profile;
  const letters = `${p.first_name?.[0] ?? ''}${p.last_name?.[0] ?? ''}`.toUpperCase();
  return letters || '?';
}

const ROLE_LABEL: Record<Me['role'], string> = { admin: 'Admin', staff: 'Staff', org_admin: 'Organization admin', customer: 'Customer' };

/** Avatar with initials; opens a menu with "Profile & preferences" and sign-out. */
export function UserMenu({ me, base }: { me: Me; base: string }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = 'block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800';
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${fullName(me.profile)}`}
        className="flex size-9 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white hover:bg-brand-700"
      >
        {initials(me)}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-40 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <p className="truncate text-sm font-medium">{fullName(me.profile)}</p>
            <p className="truncate text-xs text-slate-500">{[me.profile.email, ROLE_LABEL[me.role]].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="py-1">
            <Link role="menuitem" to={`${base}/profile`} className={item} onClick={() => setOpen(false)}>
              Profile & preferences
            </Link>
          </div>
          <div className="border-t border-slate-200 pt-1 dark:border-slate-800">
            <button role="menuitem" type="button" className={item} onClick={() => void session.signOut()}>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
