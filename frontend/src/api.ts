import {
  TripSchema,
  type JobEvent,
  type PlanRequest,
  type Region,
  type ServiceStatus,
  type Trip,
  type TripSummary,
} from '@stree/shared';
const base = import.meta.env.VITE_API_BASE || '/api';
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${url}`, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? '服务暂时不可用，请稍后重试。');
  return data as T;
}
export const api = {
  status: () => request<ServiceStatus>('/status'),
  provinces: () => request<{ regions: Region[] }>('/regions/provinces'),
  cities: (provinceCode: string, signal?: AbortSignal) =>
    request<{ regions: Region[] }>(`/regions/cities?provinceCode=${provinceCode}`, { signal }),
  history: () => request<{ trips: TripSummary[] }>('/trips'),
  trip: async (id: string): Promise<Trip> => TripSchema.parse(await request(`/trips/${id}`)),
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
