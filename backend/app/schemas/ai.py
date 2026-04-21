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
    fallback_used: bool = False


class AIRouteOptionAnalysis(BaseModel):
    strategy: str
    highlight_reason: str


class AIRouteAnalysisResult(BaseModel):
    recommendation_summary: str
    route_overrides: list[AIRouteOptionAnalysis] = Field(default_factory=list)
