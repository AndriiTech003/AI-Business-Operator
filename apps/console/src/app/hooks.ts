import { useEffect, useState, useSyncExternalStore } from 'react';
import { parseRoute, splitHash, type Route } from '../lib/route';
import { liveRuns, type LiveEntry } from '../lib/live';

function subscribeHash(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

function currentHash(): string {
  return window.location.hash;
}

export function useHash(): string {
  return useSyncExternalStore(subscribeHash, currentHash, () => '');
}

export function useRoute(): Route {
  return parseRoute(useHash());
}

export function useHashQuery(): Record<string, string> {
  return splitHash(useHash()).query;
}

export function useLiveRun(runId: string | null): LiveEntry | undefined {
  return useSyncExternalStore(
    liveRuns.subscribe,
    () => (runId === null ? undefined : liveRuns.get(runId)),
    () => undefined,
  );
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
