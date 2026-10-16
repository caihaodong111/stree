import type { PlaceSuggestion } from '@stree/shared';
import { api } from '../api';

const cache = new Map<string, { until: number; places: PlaceSuggestion[] }>();
const pending = new Map<string, Promise<PlaceSuggestion[]>>();

export function cachedPopularPlaces(cityCode: string): PlaceSuggestion[] | undefined {
  const entry = cache.get(cityCode);
  return entry && entry.until > Date.now() ? entry.places : undefined;
}

export function loadPopularPlaces(cityCode: string): Promise<PlaceSuggestion[]> {
  const cached = cachedPopularPlaces(cityCode);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(cityCode);
  if (existing) return existing;
  // Prefetch and focus share a request; closing the menu must not cancel the cache fill.
  const task = api
    .popularPlaces(cityCode)
    .then(({ places }) => {
      cache.set(cityCode, { places, until: Date.now() + 10 * 60 * 1000 });
      if (cache.size > 30) cache.delete(cache.keys().next().value!);
      return places;
    })
    .finally(() => pending.delete(cityCode));
  pending.set(cityCode, task);
  return task;
}
