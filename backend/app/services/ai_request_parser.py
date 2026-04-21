import json

from app.schemas.ai import AIPlanningResponse
from app.schemas.recommendation import PreferenceInput, RecommendationRequest
from app.services.llm_client import LLMClientError, OpenAICompatibleLLMClient


class AIRequestParser:
    def __init__(self) -> None:
        self.client = OpenAICompatibleLLMClient()

    def plan(self, user_message: str, draft_request: RecommendationRequest | None = None) -> AIPlanningResponse:
        if self.client.enabled:
            ai_result = self._plan_with_model(user_message, draft_request)
            if ai_result is not None:
                return ai_result

        normalized = self._merge_with_draft(self._heuristic_parse(user_message), draft_request)
        reply = (
            "当前已回退到本地规则解析。待配置智谱 API Key 后，这里会先用 GLM-5.1 做受约束意图整理，"
            "再把结构化结果交给路线引擎。"
        )
        return AIPlanningResponse(
            provider=self.client.provider,
            model=self.client.model or "heuristic-fallback",
            normalized_request=normalized,
            assistant_reply=reply,
            fallback_used=True,
        )

    def _plan_with_model(
        self,
        user_message: str,
        draft_request: RecommendationRequest | None,
    ) -> AIPlanningResponse | None:
        system_prompt = (
            "你是北京旅行需求结构化助手。"
            "你的唯一任务是把用户的自然语言需求整理成稳定、保守、可供算法使用的 JSON。"
            "不能虚构坐标、景点事实、预算、时长或行政区。"
            "无法确定的字段保持空、null 或默认，不要乱猜。"
            "必须只输出一个 JSON 对象，不要输出 Markdown。"
            'JSON 结构为：{"normalized_request": {...}, "assistant_reply": "..."}。'
            "normalized_request 只填写 RecommendationRequest 中能从用户话里稳定推断出的字段；"
            "不要主动填写 origin_latitude、origin_longitude、destination_latitude、destination_longitude。"
            "assistant_reply 用简短中文说明你提取了哪些条件，以及哪些内容仍未明确。"
        )
        user_prompt = json.dumps(
            {
                "user_message": user_message,
                "draft_request": draft_request.model_dump(mode="json") if draft_request else None,
                "allowed_preference_mode": ["balanced", "time_first", "richness_first"],
            },
            ensure_ascii=False,
            indent=2,
        )

        try:
            raw = self.client.chat_json(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=0.1,
                max_tokens=1000,
            )
        except LLMClientError:
            return None

        normalized_payload = raw.get("normalized_request")
        assistant_reply = raw.get("assistant_reply")
        if not isinstance(normalized_payload, dict) or not isinstance(assistant_reply, str) or not assistant_reply.strip():
            return None

        try:
            normalized = RecommendationRequest.model_validate(normalized_payload)
        except Exception:
            return None

        normalized = self._merge_with_draft(normalized, draft_request)
        return AIPlanningResponse(
            provider=self.client.provider,
            model=self.client.model,
            normalized_request=normalized,
            assistant_reply=assistant_reply.strip(),
            fallback_used=False,
        )

    def _merge_with_draft(
        self,
        parsed_request: RecommendationRequest,
        draft_request: RecommendationRequest | None,
    ) -> RecommendationRequest:
        if draft_request is None:
            return parsed_request

        merged = draft_request.model_dump(mode="json")
        parsed = parsed_request.model_dump(mode="json")
        for key, value in parsed.items():
            if value in (None, "", [], {}):
                continue
            merged[key] = value

        return RecommendationRequest.model_validate(merged)

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
