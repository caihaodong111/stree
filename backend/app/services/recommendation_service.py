from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.planners.beijing_route_planner import BeijingRoutePlanner
from app.repositories.poi_repository import POIRepository
from app.schemas.recommendation import RecommendationRequest, RecommendationResponse


class RecommendationService:
    DEFAULT_BUDGET = 600.0
    DEFAULT_AVAILABLE_HOURS = 8.0
    DEFAULT_MAX_POI_COUNT = 3

    def __init__(self) -> None:
        self.planner = BeijingRoutePlanner()
        self.poi_repository = POIRepository()

    def recommend(self, payload: RecommendationRequest, db: Session) -> RecommendationResponse:
        pois = self.poi_repository.list_all(db)
        if not pois:
            raise HTTPException(
                status_code=400,
                detail="POI catalog is empty. Run `python seed_pois.py` in the backend directory first.",
            )
        normalized_payload, applied_defaults = self._normalize_payload(payload)
        outcome = self.planner.recommend(normalized_payload, pois)
        summary = (
            "系统已综合预算、游玩时长、景点丰富度和地理紧凑度生成候选路线。"
            "当前版本支持必去点串联、区域锚点规划，以及只填预算/时长的自动路线生成。"
        )
        return RecommendationResponse(
            origin_name=normalized_payload.origin_name,
            recommendation_summary=summary,
            request_profile=self._request_profile(payload),
            applied_defaults=applied_defaults,
            matched_must_visit_names=outcome.matched_must_visit_names,
            missing_must_visit_names=outcome.missing_must_visit_names,
            route_options=outcome.route_options,
        )

    def _normalize_payload(self, payload: RecommendationRequest) -> tuple[RecommendationRequest, list[str]]:
        applied_defaults: list[str] = []

        budget = payload.budget
        if budget is None:
            budget = self.DEFAULT_BUDGET
            applied_defaults.append(f"预算按默认 {int(self.DEFAULT_BUDGET)} 元处理")

        available_hours = payload.available_hours
        if available_hours is None:
            available_hours = self.DEFAULT_AVAILABLE_HOURS
            applied_defaults.append(f"时长按默认 {int(self.DEFAULT_AVAILABLE_HOURS)} 小时处理")

        max_poi_count = payload.max_poi_count
        if max_poi_count is None:
            max_poi_count = max(self.DEFAULT_MAX_POI_COUNT, len(payload.must_visit_names))
            applied_defaults.append(f"点位数按默认 {max_poi_count} 个处理")
        elif max_poi_count < len(payload.must_visit_names):
            max_poi_count = len(payload.must_visit_names)
            applied_defaults.append("已自动扩展点位数以容纳全部必去点")

        travel_days = payload.travel_days
        if travel_days is None:
            travel_days = 2 if available_hours >= 11 else 1

        max_transit_minutes_per_leg = payload.max_transit_minutes_per_leg
        if max_transit_minutes_per_leg is None:
            max_transit_minutes_per_leg = 90 if payload.must_visit_names or payload.destination_name else 75

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
