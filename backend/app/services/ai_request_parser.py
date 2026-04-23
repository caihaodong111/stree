import json
import logging

from app.schemas.ai import AIPlanningResponse
from app.schemas.recommendation import PreferenceInput, RecommendationRequest
from app.services.llm_client import LLMClientError, OpenAICompatibleLLMClient


logger = logging.getLogger("app.ai.request_parser")


class AIRequestParser:
    def __init__(self) -> None:
        self.client = OpenAICompatibleLLMClient()

    def plan(self, user_message: str, draft_request: RecommendationRequest | None = None) -> AIPlanningResponse:
        logger.info(
            "plan start enabled=%s model=%s user_message_len=%s has_draft=%s",
            self.client.enabled,
            self.client.model,
            len(user_message),
            draft_request is not None,
        )
        parser_notes: list[str] = []
        fallback_reason = "llm_not_configured"
        if self.client.enabled:
            ai_result, parser_notes, fallback_reason = self._plan_with_model(user_message, draft_request)
            if ai_result is not None:
                logger.info("plan success model=%s fallback_used=false", self.client.model)
                return ai_result
        else:
            parser_notes.append("当前未配置可用的大模型连接，已直接使用本地规则解析。")

        logger.warning("plan fallback_to_heuristic model=%s", self.client.model)
        normalized = self._merge_with_draft(self._heuristic_parse(user_message), draft_request)
        reply = self._fallback_reply(fallback_reason)
        return AIPlanningResponse(
            provider=self.client.provider,
            model=self.client.model or "heuristic-fallback",
            normalized_request=normalized,
            assistant_reply=reply,
            status="fallback",
            fallback_used=True,
            fallback_reason=fallback_reason,
            parser_notes=parser_notes,
        )

    def _plan_with_model(
        self,
        user_message: str,
        draft_request: RecommendationRequest | None,
    ) -> tuple[AIPlanningResponse | None, list[str], str | None]:
        system_prompt = (
            "你是北京旅行需求结构化助手。"
            "你的唯一任务是把用户的自然语言需求整理成稳定、保守、可供算法使用的 JSON。"
            "不能虚构坐标、景点事实、预算、时长或行政区。"
            "无法确定的字段保持空、null 或默认，不要乱猜。"
            "必须只输出一个 JSON 对象，不要输出 Markdown。"
            "不要输出推理过程，直接输出最终 JSON。"
            'JSON 结构为：{"normalized_request": {...}, "assistant_reply": "..."}。'
            "normalized_request 只填写 RecommendationRequest 中能从用户话里稳定推断出的字段；"
            "不要主动填写 origin_latitude、origin_longitude、destination_latitude、destination_longitude。"
            "assistant_reply 用简短中文说明你提取了哪些条件，以及哪些内容仍未明确。"
        )
        user_prompt = json.dumps(
            {
                "user_message": user_message,
                "draft_request": self._compact_draft_request(draft_request),
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
        except LLMClientError as exc:
            logger.warning("plan llm_error model=%s error=%s", self.client.model, exc)
            return None, ["AI 意图解析请求失败，已切换到本地规则解析。"], "llm_request_failed"

        normalized_payload = raw.get("normalized_request")
        assistant_reply = raw.get("assistant_reply")
        if not isinstance(normalized_payload, dict) or not isinstance(assistant_reply, str) or not assistant_reply.strip():
            logger.warning(
                "plan invalid_model_payload model=%s has_normalized=%s has_reply=%s",
                self.client.model,
                isinstance(normalized_payload, dict),
                isinstance(assistant_reply, str) and bool(assistant_reply.strip()),
            )
            return None, ["AI 返回了不完整的结构化结果，已切换到本地规则解析。"], "model_payload_invalid"

        normalized_input, parser_notes = self._coerce_model_request_payload(normalized_payload, draft_request)
        try:
            normalized = RecommendationRequest.model_validate(normalized_input)
        except Exception as exc:
            logger.warning("plan validate_failed model=%s error=%s", self.client.model, exc)
            parser_notes.append("AI 返回字段校验失败，已切换到本地规则解析。")
            return None, parser_notes, "model_validation_failed"
        logger.info(
            "plan normalized model=%s must_visit_count=%s budget=%s hours=%s",
            self.client.model,
            len(normalized.must_visit_names),
            normalized.budget,
            normalized.available_hours,
        )
        return AIPlanningResponse(
            provider=self.client.provider,
            model=self.client.model,
            normalized_request=normalized,
            assistant_reply=assistant_reply.strip(),
            status="ai",
            fallback_used=False,
            fallback_reason=None,
            parser_notes=parser_notes,
        ), parser_notes, None

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

    def _compact_draft_request(self, draft_request: RecommendationRequest | None) -> dict | None:
        if draft_request is None:
            return None

        compact: dict[str, object] = {
            "origin_name": draft_request.origin_name,
            "budget": draft_request.budget,
            "available_hours": draft_request.available_hours,
            "travel_days": draft_request.travel_days,
            "preference_mode": draft_request.preference_mode,
        }

        if draft_request.destination_name:
            compact["destination_name"] = draft_request.destination_name
        if draft_request.must_visit_names:
            compact["must_visit_names"] = draft_request.must_visit_names
        if draft_request.preferred_districts:
            compact["preferred_districts"] = draft_request.preferred_districts
        if draft_request.special_interests:
            compact["special_interests"] = draft_request.special_interests
        if draft_request.max_poi_count is not None:
            compact["max_poi_count"] = draft_request.max_poi_count
        if draft_request.max_transit_minutes_per_leg is not None:
            compact["max_transit_minutes_per_leg"] = draft_request.max_transit_minutes_per_leg

        compact["preferences"] = {
            "favor_low_budget": draft_request.preferences.favor_low_budget,
            "favor_photography": draft_request.preferences.favor_photography,
            "avoid_crowds": draft_request.preferences.avoid_crowds,
        }

        return {key: value for key, value in compact.items() if value not in (None, "", [], {})}

    def _normalize_model_payload(self, payload: dict) -> dict:
        normalized = dict(payload)
        alias_map = {
            "must_visit_spots": "must_visit_names",
            "must_visit": "must_visit_names",
            "duration_hours": "available_hours",
            "hours": "available_hours",
            "special_preferences": "special_interests",
            "interests": "special_interests",
            "destination": "destination_name",
            "preferred_areas": "preferred_districts",
            "districts": "preferred_districts",
            "poi_count": "max_poi_count",
            "max_stops": "max_poi_count",
            "transit_limit_minutes": "max_transit_minutes_per_leg",
        }

        for source_key, target_key in alias_map.items():
            if target_key not in normalized and source_key in normalized:
                normalized[target_key] = normalized[source_key]

        preference_mode = normalized.get("preference_mode")
        if isinstance(preference_mode, str):
            normalized["preference_mode"] = {
                "均衡": "balanced",
                "平衡": "balanced",
                "省时": "time_first",
                "时间优先": "time_first",
                "丰富": "richness_first",
                "丰富优先": "richness_first",
            }.get(preference_mode, preference_mode)

        if "preferences" not in normalized:
            special_interests = normalized.get("special_interests")
            interest_values = special_interests if isinstance(special_interests, list) else []
            normalized["preferences"] = PreferenceInput(
                mode=normalized.get("preference_mode", "balanced"),
                favor_low_budget="省钱" in interest_values or "低预算" in interest_values,
                favor_photography="拍照" in interest_values,
                avoid_crowds="避开人多" in interest_values or "人少" in interest_values,
            ).model_dump(mode="json")

        return normalized

    def _coerce_model_request_payload(
        self,
        payload: dict,
        draft_request: RecommendationRequest | None,
    ) -> tuple[dict, list[str]]:
        normalized = self._normalize_model_payload(payload)
        notes: list[str] = []

        seed = draft_request.model_dump(mode="json") if draft_request is not None else RecommendationRequest().model_dump(mode="json")
        merged = dict(seed)

        for key, value in normalized.items():
            if value in (None, "", [], {}):
                if key in {"origin_latitude", "origin_longitude", "destination_latitude", "destination_longitude"} and draft_request is not None:
                    notes.append(f"AI 未明确 {key}，已沿用表单里的定位信息。")
                continue
            merged[key] = value

        if not normalized.get("preferences"):
            notes.append("AI 未完整返回偏好开关，已沿用表单偏好。")

        return merged, list(dict.fromkeys(notes))

    def _fallback_reply(self, fallback_reason: str | None) -> str:
        mapping = {
            "llm_not_configured": "当前未配置可用的大模型连接，系统已直接使用本地规则解析需求。",
            "llm_request_failed": "AI 已接入，但本次调用未返回可用结果，系统已回退到本地规则解析。",
            "model_payload_invalid": "AI 已接入，但本次返回结构不完整，系统已回退到本地规则解析。",
            "model_validation_failed": "AI 已接入，但本次结构化字段未通过校验，系统已回退到本地规则解析。",
        }
        return mapping.get(
            fallback_reason,
            "AI 已接入，但本次结果不可用，系统已回退到本地规则解析。",
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

        available_hours: float | None = None
        travel_days: int | None = None
        if "半天" in message:
            available_hours = 5
            travel_days = 1
        elif "两天" in message or "2天" in lower:
            available_hours = 18
            travel_days = 2

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
            travel_days=travel_days,
            preference_mode=mode,
            preferences=PreferenceInput(
                mode=mode,
                favor_low_budget="省钱" in message,
                favor_photography="拍照" in message,
                avoid_crowds="人少" in message,
            ),
            special_interests=interests,
        )
