import type {
  AIPlanningResponse,
  MapRouteResponse,
  POISuggestionCatalogResponse,
  RecommendationRequest,
  RecommendationResponse,
  RouteOption
} from "../types";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

export async function getRecommendations(
  payload: RecommendationRequest
): Promise<RecommendationResponse> {
  const response = await fetch(`${API_BASE}/recommendations/routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "推荐接口调用失败");
  }

  return response.json();
}

export async function getPoiSuggestions(): Promise<POISuggestionCatalogResponse> {
  const response = await fetch(`${API_BASE}/pois/suggestions`);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "景点候选接口调用失败");
  }

  return response.json();
}

export async function planByAI(userMessage: string): Promise<AIPlanningResponse> {
  const response = await fetch(`${API_BASE}/ai/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_message: userMessage })
  });

  if (!response.ok) {
    throw new Error("AI 规划接口调用失败");
  }

  return response.json();
}

export async function planByAIWithDraft(payload: {
  user_message: string;
  draft_request: RecommendationRequest;
}): Promise<AIPlanningResponse> {
  const response = await fetch(`${API_BASE}/ai/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("AI 规划接口调用失败");
  }

  return response.json();
}

export async function planMapRoute(payload: {
  mode: "walking" | "driving" | "transfer";
  origin_name: string;
  origin_longitude: number;
  origin_latitude: number;
  route: RouteOption;
}): Promise<MapRouteResponse> {
  const response = await fetch(`${API_BASE}/maps/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: payload.mode,
      origin_name: payload.origin_name,
      origin_longitude: payload.origin_longitude,
      origin_latitude: payload.origin_latitude,
      stops: payload.route.pois.map((poi) => ({
        name: poi.name,
        longitude: poi.longitude,
        latitude: poi.latitude
      }))
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "地图路径规划失败");
  }

  return response.json();
}

export async function planDirectRoute(payload: {
  mode: "walking" | "driving" | "transfer";
  origin_name: string;
  origin_longitude: number;
  origin_latitude: number;
  destination_name: string;
  destination_longitude: number;
  destination_latitude: number;
}): Promise<MapRouteResponse> {
  const response = await fetch(`${API_BASE}/maps/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: payload.mode,
      origin_name: payload.origin_name,
      origin_longitude: payload.origin_longitude,
      origin_latitude: payload.origin_latitude,
      stops: [
        {
          name: payload.destination_name,
          longitude: payload.destination_longitude,
          latitude: payload.destination_latitude
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "地图路径规划失败");
  }

  return response.json();
}

export async function planStopsRoute(payload: {
  mode: "walking" | "driving" | "transfer";
  origin_name: string;
  origin_longitude: number;
  origin_latitude: number;
  stops: Array<{
    name: string;
    longitude: number;
    latitude: number;
  }>;
}): Promise<MapRouteResponse> {
  const response = await fetch(`${API_BASE}/maps/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "地图路径规划失败");
  }

  return response.json();
}
