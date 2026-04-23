from pydantic import BaseModel, Field


class PreferenceWeights(BaseModel):
    time_efficiency: float = 25
    richness: float = 25
    geo_compactness: float = 20
    budget_fit: float = 15
    preference_match: float = 15

    @classmethod
    def from_user_preferences(cls, preferences: "PreferenceInput") -> "PreferenceWeights":
        if preferences.mode == "time_first":
            return cls(time_efficiency=35, richness=15, geo_compactness=25, budget_fit=15, preference_match=10)
        if preferences.mode == "richness_first":
            return cls(time_efficiency=15, richness=35, geo_compactness=15, budget_fit=10, preference_match=25)
        return cls()


class PreferenceInput(BaseModel):
    mode: str = Field(default="balanced", description="balanced | time_first | richness_first")
    favor_low_budget: bool = False
    favor_photography: bool = False
    avoid_crowds: bool = False


class RecommendationRequest(BaseModel):
    origin_name: str = Field(default="天安门东")
    origin_latitude: float = Field(default=39.9087)
    origin_longitude: float = Field(default=116.3975)
    destination_name: str | None = Field(default=None)
    destination_latitude: float | None = Field(default=None)
    destination_longitude: float | None = Field(default=None)
    must_visit_names: list[str] = Field(default_factory=list)
    budget: float | None = Field(default=None)
    available_hours: float | None = Field(default=None)
    travel_days: int | None = Field(default=None)
    preference_mode: str = Field(default="balanced")
    preferences: PreferenceInput = Field(default_factory=PreferenceInput)
    preferred_districts: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    special_interests: list[str] = Field(default_factory=list)
    max_poi_count: int | None = Field(default=None)
    max_transit_minutes_per_leg: int | None = Field(default=None)


class POIOut(BaseModel):
    id: int
    name: str
    district: str
    category: str
    latitude: float
    longitude: float
    ticket_price: float
    suggested_visit_hours: float
    rating: float
    tags: list[str]
    description: str


class ItineraryItem(BaseModel):
    day_index: int
    start_time: str
    end_time: str
    poi_name: str
    stay_hours: float
    transit_minutes_from_previous: int


class StopHighlight(BaseModel):
    poi_name: str
    reason_title: str
    reason_body: str
    tags: list[str] = Field(default_factory=list)


class RouteOption(BaseModel):
    title: str
    strategy: str
    route_style: str
    score: float
    total_budget: float
    total_duration_hours: float
    total_travel_km: float
    highlight_reason: str
    pois: list[POIOut]
    itinerary: list[ItineraryItem]
    stop_highlights: list[StopHighlight] = Field(default_factory=list)


class RecommendationResponse(BaseModel):
    city: str = "北京"
    origin_name: str
    recommendation_summary: str
    request_profile: str = "generic"
    route_generation_source: str = "rule_fallback"
    route_generation_note: str | None = None
    applied_defaults: list[str] = Field(default_factory=list)
    matched_must_visit_names: list[str] = Field(default_factory=list)
    missing_must_visit_names: list[str] = Field(default_factory=list)
    route_options: list[RouteOption]
