import json

from app.schemas.ai import AIRouteAnalysisResult
from app.schemas.recommendation import RecommendationRequest, RouteOption
from app.services.llm_client import LLMClientError, OpenAICompatibleLLMClient


class AIRouteAnalyst:
    def __init__(self) -> None:
        self.client = OpenAICompatibleLLMClient()

    def analyze_routes(
        self,
        payload: RecommendationRequest,
        route_options: list[RouteOption],
        matched_must_visit_names: list[str],
        missing_must_visit_names: list[str],
    ) -> AIRouteAnalysisResult | None:
        if not self.client.enabled or not route_options:
            return None

        system_prompt = (
            "你是北京路线规划系统的审阅分析器。"
            "你只能基于用户请求和系统已经算出的候选路线做分析，不能发明新的景点、预算、时长、路程、门票、交通方式。"
            "你不能改动候选路线里的 POI 列表、顺序或数值事实，只能总结和解释。"
            "如果信息不足，就明确使用“当前数据未提供”之类的表达。"
            "请始终返回一个 JSON 对象，不要输出 Markdown，不要输出额外说明。"
            'JSON 结构为：{"recommendation_summary":"",'
            '"route_overrides":[{"strategy":"","highlight_reason":""}]}。'
            "recommendation_summary 需要简洁、可信，突出这批候选路线的整体取舍。"
            "route_overrides 中只允许覆盖已提供 strategy 的文案，highlight_reason 控制在一两句话。"
        )

        user_prompt = json.dumps(
            {
                "request": {
                    "origin_name": payload.origin_name,
                    "destination_name": payload.destination_name,
                    "must_visit_names": payload.must_visit_names,
                    "preferred_districts": payload.preferred_districts,
                    "budget": payload.budget,
                    "available_hours": payload.available_hours,
                    "travel_days": payload.travel_days,
                    "preference_mode": payload.preference_mode,
                    "preferences": payload.preferences.model_dump(),
                    "max_poi_count": payload.max_poi_count,
                },
                "matched_must_visit_names": matched_must_visit_names,
                "missing_must_visit_names": missing_must_visit_names,
                "route_options": [
                    {
                        "strategy": route.strategy,
                        "title": route.title,
                        "route_style": route.route_style,
                        "score": route.score,
                        "total_budget": route.total_budget,
                        "total_duration_hours": route.total_duration_hours,
                        "total_travel_km": route.total_travel_km,
                        "highlight_reason": route.highlight_reason,
                        "pois": [poi.name for poi in route.pois],
                    }
                    for route in route_options
                ],
            },
            ensure_ascii=False,
            indent=2,
        )

        try:
            raw = self.client.chat_json(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=0.1,
                max_tokens=900,
            )
        except LLMClientError:
            return None

        try:
            result = AIRouteAnalysisResult.model_validate(raw)
        except Exception:
            return None

        valid_strategies = {route.strategy for route in route_options}
        result.route_overrides = [
            override
            for override in result.route_overrides
            if override.strategy in valid_strategies and override.highlight_reason.strip()
        ]
        if not result.recommendation_summary.strip():
            return None
        return result
