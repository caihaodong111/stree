import logging
from math import inf

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.hotel import HotelPOI
from app.planners.beijing_route_planner import BeijingRoutePlanner
from app.repositories.hotel_repository import HotelRepository
from app.schemas.ai import AIRouteOptionAnalysis
from app.schemas.recommendation import HotelRecommendation, ItineraryItem, RecommendationRequest, RecommendationResponse
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
        self.hotel_repository = HotelRepository()

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
            route_options = self._attach_hotel_context(route_options, normalized_payload, db)
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
        route_options = self._attach_hotel_context(route_options, normalized_payload, db)

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

    def _attach_hotel_context(
        self,
        route_options: list[RouteOption],
        payload: RecommendationRequest,
        db: Session,
    ) -> list[RouteOption]:
        if payload.travel_days is None or payload.travel_days <= 1 or not route_options:
            return route_options

        hotels = list(self.hotel_repository.list_all(db, limit=20000))
        if not hotels:
            return route_options

        return [self._attach_hotels_to_route(route, payload, hotels) for route in route_options]

    def _attach_hotels_to_route(
        self,
        route: RouteOption,
        payload: RecommendationRequest,
        hotels: list[HotelPOI],
    ) -> RouteOption:
        day_map: dict[int, list[ItineraryItem]] = {}
        for item in route.itinerary:
            day_map.setdefault(item.day_index, []).append(item)

        ordered_days = sorted(day_map)
        if len(ordered_days) <= 1:
            return route

        day_hotels: list[HotelRecommendation] = []
        merged_itinerary: list[ItineraryItem] = []
        previous_hotel: HotelRecommendation | None = None

        for index, day_index in enumerate(ordered_days):
            items = list(day_map[day_index])
            if previous_hotel is not None and items:
                first_item = items[0]
                if first_item.latitude is not None and first_item.longitude is not None:
                    transit = self._estimate_transit_minutes(
                        previous_hotel.latitude,
                        previous_hotel.longitude,
                        first_item.latitude,
                        first_item.longitude,
                    )
                    items[0] = first_item.model_copy(
                        update={
                            "transit_minutes_from_previous": transit,
                        }
                    )

            merged_itinerary.extend(items)

            is_last_day = index == len(ordered_days) - 1
            if is_last_day:
                continue

            end_item = items[-1] if items else None
            next_items = day_map.get(ordered_days[index + 1], [])
            next_start = next_items[0] if next_items else None
            if end_item is None or end_item.latitude is None or end_item.longitude is None:
                continue

            hotel = self._pick_hotel_for_overnight(
                end_item=end_item,
                next_start=next_start,
                payload=payload,
                route=route,
                hotels=hotels,
            )
            if hotel is None:
                continue

            day_hotels.append(hotel)
            hotel_transit = self._estimate_transit_minutes(
                end_item.latitude,
                end_item.longitude,
                hotel.latitude,
                hotel.longitude,
            )
            merged_itinerary.append(
                ItineraryItem(
                    day_index=day_index,
                    start_time=end_item.end_time,
                    end_time=f"次日 {next_start.start_time if next_start is not None else '08:30'}",
                    poi_name=hotel.hotel_name,
                    stay_hours=10.0,
                    transit_minutes_from_previous=hotel_transit,
                    item_type="hotel",
                    district=hotel.district,
                    latitude=hotel.latitude,
                    longitude=hotel.longitude,
                    reference_price=hotel.reference_price,
                )
            )
            previous_hotel = hotel

        accommodation_budget = round(
            sum(hotel.reference_price or 0 for hotel in day_hotels),
            2,
        )
        total_budget_with_hotel = round(route.total_budget + accommodation_budget, 2)

        return route.model_copy(
            update={
                "itinerary": merged_itinerary,
                "recommended_hotels": day_hotels,
                "estimated_accommodation_budget": accommodation_budget,
                "total_budget_with_hotel": total_budget_with_hotel,
            }
        )

    def _pick_hotel_for_overnight(
        self,
        *,
        end_item: ItineraryItem,
        next_start: ItineraryItem | None,
        payload: RecommendationRequest,
        route: RouteOption,
        hotels: list[HotelPOI],
    ) -> HotelRecommendation | None:
        if end_item.latitude is None or end_item.longitude is None:
            return None

        night_count = max(1, (payload.travel_days or 1) - 1)
        remaining_budget = max(0.0, payload.budget - route.total_budget)
        nightly_budget_cap = remaining_budget / night_count if remaining_budget > 0 else None
        preferred_districts = {item.district for item in route.pois if item.district}

        best_hotel: HotelPOI | None = None
        best_score = inf
        for hotel in hotels:
            if not hotel.is_active:
                continue
            if nightly_budget_cap is not None and hotel.reference_price is not None and hotel.reference_price > nightly_budget_cap * 1.35:
                continue

            distance_to_end = self.planner._distance_km(
                end_item.latitude,
                end_item.longitude,
                hotel.latitude,
                hotel.longitude,
            )
            if distance_to_end > 8:
                continue

            distance_to_next = 0.0
            if next_start is not None and next_start.latitude is not None and next_start.longitude is not None:
                distance_to_next = self.planner._distance_km(
                    hotel.latitude,
                    hotel.longitude,
                    next_start.latitude,
                    next_start.longitude,
                )

            price = hotel.reference_price if hotel.reference_price is not None else 450.0
            price_penalty = price / 120
            district_bonus = -1.5 if hotel.district in preferred_districts else 0.0
            score = distance_to_end * 2.6 + distance_to_next * 1.8 + price_penalty + district_bonus

            if hotel.reference_price is None:
                score += 0.8
            if hotel.star_level:
                score -= 0.3

            if score < best_score:
                best_score = score
                best_hotel = hotel

        if best_hotel is None:
            return None

        reason_parts = [f"衔接 {end_item.poi_name} 收尾"]
        if next_start is not None:
            reason_parts.append(f"并方便次日去 {next_start.poi_name}")
        if best_hotel.reference_price is not None:
            reason_parts.append(f"参考价约 {best_hotel.reference_price:.0f} 元")

        return HotelRecommendation(
            day_index=end_item.day_index,
            hotel_id=best_hotel.id,
            hotel_name=best_hotel.name,
            district=best_hotel.district,
            address=best_hotel.address,
            latitude=best_hotel.latitude,
            longitude=best_hotel.longitude,
            reference_price=best_hotel.reference_price,
            nights=1,
            reason="，".join(reason_parts),
        )

    def _estimate_transit_minutes(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
    ) -> int:
        return max(8, round(self.planner._distance_km(start_lat, start_lon, end_lat, end_lon) * 6))

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
