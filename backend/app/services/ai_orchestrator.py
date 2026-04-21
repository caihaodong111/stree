from app.schemas.ai import AIPlanningRequest, AIPlanningResponse
from app.services.ai_request_parser import AIRequestParser


class AIOrchestrator:
    def __init__(self) -> None:
        self.request_parser = AIRequestParser()

    def plan(self, payload: AIPlanningRequest) -> AIPlanningResponse:
        return self.request_parser.plan(payload.user_message, payload.draft_request)
