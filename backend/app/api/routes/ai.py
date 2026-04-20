from fastapi import APIRouter

from app.schemas.ai import AIPlanningRequest, AIPlanningResponse
from app.services.ai_orchestrator import AIOrchestrator

router = APIRouter()
service = AIOrchestrator()


@router.post("/plan", response_model=AIPlanningResponse)
def plan_with_ai(payload: AIPlanningRequest) -> AIPlanningResponse:
    return service.plan(payload)
