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

    def __init__(self) -> None:
        self.planner = BeijingRoutePlanner()
        self.ai_route_generator = AIRouteGenerator()
        self.ai_route_analyst = AIRouteAnalyst()
        self.live_poi_service = LivePOIService()

    def recommend(self, payload: RecommendationRequest, db: Session) -> RecommendationResponse:
        if payload.travel_days is None or payload.travel_days <= 0:
            raise HTTPException(status_code=400, detail="生成路线前必须先选择天数。")

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
        baseline_outcome = self.planner.recommend(normalized_payload, pois)
        ai_outcome = self.ai_route_generator.generate(normalized_payload, list(pois))

        if ai_outcome is not None and ai_outcome.route_options:
            route_options = self._select_route_options(
                self._merge_route_options(ai_outcome.route_options, baseline_outcome.route_options),
                requested_payload=payload,
            )
            logger.info("recommend using_ai_routes route_count=%s", len(route_options))
            return RecommendationResponse(
                origin_name=normalized_payload.origin_name,
                recommendation_summary=ai_outcome.recommendation_summary,
                request_profile=self._request_profile(normalized_payload),
                route_generation_source="ai_generated",
                route_generation_note="路线由 AI 从候选景点中选点和解释，再由代码校验约束并测算真实通勤数据。",
                applied_defaults=applied_defaults,
                matched_must_visit_names=ai_outcome.matched_must_visit_names,
                missing_must_visit_names=ai_outcome.missing_must_visit_names,
                route_options=route_options,
            )

        logger.warning("recommend fallback_to_rules")
        summary = self._fallback_summary()
        route_options = self._select_route_options(
            baseline_outcome.route_options,
            requested_payload=payload,
        )
        ai_analysis = self.ai_route_analyst.analyze_routes(
            normalized_payload,
            route_options,
            baseline_outcome.matched_must_visit_names,
            baseline_outcome.missing_must_visit_names,
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
            matched_must_visit_names=baseline_outcome.matched_must_visit_names,
            missing_must_visit_names=baseline_outcome.missing_must_visit_names,
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
        override_map = {item.option_id: item.highlight_reason.strip() for item in route_overrides if item.highlight_reason.strip()}
        if not override_map:
            return route_options

        return [
            route.model_copy(
                update={"highlight_reason": override_map.get(route.option_id, route.highlight_reason)}
            )
            for route in route_options
        ]

    def _merge_route_options(
        self,
        primary: list[RouteOption],
        fallback: list[RouteOption],
    ) -> list[RouteOption]:
        merged: dict[str, RouteOption] = {route.option_id: route for route in fallback}
        for route in primary:
            merged[route.option_id] = route
        return list(merged.values())

    def _select_route_options(
        self,
        route_options: list[RouteOption],
        *,
        requested_payload: RecommendationRequest,
    ) -> list[RouteOption]:
        if not route_options:
            return []

        by_option_id = {route.option_id: route for route in route_options}
        selected: list[RouteOption] = []
        seen_signatures: set[tuple[int, ...]] = set()
        selected_ids: set[str] = set()

        for option_id in self._candidate_option_order(requested_payload):
            route = by_option_id.get(option_id)
            if route is None:
                continue
            signature = tuple(poi.id for poi in route.pois)
            if signature in seen_signatures:
                continue
            selected.append(route)
            selected_ids.add(route.option_id)
            seen_signatures.add(signature)

        for route in sorted(route_options, key=lambda item: item.score, reverse=True):
            if route.option_id in selected_ids:
                continue
            signature = tuple(poi.id for poi in route.pois)
            if signature in seen_signatures:
                continue
            selected.append(route)
            selected_ids.add(route.option_id)
            seen_signatures.add(signature)

        return selected

    def _candidate_option_order(self, payload: RecommendationRequest) -> list[str]:
        preferred = {
            "balanced": "balanced",
            "time_first": "time_first",
            "richness_first": "richness_first",
        }.get(payload.preference_mode, "balanced")

        ordered: list[str] = []
        if payload.budget is None or payload.preferences.favor_low_budget:
            ordered.append("budget_min")
        ordered.extend([preferred, "balanced", "time_first", "richness_first"])
        if "budget_min" not in ordered:
            ordered.append("budget_min")
        return list(dict.fromkeys(ordered))

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
            max_poi_count = self.planner.suggest_target_poi_count(payload, len(payload.must_visit_names))
            applied_defaults.append(f"点位数按行程时长自动扩展到 {max_poi_count} 个处理")
        elif max_poi_count < len(payload.must_visit_names):
            max_poi_count = len(payload.must_visit_names)
            applied_defaults.append("已自动扩展点位数以容纳全部必去点")

        travel_days = payload.travel_days

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
