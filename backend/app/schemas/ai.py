from pydantic import BaseModel, Field

from app.schemas.recommendation import RecommendationRequest


class AIPlanningRequest(BaseModel):
    user_message: str = Field(..., description="Natural language trip request.")
    draft_request: RecommendationRequest | None = None


class AIPlanningResponse(BaseModel):
    provider: str
    model: str
    normalized_request: RecommendationRequest
    assistant_reply: str
    status: str = "ai"
    fallback_used: bool = False
    fallback_reason: str | None = None
    parser_notes: list[str] = Field(default_factory=list)


class AIRouteOptionAnalysis(BaseModel):
    strategy: str
    highlight_reason: str


class AIRouteAnalysisResult(BaseModel):
    recommendation_summary: str
    route_overrides: list[AIRouteOptionAnalysis] = Field(default_factory=list)


class AIGeneratedStopHighlight(BaseModel):
    poi_name: str
    reason_title: str
    reason_body: str
    tags: list[str] = Field(default_factory=list)


class AIGeneratedRouteOption(BaseModel):
    strategy: str
    title: str
    highlight_reason: str
    poi_names: list[str] = Field(default_factory=list)
    stop_highlights: list[AIGeneratedStopHighlight] = Field(default_factory=list)


class AIGeneratedRoutePlan(BaseModel):
    recommendation_summary: str
    route_options: list[AIGeneratedRouteOption] = Field(default_factory=list)
    missing_must_visit_names: list[str] = Field(default_factory=list)
