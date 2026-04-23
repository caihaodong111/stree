from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from math import atan2, cos, radians, sin, sqrt

from app.models.poi import PointOfInterest
from app.schemas.recommendation import (
    ItineraryItem,
    POIOut,
    PreferenceWeights,
    RecommendationRequest,
    RouteOption,
    StopHighlight,
)


@dataclass(frozen=True)
class PlannerPOI:
    id: int
    name: str
    district: str
    category: str
    latitude: float
    longitude: float
    ticket_price: float
    suggested_visit_hours: float
    rating: float
    popularity: int
    richness: int
    tags: tuple[str, ...]
    description: str


@dataclass(frozen=True)
class PlanningOutcome:
    route_options: list[RouteOption]
    matched_must_visit_names: list[str]
    missing_must_visit_names: list[str]


class BeijingRoutePlanner:
    PHOTO_TAGS = frozenset({"拍照", "观景", "艺术", "建筑", "夜游", "园林"})
    LOW_CROWD_TAGS = frozenset({"小众", "轻松", "自然", "室内"})
    CROWDED_TAGS = frozenset({"热门", "经典"})

    def recommend(
        self,
        payload: RecommendationRequest,
        pois: Sequence[PointOfInterest | PlannerPOI],
    ) -> PlanningOutcome:
        weights = PreferenceWeights.from_user_preferences(payload.preferences)
        planner_pois = self.to_planner_pois(pois)
        must_visit_pois, missing_must_visits = self._resolve_must_visit_pois(payload.must_visit_names, planner_pois)
        candidates = self._filter_candidates(payload, planner_pois, must_visit_pois)
        strategies = ("balanced", "time_first", "richness_first")

        route_options: list[RouteOption] = []
        for strategy in strategies:
            selected = self._build_route(candidates, payload, strategy, must_visit_pois)
            if not selected:
                continue
            route_options.append(self._build_option(selected, payload, weights, strategy))

        route_options.sort(key=lambda item: item.score, reverse=True)
        return PlanningOutcome(
            route_options=route_options,
            matched_must_visit_names=[poi.name for poi in must_visit_pois],
            missing_must_visit_names=missing_must_visits,
        )

    def _filter_candidates(
        self,
        payload: RecommendationRequest,
        pois: Sequence[PlannerPOI],
        must_visit_pois: Sequence[PlannerPOI],
    ) -> list[PlannerPOI]:
        must_visit_ids = {poi.id for poi in must_visit_pois}
        items: list[PlannerPOI] = []
        for poi in pois:
            if poi.id in must_visit_ids:
                items.append(poi)
                continue
            if payload.preferred_districts and poi.district not in payload.preferred_districts:
                continue
            if payload.categories and poi.category not in payload.categories:
                continue
            if poi.ticket_price > payload.budget * 0.6:
                continue
            items.append(poi)
        return items

    def _resolve_must_visit_pois(
        self,
        requested_names: Sequence[str],
        pois: Sequence[PlannerPOI],
    ) -> tuple[list[PlannerPOI], list[str]]:
        matched: list[PlannerPOI] = []
        missing: list[str] = []
        seen_ids: set[int] = set()

        for raw_name in requested_names:
            name = raw_name.strip()
            normalized = self._normalize_name(name)
            if not normalized:
                continue

            candidates = [
                poi
                for poi in pois
                if normalized in self._normalize_name(poi.name) or self._normalize_name(poi.name) in normalized
            ]
            if not candidates:
                missing.append(name)
                continue

            chosen = max(
                candidates,
                key=lambda poi: (
                    self._match_score(normalized, self._normalize_name(poi.name)),
                    poi.rating,
                    poi.richness,
                    -poi.ticket_price,
                ),
            )
            if chosen.id not in seen_ids:
                matched.append(chosen)
                seen_ids.add(chosen.id)

        return matched, missing

    def to_planner_pois(
        self,
        pois: Sequence[PointOfInterest | PlannerPOI],
    ) -> list[PlannerPOI]:
        planner_pois: list[PlannerPOI] = []
        for item in pois:
            if isinstance(item, PlannerPOI):
                planner_pois.append(item)
            else:
                planner_pois.append(self._from_model(item))
        return planner_pois

    def _from_model(self, poi: PointOfInterest) -> PlannerPOI:
        return PlannerPOI(
            id=poi.id,
            name=poi.name,
            district=poi.district,
            category=poi.category,
            latitude=poi.latitude,
            longitude=poi.longitude,
            ticket_price=poi.ticket_price,
            suggested_visit_hours=poi.suggested_visit_hours,
            rating=poi.rating,
            popularity=poi.popularity,
            richness=poi.richness,
            tags=tuple(poi.tags or []),
            description=poi.description,
        )

    def _build_route(
        self,
        candidates: list[PlannerPOI],
        payload: RecommendationRequest,
        strategy: str,
        must_visit_pois: Sequence[PlannerPOI],
    ) -> list[PlannerPOI]:
        selected: list[PlannerPOI] = []
        total_budget = 0.0
        total_hours = 0.0
        current_lat = payload.origin_latitude
        current_lon = payload.origin_longitude

        required_route = self._reorder_route(list(must_visit_pois), payload)
        for poi in required_route:
            transit_minutes = self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude) * 6
            if selected and self._transit_limit_exceeded(payload, transit_minutes):
                return []
            transit_hours = self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude) / 10
            projected_hours = total_hours + transit_hours + poi.suggested_visit_hours
            projected_budget = total_budget + poi.ticket_price
            if self._time_limit_exceeded(payload, projected_hours) or projected_budget > payload.budget:
                return []

            selected.append(poi)
            total_hours = projected_hours
            total_budget = projected_budget
            current_lat, current_lon = poi.latitude, poi.longitude

        selected_ids = {poi.id for poi in selected}
        remaining = [poi for poi in candidates if poi.id not in selected_ids]

        while remaining and len(selected) < payload.max_poi_count:
            best_index: int | None = None
            best_score = float("-inf")
            best_transit_hours = 0.0

            for index, poi in enumerate(remaining):
                distance = self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude)
                transit_minutes = distance * 6
                if self._transit_limit_exceeded(payload, transit_minutes):
                    continue

                transit_hours = distance / 10
                projected_hours = total_hours + transit_hours + poi.suggested_visit_hours
                projected_budget = total_budget + poi.ticket_price

                if self._time_limit_exceeded(payload, projected_hours):
                    continue
                if projected_budget > payload.budget:
                    continue

                utility = self._poi_utility(
                    poi=poi,
                    payload=payload,
                    strategy=strategy,
                    current_lat=current_lat,
                    current_lon=current_lon,
                )
                if utility > best_score:
                    best_index = index
                    best_score = utility
                    best_transit_hours = transit_hours

            if best_index is None:
                break

            chosen = remaining.pop(best_index)
            selected.append(chosen)
            total_hours += best_transit_hours + chosen.suggested_visit_hours
            total_budget += chosen.ticket_price
            current_lat, current_lon = chosen.latitude, chosen.longitude

        return self._reorder_route(selected, payload)

    def _build_option(
        self,
        selected: list[PlannerPOI],
        payload: RecommendationRequest,
        weights: PreferenceWeights,
        strategy: str,
    ) -> RouteOption:
        travel_km = 0.0
        current_lat = payload.origin_latitude
        current_lon = payload.origin_longitude
        total_ticket = 0.0
        total_visit_hours = 0.0
        poi_out: list[POIOut] = []

        for poi in selected:
            segment = self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude)
            travel_km += segment
            total_ticket += poi.ticket_price
            total_visit_hours += poi.suggested_visit_hours
            current_lat, current_lon = poi.latitude, poi.longitude
            poi_out.append(
                POIOut(
                    id=poi.id,
                    name=poi.name,
                    district=poi.district,
                    category=poi.category,
                    latitude=poi.latitude,
                    longitude=poi.longitude,
                    ticket_price=poi.ticket_price,
                    suggested_visit_hours=poi.suggested_visit_hours,
                    rating=poi.rating,
                    tags=list(poi.tags),
                    description=poi.description,
                )
            )

        transit_hours = travel_km / 10
        total_hours = round(total_visit_hours + transit_hours, 1)
        estimated_food = 80 if total_hours <= 8 else 150
        estimated_transport = max(20, round(travel_km * 3))
        total_budget = round(total_ticket + estimated_food + estimated_transport, 2)

        time_efficiency = max(0.0, 100 - total_hours / max(self._time_reference_hours(payload, total_hours), 1) * 100)
        richness = sum(poi.richness for poi in selected) / max(len(selected), 1)
        geo_compactness = max(0.0, 100 - travel_km * 4)
        budget_fit = max(0.0, 100 - abs(payload.budget - total_budget) / max(payload.budget, 1) * 100)
        preference_match = self._preference_match(payload, selected, strategy)

        score = (
            weights.time_efficiency * time_efficiency
            + weights.richness * richness
            + weights.geo_compactness * geo_compactness
            + weights.budget_fit * budget_fit
            + weights.preference_match * preference_match
        ) / 100

        route_style = self._route_style(payload, total_hours)
        itinerary = self._build_itinerary(selected, payload, route_style, total_hours)
        stop_highlights = self._build_stop_highlights(selected, payload)
        title = self._title_for_strategy(strategy)
        reason = self._build_reason(strategy, total_budget, total_hours, selected, payload)

        return RouteOption(
            title=title,
            strategy=strategy,
            route_style=route_style,
            score=round(score, 2),
            total_budget=total_budget,
            total_duration_hours=total_hours,
            total_travel_km=round(travel_km, 1),
            highlight_reason=reason,
            pois=poi_out,
            itinerary=itinerary,
            stop_highlights=stop_highlights,
        )

    def _build_stop_highlights(
        self,
        selected: list[PlannerPOI],
        payload: RecommendationRequest,
    ) -> list[StopHighlight]:
        highlights: list[StopHighlight] = []
        current_lat = payload.origin_latitude
        current_lon = payload.origin_longitude
        normalized_must_visits = [self._normalize_name(name) for name in payload.must_visit_names]

        for index, poi in enumerate(selected):
            tags: list[str] = []
            reason_bits: list[str] = []
            distance_from_previous = self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude)
            title = "顺路补点"
            normalized_poi = self._normalize_name(poi.name)

            is_must_visit = any(name and (name in normalized_poi or normalized_poi in name) for name in normalized_must_visits)
            if is_must_visit:
                title = "必去点已锁定"
                tags.append("必去点")
                reason_bits.append("这是你明确写下的必去点，路线会优先保证它被排进去。")
            elif index == 0:
                title = "路线起手点"
                tags.append("起手顺路")
                reason_bits.append("它适合作为从出发地切入这条线的第一站，能先把整体动线拉顺。")

            if payload.destination_name and self._destination_name_match(poi, payload.destination_name):
                title = "区域锚点核心点"
                tags.append("核心景点")
                reason_bits.append(f"它和你写下的 {payload.destination_name} 直接对应，是这条线的核心锚点。")
            elif payload.preferred_districts and poi.district in payload.preferred_districts:
                tags.append("同片区")
                reason_bits.append(f"它位于 {poi.district}，和你想去的片区更一致。")

            if distance_from_previous <= 3:
                tags.append("接驳短")
                reason_bits.append(f"和上一站直线距离约 {distance_from_previous:.1f} km，顺路串联成本低。")
            elif distance_from_previous <= 6:
                tags.append("可顺路")
                reason_bits.append(f"和上一站衔接还算紧凑，适合一起排进同一条线。")

            if poi.ticket_price == 0:
                tags.append("免门票")
                reason_bits.append("门票为 0，适合在当前预算内作为补点加入。")
            elif poi.ticket_price <= 20:
                tags.append("低门票")
                reason_bits.append(f"门票约 {poi.ticket_price:.0f} 元，预算压力较小。")

            if payload.preferences.favor_photography and self._photo_affinity(poi) >= 2:
                tags.append("拍照友好")
                reason_bits.append("它本身更适合拍照出片，和你的偏好一致。")

            if payload.preferences.avoid_crowds and self._low_crowd_affinity(poi) >= 2:
                tags.append("相对轻松")
                reason_bits.append("相对更适合走轻松节奏，能避开过于拥挤的体验。")

            if poi.richness >= 88:
                tags.append("内容丰富")
                reason_bits.append("这个点本身可玩内容更丰富，补进来能提升整条线的层次。")

            if not reason_bits:
                if payload.available_hours is None:
                    reason_bits.append("它在当前预算、路线顺序和内容丰富度上综合得分较高，适合作为顺路补点。")
                else:
                    reason_bits.append("它在当前预算、时长和路线顺序下综合得分较高，适合作为顺路补点。")

            deduped_tags = list(dict.fromkeys(tags))[:3]
            highlights.append(
                StopHighlight(
                    poi_name=poi.name,
                    reason_title=title,
                    reason_body=" ".join(dict.fromkeys(reason_bits)),
                    tags=deduped_tags,
                )
            )

            current_lat, current_lon = poi.latitude, poi.longitude

        return highlights

    def _preference_match(
        self,
        payload: RecommendationRequest,
        selected: list[PlannerPOI],
        strategy: str,
    ) -> float:
        score = 55.0
        tags = {tag for poi in selected for tag in poi.tags}

        if payload.preference_mode == "time_first" and strategy == "time_first":
            score += 15
        if payload.preference_mode == "richness_first" and strategy == "richness_first":
            score += 15
        if payload.preference_mode == "balanced" and strategy == "balanced":
            score += 15
        if payload.special_interests:
            overlap = len(tags.intersection(set(payload.special_interests)))
            score += overlap * 5
        if payload.preferences.favor_low_budget:
            average_ticket = sum(poi.ticket_price for poi in selected) / max(len(selected), 1)
            score += max(0.0, 18 - average_ticket * 0.45)
        if payload.preferences.favor_photography:
            photo_score = sum(self._photo_affinity(poi) for poi in selected) / max(len(selected), 1)
            score += min(18.0, photo_score * 4)
        if payload.preferences.avoid_crowds:
            average_popularity = sum(poi.popularity for poi in selected) / max(len(selected), 1)
            score += max(0.0, (92 - average_popularity) * 0.6)
        if selected and self._has_destination(payload):
            anchor_gap = sum(
                self._distance_km(
                    poi.latitude,
                    poi.longitude,
                    payload.destination_latitude,
                    payload.destination_longitude,
                )
                for poi in selected
            ) / max(len(selected), 1)
            score += max(0.0, 12 - anchor_gap * 1.4)
        return min(score, 100.0)

    def _title_for_strategy(self, strategy: str) -> str:
        mapping = {
            "balanced": "北京均衡体验路线",
            "time_first": "北京高效率省时路线",
            "richness_first": "北京景点丰富度优先路线",
        }
        return mapping[strategy]

    def _build_reason(
        self,
        strategy: str,
        total_budget: float,
        total_hours: float,
        selected: list[PlannerPOI],
        payload: RecommendationRequest,
    ) -> str:
        names = " - ".join(poi.name for poi in selected[:3])
        context_parts: list[str] = []
        preference_notes = self._preference_notes(payload)

        if payload.must_visit_names:
            context_parts.append(f"优先满足 { '、'.join(payload.must_visit_names[:2]) }")
        if payload.destination_name:
            context_parts.append(f"围绕 {payload.destination_name} 一带游玩")
        if preference_notes:
            context_parts.append(preference_notes)

        context_text = f"并兼顾 {'、'.join(context_parts)}，" if context_parts else ""
        if strategy == "time_first":
            return (
                f"这条路线优先压缩通勤和切换成本，{context_text}"
                f"适合希望高效率游玩的用户；核心点位包括 {names}。预计 {total_hours} 小时、约 {total_budget} 元。"
            )
        if strategy == "richness_first":
            return (
                f"这条路线优先覆盖更丰富的景点类型，{context_text}"
                f"兼顾历史、拍照和体验层次；核心点位包括 {names}。预计 {total_hours} 小时、约 {total_budget} 元。"
            )
        return (
            f"这条路线在预算、路程和景点质量之间做了均衡，{context_text}"
            f"适合第一次来北京的用户；核心点位包括 {names}。预计 {total_hours} 小时、约 {total_budget} 元。"
        )

    def _build_itinerary(
        self,
        selected: list[PlannerPOI],
        payload: RecommendationRequest,
        route_style: str,
        total_hours: float,
    ) -> list[ItineraryItem]:
        if not selected:
            return []

        day_count = self._route_day_count(route_style)
        day_start_minutes = self._route_day_start_minutes(route_style)
        daily_limit_minutes = self._daily_limit_minutes(payload, day_count, total_hours)
        current_day = 1
        current_time = day_start_minutes
        elapsed_today = 0
        current_lat = payload.origin_latitude
        current_lon = payload.origin_longitude
        itinerary: list[ItineraryItem] = []

        for poi in selected:
            transit_minutes = max(
                10 if itinerary else 0,
                round(self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude) * 6),
            )
            stay_minutes = max(45, round(poi.suggested_visit_hours * 60))
            projected_day_minutes = elapsed_today + transit_minutes + stay_minutes

            if itinerary and current_day < day_count and projected_day_minutes > daily_limit_minutes:
                current_day += 1
                current_time = self._route_day_start_minutes(route_style)
                elapsed_today = 0
                transit_minutes = 20

            start_minutes = current_time + transit_minutes
            end_minutes = start_minutes + stay_minutes

            itinerary.append(
                ItineraryItem(
                    day_index=current_day,
                    start_time=self._format_clock(start_minutes),
                    end_time=self._format_clock(end_minutes),
                    poi_name=poi.name,
                    stay_hours=round(stay_minutes / 60, 1),
                    transit_minutes_from_previous=transit_minutes,
                )
            )

            current_time = end_minutes
            elapsed_today += transit_minutes + stay_minutes
            current_lat, current_lon = poi.latitude, poi.longitude

        return itinerary

    def _poi_utility(
        self,
        poi: PlannerPOI,
        payload: RecommendationRequest,
        strategy: str,
        current_lat: float,
        current_lon: float,
    ) -> float:
        current_distance = self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude)
        utility = poi.rating * 12 + poi.richness * 0.55 + poi.popularity * 0.1
        utility += self._explicit_preference_bonus(poi, payload)
        utility += self._destination_bonus(poi, payload)
        utility += self._district_bonus(poi, payload)

        if strategy == "time_first":
            utility -= current_distance * 9
            utility -= poi.suggested_visit_hours * 4
        elif strategy == "richness_first":
            utility += poi.richness * 1.2
            utility += self._photo_affinity(poi) * 3
            utility -= current_distance * 3
        else:
            utility -= current_distance * 5
            utility += poi.richness * 0.4

        return utility

    def _explicit_preference_bonus(self, poi: PlannerPOI, payload: RecommendationRequest) -> float:
        bonus = 0.0

        if payload.preferences.favor_low_budget:
            bonus += max(0.0, 60 - poi.ticket_price) * 0.75
            if poi.ticket_price == 0:
                bonus += 10

        if payload.preferences.favor_photography:
            bonus += self._photo_affinity(poi) * 7

        if payload.preferences.avoid_crowds:
            bonus += self._low_crowd_affinity(poi) * 8
            bonus += (90 - poi.popularity) * 0.7

        return bonus

    def _destination_bonus(self, poi: PlannerPOI, payload: RecommendationRequest) -> float:
        if not self._has_destination(payload):
            return 0.0

        poi_to_anchor = self._distance_km(
            poi.latitude,
            poi.longitude,
            payload.destination_latitude,
            payload.destination_longitude,
        )
        bonus = max(0.0, 28 - poi_to_anchor * 2.4)
        if self._destination_name_match(poi, payload.destination_name):
            bonus += 22
        return bonus

    def _district_bonus(self, poi: PlannerPOI, payload: RecommendationRequest) -> float:
        if payload.preferred_districts and poi.district in payload.preferred_districts:
            return 8.0
        return 0.0

    def _reorder_route(
        self,
        selected: list[PlannerPOI],
        payload: RecommendationRequest,
    ) -> list[PlannerPOI]:
        if len(selected) <= 1:
            return selected

        remaining = list(selected)
        ordered: list[PlannerPOI] = []
        current_lat = payload.origin_latitude
        current_lon = payload.origin_longitude

        while remaining:
            best = min(
                remaining,
                key=lambda poi: self._reorder_cost(
                    poi=poi,
                    current_lat=current_lat,
                    current_lon=current_lon,
                ),
            )
            ordered.append(best)
            remaining.remove(best)
            current_lat, current_lon = best.latitude, best.longitude

        return ordered

    def _reorder_cost(
        self,
        poi: PlannerPOI,
        current_lat: float,
        current_lon: float,
    ) -> float:
        return self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude)

    def _photo_affinity(self, poi: PlannerPOI) -> float:
        tags = set(poi.tags)
        score = len(tags.intersection(self.PHOTO_TAGS)) * 1.5
        if poi.category in {"艺术街区", "园林", "公园", "街区"}:
            score += 1.2
        if "拍照" in poi.description or "观景" in poi.description:
            score += 1
        return score

    def _low_crowd_affinity(self, poi: PlannerPOI) -> float:
        tags = set(poi.tags)
        score = max(0.0, (100 - poi.popularity) / 12)
        if tags.intersection(self.LOW_CROWD_TAGS):
            score += 1.5
        if tags.intersection(self.CROWDED_TAGS):
            score -= 1
        return score

    def _preference_notes(self, payload: RecommendationRequest) -> str:
        notes: list[str] = []
        if payload.preferences.favor_low_budget:
            notes.append("控制预算")
        if payload.preferences.favor_photography:
            notes.append("拍照出片")
        if payload.preferences.avoid_crowds:
            notes.append("避开高人流")
        return "、".join(notes)

    def _has_destination(self, payload: RecommendationRequest) -> bool:
        return payload.destination_latitude is not None and payload.destination_longitude is not None

    def _destination_name_match(self, poi: PlannerPOI, destination_name: str | None) -> bool:
        if not destination_name:
            return False
        normalized_destination = self._normalize_name(destination_name)
        normalized_poi = self._normalize_name(poi.name)
        return bool(normalized_destination) and bool(normalized_poi) and (
            normalized_destination in normalized_poi or normalized_poi in normalized_destination
        )

    def _normalize_name(self, value: str) -> str:
        return "".join(ch for ch in value if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")

    def _match_score(self, requested: str, candidate: str) -> int:
        if not requested or not candidate:
            return 0
        if requested == candidate:
            return 1000

        score = 0
        if candidate.startswith(requested):
            score += 220
        if candidate.endswith(requested):
            score += 120
        if requested in candidate:
            score += 80
        if candidate in requested:
            score += 40

        overlap = len(set(requested).intersection(set(candidate)))
        score += overlap * 8
        score -= abs(len(candidate) - len(requested)) * 10
        return score

    def _route_style(self, payload: RecommendationRequest, total_hours: float) -> str:
        if (payload.travel_days is not None and payload.travel_days >= 2) or (
            payload.available_hours is not None and payload.available_hours >= 11
        ):
            return "周末两日线"
        if payload.available_hours is not None and payload.available_hours <= 5:
            return "轻松半日线"
        if payload.available_hours is None:
            if total_hours >= 11:
                return "周末两日线"
            if total_hours <= 5:
                return "轻松半日线"
        return "一日暴走线"

    def _route_day_count(self, route_style: str) -> int:
        return 2 if route_style == "周末两日线" else 1

    def _route_day_start_minutes(self, route_style: str) -> int:
        if route_style == "轻松半日线":
            return 14 * 60
        if route_style == "周末两日线":
            return 10 * 60
        return 9 * 60 + 30

    def _daily_limit_minutes(self, payload: RecommendationRequest, day_count: int, total_hours: float) -> int:
        reference_hours = payload.available_hours if payload.available_hours is not None else total_hours
        available = max(180, round(reference_hours * 60 / max(day_count, 1)))
        return min(available, 8 * 60)

    def _time_limit_exceeded(self, payload: RecommendationRequest, projected_hours: float) -> bool:
        return payload.available_hours is not None and projected_hours > payload.available_hours

    def _transit_limit_exceeded(self, payload: RecommendationRequest, transit_minutes: float) -> bool:
        return payload.max_transit_minutes_per_leg is not None and transit_minutes > payload.max_transit_minutes_per_leg

    def _time_reference_hours(self, payload: RecommendationRequest, total_hours: float) -> float:
        if payload.available_hours is not None:
            return payload.available_hours
        return max(total_hours + 2, 8)

    def _format_clock(self, total_minutes: int) -> str:
        hours = (total_minutes // 60) % 24
        minutes = total_minutes % 60
        return f"{hours:02d}:{minutes:02d}"

    def _distance_km(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        radius = 6371.0
        d_lat = radians(lat2 - lat1)
        d_lon = radians(lon2 - lon1)
        a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
        c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return radius * c
