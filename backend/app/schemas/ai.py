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
