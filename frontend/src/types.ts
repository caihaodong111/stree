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

export interface PlaceSuggestion {
  value: string;
  keywords?: string[];
  meta?: string;
}

export interface NavigationFormData {
  preferred_districts: string[];
  must_visit_names: string[];
  budget: number | null;
  travel_days: number | null;
  available_hours: number | null;
  preference_mode: "balanced" | "time_first" | "richness_first";
  preferences: PreferenceInput;
}

export interface RecommendationRequest {
  origin_name: string;
  origin_latitude: number;
  origin_longitude: number;
  destination_name: string | null;
  destination_latitude: number | null;
  destination_longitude: number | null;
  must_visit_names: string[];
  budget: number | null;
  available_hours: number | null;
  travel_days: number | null;
  preference_mode: "balanced" | "time_first" | "richness_first";
  preferences: PreferenceInput;
  preferred_districts: string[];
  categories: string[];
  special_interests: string[];
  max_poi_count: number | null;
  max_transit_minutes_per_leg: number | null;
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

export interface StopHighlight {
  poi_name: string;
  reason_title: string;
  reason_body: string;
  tags: string[];
}

export interface RouteOption {
  option_id: string;
  option_label: string;
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
  stop_highlights: StopHighlight[];
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
  request_profile: string;
  route_generation_source: "ai_generated" | "rule_fallback";
  route_generation_note: string | null;
  applied_defaults: string[];
  matched_must_visit_names: string[];
  missing_must_visit_names: string[];
  route_options: RouteOption[];
}

export interface POISuggestionItem {
  name: string;
  district: string;
  category: string;
  tags: string[];
  popularity: number;
  rating: number;
}

export interface POISuggestionCatalogResponse {
  pois: POISuggestionItem[];
  districts: string[];
}

export interface AIPlanningResponse {
  provider: string;
  model: string;
  normalized_request: RecommendationRequest;
  assistant_reply: string;
  status: "ai" | "fallback";
  fallback_used: boolean;
  fallback_reason: string | null;
  parser_notes: string[];
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
  requested_mode: "walking" | "driving" | "transfer" | null;
  summary: string;
  total_duration_minutes: number | null;
  total_distance_meters: number | null;
  total_price: number | null;
  segments: RouteSegment[];
}
