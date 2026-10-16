import {
  TripSchema,
  DirectionsResponseSchema,
  LocatedRegionSchema,
  type Coordinate,
  type TravelMode,
  type JobEvent,
  type PlanRequest,
  type Region,
  type ServiceStatus,
  type Trip,
  type TripSummary,
  type ModelSettings,
  type ModelSettingsResponse,
  type ProviderInput,
  type ProviderProbe,
  type ProviderSummary,
  type ProviderModel,
  type PlaceSuggestion,
  type TravelHistory,
} from '@stree/shared';
const base = import.meta.env.VITE_API_BASE || '/api';
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const isUnavailableEndpoint = (error: unknown) =>
  error instanceof ApiError && [404, 405, 410, 501].includes(error.status);
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${url}`, options);
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(data?.error ?? '服务暂时不可用，请稍后重试。', response.status);
  return data as T;
}
export const api = {
  status: () => request<ServiceStatus>('/status'),
  modelSettings: () => request<ModelSettingsResponse>('/settings/model'),
  saveProvider: (input: ProviderInput, editing: boolean) =>
    request<{ providers: ProviderSummary[] }>(
      `/settings/providers${editing ? `/${encodeURIComponent(input.id)}` : ''}`,
      {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),
  deleteProvider: (id: string) =>
    request<{ providers: ProviderSummary[] }>(`/settings/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  discoverModels: (input: ProviderProbe) =>
    request<{ models: ProviderModel[] }>('/settings/providers/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  saveModelSettings: (input: ModelSettings) =>
    request<ModelSettingsResponse>('/settings/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  provinces: () => request<{ regions: Region[] }>('/regions/provinces'),
  locate: async (position: Coordinate, signal?: AbortSignal) =>
    LocatedRegionSchema.parse(
      await request('/regions/locate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(position),
        signal,
      }),
    ),
  cities: (provinceCode: string, signal?: AbortSignal) =>
    request<{ regions: Region[] }>(`/regions/cities?provinceCode=${provinceCode}`, { signal }),
  locateCity: async (adcode: string, signal?: AbortSignal) =>
    LocatedRegionSchema.parse(
      await request('/regions/locate-city', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adcode }),
        signal,
      }),
    ),
  popularPlaces: (cityCode: string) =>
    request<{ places: PlaceSuggestion[] }>(`/places/popular?${new URLSearchParams({ cityCode })}`),
  suggestPlaces: (cityCode: string | undefined, keyword: string, signal?: AbortSignal) =>
    request<{ places: PlaceSuggestion[] }>(
      `/places/suggest?${new URLSearchParams({ ...(cityCode ? { cityCode } : {}), keyword })}`,
      { signal },
    ),
  history: () => request<{ trips: TripSummary[] }>('/trips'),
  travelHistory: () => request<TravelHistory>('/history'),
  trip: async (id: string): Promise<Trip> => TripSchema.parse(await request(`/trips/${id}`)),
  directions: async (
    id: string,
    routeId: string,
    dayIndex: number,
    segmentIndex: number,
    mode: TravelMode,
    signal?: AbortSignal,
    refresh = false,
  ) =>
    DirectionsResponseSchema.parse(
      await request(
        `/trips/${id}/directions?${new URLSearchParams({
          routeId,
          dayIndex: String(dayIndex),
          segmentIndex: String(segmentIndex),
          mode,
          ...(refresh ? { refresh: 'true' } : {}),
        })}`,
        { signal },
      ),
    ),
  plan: (input: PlanRequest & { previousTripId?: string }) =>
    request<{ jobId: string }>('/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  cancel: (id: string) => request(`/jobs/${id}/cancel`, { method: 'POST' }),
  events: (id: string, onEvent: (event: JobEvent) => void, onError: () => void) => {
    const stream = new EventSource(`${base}/jobs/${id}/events`);
    stream.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as JobEvent;
        onEvent(event);
        if (event.type !== 'progress') stream.close();
      } catch {
        stream.close();
        onError();
      }
    };
    stream.onerror = () => {
      stream.close();
      onError();
    };
    return stream;
  },
  job: (id: string) => request<{ status: string; events: JobEvent[] }>(`/jobs/${id}`),
};
