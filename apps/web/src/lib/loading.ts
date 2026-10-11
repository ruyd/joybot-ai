import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';

// Pages loading their code (lazy routes): counted while a Suspense fallback is on screen.
let pending = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Marks the app busy while mounted (put it in a Suspense fallback). */
export function LoadingMark() {
  useEffect(() => {
    pending += 1;
    emit();
    return () => {
      pending -= 1;
      emit();
    };
  }, []);
  return null;
}

/**
 * True while the user is waiting: a page's code loading, data a screen does not have yet (first
 * loads, a new page of results), or a save. Background polling and refetches of data already on
 * screen do not count. Shown after a short delay (no flash for quick loads) and kept briefly so the
 * animation does not flicker.
 */
export function useBusy(): boolean {
  const routes = useSyncExternalStore(subscribe, () => pending);
  const fetching = useIsFetching({ predicate: (q) => q.state.data === undefined });
  const mutating = useIsMutating();
  const busy = routes + fetching + mutating > 0;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(busy), busy ? 120 : 450);
    return () => clearTimeout(t);
  }, [busy]);
  return shown;
}
