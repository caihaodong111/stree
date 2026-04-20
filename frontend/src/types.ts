export interface PreferenceInput {
  mode: "balanced" | "time_first" | "richness_first";
  favor_low_budget: boolean;
  favor_photography: boolean;
  avoid_crowds: boolean;
}

export interface LocationPoint {
  name: string;
  latitude: number;
  longitude: number;
}

export interface NavigationFormData {
  origin_query: string;
  destination_query: string;
  budget: number;
  available_hours: number;
  preference_mode: "balanced" | "time_first" | "richness_first";
  preferences: PreferenceInput;
  max_poi_count: number;
}

export interface RecommendationRequest {
  origin_name: string;
  origin_latitude: number;
  origin_longitude: number;
  destination_name: string | null;
  destination_latitude: number | null;
  destination_longitude: number | null;
  budget: number;
  available_hours: number;
  travel_days: number;
  preference_mode: "balanced" | "time_first" | "richness_first";
  preferences: PreferenceInput;
  preferred_districts: string[];
  categories: string[];
  special_interests: string[];
  max_poi_count: number;
  max_transit_minutes_per_leg: number;
}

export interface POIOut {
  id: number;
  name: string;
  district: string;
  category: string;
  latitude: number;
  longitude: number;
  ticket_price: number;
  suggested_visit_hours: number;
  rating: number;
  tags: string[];
  description: string;
}

export interface RouteOption {
  title: string;
  strategy: string;
  route_style: string;
  score: number;
  total_budget: number;
  total_duration_hours: number;
  total_travel_km: number;
  highlight_reason: string;
  pois: POIOut[];
  itinerary: ItineraryItem[];
}

export interface ItineraryItem {
  day_index: number;
  start_time: string;
  end_time: string;
  poi_name: string;
  stay_hours: number;
  transit_minutes_from_previous: number;
}

export interface RecommendationResponse {
  city: string;
  origin_name: string;
  recommendation_summary: string;
  route_options: RouteOption[];
}

export interface AIPlanningResponse {
  provider: string;
  model: string;
  normalized_request: RecommendationRequest;
  assistant_reply: string;
}

export interface RouteStop {
  name: string;
  longitude: number;
  latitude: number;
}

export interface CoordinatePoint {
  longitude: number;
  latitude: number;
}

export interface RouteSegment {
  from_name: string;
  to_name: string;
  mode: "walking" | "driving" | "transfer";
  summary: string;
  duration_minutes: number | null;
  distance_meters: number | null;
  price: number | null;
  polyline: CoordinatePoint[];
}

export interface MapRouteResponse {
  mode: "walking" | "driving" | "transfer";
  summary: string;
  total_duration_minutes: number | null;
  total_distance_meters: number | null;
  total_price: number | null;
  segments: RouteSegment[];
}
