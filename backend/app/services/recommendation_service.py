import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.planners.beijing_route_planner import BeijingRoutePlanner
from app.schemas.ai import AIRouteOptionAnalysis
from app.schemas.recommendation import RecommendationRequest, RecommendationResponse
from app.schemas.recommendation import RouteOption
from app.services.ai_route_generator import AIRouteGenerator
from app.services.ai_route_analyst import AIRouteAnalyst
from app.services.live_poi_service import LivePOIService


logger = logging.getLogger("app.ai.recommendation")


class RecommendationService:
    DEFAULT_BUDGET = 600.0
    DEFAULT_MAX_POI_COUNT = 3

    def __init__(self) -> None:
        self.planner = BeijingRoutePlanner()
        self.ai_route_generator = AIRouteGenerator()
        self.ai_route_analyst = AIRouteAnalyst()
        self.live_poi_service = LivePOIService()

    def recommend(self, payload: RecommendationRequest, db: Session) -> RecommendationResponse:
        normalized_payload, applied_defaults = self._normalize_payload(payload)
        pois = self.live_poi_service.list_candidates(normalized_payload, db)
        if not pois:
            raise HTTPException(
                status_code=400,
                detail="No candidate POIs were found from live search or local cache.",
            )
        logger.info(
            "recommend start model=%s origin=%s budget=%s hours=%s max_poi=%s must_visit_count=%s candidates=%s",
            self.ai_route_generator.client.model,
            normalized_payload.origin_name,
            normalized_payload.budget,
            normalized_payload.available_hours,
            normalized_payload.max_poi_count,
            len(normalized_payload.must_visit_names),
            len(pois),
        )
        ai_outcome = self.ai_route_generator.generate(normalized_payload, list(pois))

        if ai_outcome is not None and ai_outcome.route_options:
            logger.info("recommend using_ai_routes route_count=%s", len(ai_outcome.route_options))
            return RecommendationResponse(
                origin_name=normalized_payload.origin_name,
                recommendation_summary=ai_outcome.recommendation_summary,
                request_profile=self._request_profile(normalized_payload),
                route_generation_source="ai_generated",
                route_generation_note="路线由 AI 从候选景点中选点和解释，再由代码校验约束并测算真实通勤数据。",
                applied_defaults=applied_defaults,
                matched_must_visit_names=ai_outcome.matched_must_visit_names,
                missing_must_visit_names=ai_outcome.missing_must_visit_names,
                route_options=ai_outcome.route_options,
            )

        logger.warning("recommend fallback_to_rules")
        outcome = self.planner.recommend(normalized_payload, pois)
        summary = self._fallback_summary()
        route_options = outcome.route_options
        ai_analysis = self.ai_route_analyst.analyze_routes(
            normalized_payload,
            route_options,
            outcome.matched_must_visit_names,
            outcome.missing_must_visit_names,
        )
        if ai_analysis is not None:
            logger.info("recommend applied_ai_analysis route_count=%s", len(route_options))
            summary = ai_analysis.recommendation_summary
            route_options = self._apply_route_analysis(route_options, ai_analysis.route_overrides)

        return RecommendationResponse(
            origin_name=normalized_payload.origin_name,
            recommendation_summary=summary,
            request_profile=self._request_profile(normalized_payload),
            route_generation_source="rule_fallback",
            route_generation_note=(
                "路线由规则引擎生成。"
                + (" 当前整体说明和亮点文案由 AI 审阅补充。" if ai_analysis is not None else " 当前未使用 AI 路线生成。")
            ),
            applied_defaults=applied_defaults,
            matched_must_visit_names=outcome.matched_must_visit_names,
            missing_must_visit_names=outcome.missing_must_visit_names,
            route_options=route_options,
        )

    def _fallback_summary(self) -> str:
        return (
            "AI 路线生成当前未给出可用方案，系统已回退到规则规划。"
            "本版会继续基于预算、游玩时长、景点丰富度和地理紧凑度给出候选路线。"
        )

    def _apply_route_analysis(
        self,
        route_options: list[RouteOption],
        route_overrides: list[AIRouteOptionAnalysis],
    ) -> list[RouteOption]:
        override_map = {item.strategy: item.highlight_reason.strip() for item in route_overrides if item.highlight_reason.strip()}
        if not override_map:
            return route_options

        return [
            route.model_copy(
                update={"highlight_reason": override_map.get(route.strategy, route.highlight_reason)}
            )
            for route in route_options
        ]

    def _normalize_payload(self, payload: RecommendationRequest) -> tuple[RecommendationRequest, list[str]]:
        applied_defaults: list[str] = []

        budget = payload.budget
        if budget is None:
            budget = self.DEFAULT_BUDGET
            applied_defaults.append(f"预算按默认 {int(self.DEFAULT_BUDGET)} 元处理")

        available_hours = payload.available_hours
        if available_hours is None:
            applied_defaults.append("未设置游玩时长，本次不按时间上限过滤路线，时长仅作参考")

        max_poi_count = payload.max_poi_count
        if max_poi_count is None:
            max_poi_count = max(self.DEFAULT_MAX_POI_COUNT, len(payload.must_visit_names))
            applied_defaults.append(f"点位数按默认 {max_poi_count} 个处理")
        elif max_poi_count < len(payload.must_visit_names):
            max_poi_count = len(payload.must_visit_names)
            applied_defaults.append("已自动扩展点位数以容纳全部必去点")

        travel_days = payload.travel_days
        if travel_days is None and available_hours is not None:
            travel_days = 2 if available_hours >= 11 else 1

        max_transit_minutes_per_leg = payload.max_transit_minutes_per_leg

        normalized_payload = payload.model_copy(
            update={
                "budget": budget,
                "available_hours": available_hours,
                "travel_days": travel_days,
                "max_poi_count": max_poi_count,
                "max_transit_minutes_per_leg": max_transit_minutes_per_leg,
            }
        )

        return normalized_payload, applied_defaults

    def _request_profile(self, payload: RecommendationRequest) -> str:
        must_visit_count = len(payload.must_visit_names)
        has_destination = bool(payload.destination_name)

        if must_visit_count >= 2 and has_destination:
            return "must_visit_cluster"
        if must_visit_count >= 2:
            return "must_visit_multi"
        if must_visit_count == 1 and has_destination:
            return "must_visit_anchor"
        if must_visit_count == 1:
            return "must_visit_single"
        if has_destination:
            return "area_anchor"
        if payload.budget is not None and payload.available_hours is None:
            return "budget_only"
        if payload.available_hours is not None and payload.budget is None:
            return "time_only"
        if payload.budget is not None and payload.available_hours is not None:
            return "budget_time"
        return "generic"
