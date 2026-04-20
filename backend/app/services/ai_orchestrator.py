from app.core.config import settings
from app.schemas.ai import AIPlanningRequest, AIPlanningResponse
from app.schemas.recommendation import PreferenceInput, RecommendationRequest


class AIOrchestrator:
    def plan(self, payload: AIPlanningRequest) -> AIPlanningResponse:
        normalized = payload.draft_request or self._heuristic_parse(payload.user_message)
        reply = (
            "已将你的描述整理成结构化出行需求。后续可把这里替换成真实的大模型调用，"
            "让模型只负责意图解析、偏好补全和结果解释，再调用路线引擎生成最终方案。"
        )
        return AIPlanningResponse(
            provider=settings.llm_provider,
            model=settings.llm_model or "heuristic-fallback",
            normalized_request=normalized,
            assistant_reply=reply,
        )

    def _heuristic_parse(self, message: str) -> RecommendationRequest:
        lower = message.lower()
        mode = "balanced"
        if "最短" in message or "省时" in message:
            mode = "time_first"
        if "丰富" in message or "多景点" in message:
            mode = "richness_first"

        budget = 600
        if "1000" in message:
            budget = 1000
        elif "800" in message:
            budget = 800
        elif "300" in message:
            budget = 300

        available_hours = 10
        if "半天" in message:
            available_hours = 5
        elif "两天" in message or "2天" in lower:
            available_hours = 18

        interests: list[str] = []
        if "拍照" in message:
            interests.append("拍照")
        if "历史" in message:
            interests.append("历史")
        if "美食" in message:
            interests.append("美食")

        return RecommendationRequest(
            budget=budget,
            available_hours=available_hours,
            travel_days=2 if available_hours > 12 else 1,
            preference_mode=mode,
            preferences=PreferenceInput(
                mode=mode,
                favor_low_budget="省钱" in message,
                favor_photography="拍照" in message,
                avoid_crowds="人少" in message,
            ),
            special_interests=interests,
        )
