from __future__ import annotations

from dataclasses import dataclass
from math import atan2, cos, radians, sin, sqrt
from collections.abc import Sequence

from app.models.poi import PointOfInterest
from app.schemas.recommendation import (
    POIOut,
    PreferenceWeights,
    RecommendationRequest,
    RouteOption,
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

class BeijingRoutePlanner:
    def recommend(
        self,
        payload: RecommendationRequest,
        pois: Sequence[PointOfInterest],
    ) -> list[RouteOption]:
        weights = PreferenceWeights.from_user_preferences(payload.preferences)
        planner_pois = [self._from_model(item) for item in pois]
        candidates = self._filter_candidates(payload, planner_pois)
        strategies = ("balanced", "time_first", "richness_first")

        route_options: list[RouteOption] = []
        for strategy in strategies:
            selected = self._build_route(candidates, payload, strategy)
            if not selected:
                continue
            route_options.append(self._build_option(selected, payload, weights, strategy))

        route_options.sort(key=lambda item: item.score, reverse=True)
        return route_options

    def _filter_candidates(
        self,
        payload: RecommendationRequest,
        pois: Sequence[PlannerPOI],
    ) -> list[PlannerPOI]:
        items: list[PlannerPOI] = []
        for poi in pois:
            if payload.preferred_districts and poi.district not in payload.preferred_districts:
                continue
            if payload.categories and poi.category not in payload.categories:
                continue
            if poi.ticket_price > payload.budget * 0.6:
                continue
            items.append(poi)
        return items

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
    ) -> list[PlannerPOI]:
        scored: list[tuple[float, PlannerPOI]] = []
        for poi in candidates:
            distance = self._distance_km(payload.origin_latitude, payload.origin_longitude, poi.latitude, poi.longitude)
            transit_minutes = distance * 6
            if transit_minutes > payload.max_transit_minutes_per_leg:
                continue

            utility = poi.rating * 10 + poi.richness * 0.5 + poi.popularity * 0.2
            if strategy == "time_first":
                utility -= distance * 8
            elif strategy == "richness_first":
                utility += poi.richness * 0.8
            else:
                utility -= distance * 4
            scored.append((utility, poi))

        ranked = [poi for _, poi in sorted(scored, key=lambda item: item[0], reverse=True)]

        selected: list[PlannerPOI] = []
        total_budget = 0.0
        total_hours = 0.0
        current_lat = payload.origin_latitude
        current_lon = payload.origin_longitude

        for poi in ranked:
            transit_hours = self._distance_km(current_lat, current_lon, poi.latitude, poi.longitude) / 10
            projected_hours = total_hours + transit_hours + poi.suggested_visit_hours
            projected_budget = total_budget + poi.ticket_price

            if projected_hours > payload.available_hours:
                continue
            if projected_budget > payload.budget:
                continue

            selected.append(poi)
            total_hours = projected_hours
            total_budget = projected_budget
            current_lat, current_lon = poi.latitude, poi.longitude

            if len(selected) >= payload.max_poi_count:
                break

        return selected

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

        time_efficiency = max(0.0, 100 - total_hours / max(payload.available_hours, 1) * 100)
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

        title = self._title_for_strategy(strategy)
        reason = self._build_reason(strategy, total_budget, total_hours, selected)

        return RouteOption(
            title=title,
            strategy=strategy,
            score=round(score, 2),
            total_budget=total_budget,
            total_duration_hours=total_hours,
            total_travel_km=round(travel_km, 1),
            highlight_reason=reason,
            pois=poi_out,
        )

    def _preference_match(
        self,
        payload: RecommendationRequest,
        selected: list[PlannerPOI],
        strategy: str,
    ) -> float:
        score = 70.0
        tags = {tag for poi in selected for tag in poi.tags}

        if payload.preference_mode == "time_first" and strategy == "time_first":
            score += 20
        if payload.preference_mode == "richness_first" and strategy == "richness_first":
            score += 20
        if payload.preference_mode == "balanced" and strategy == "balanced":
            score += 20
        if payload.special_interests:
            overlap = len(tags.intersection(set(payload.special_interests)))
            score += overlap * 5
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
    ) -> str:
        names = " - ".join(poi.name for poi in selected[:3])
        if strategy == "time_first":
            return f"这条路线优先压缩通勤和切换成本，适合希望高效率游玩的用户；核心点位包括 {names}。预计 {total_hours} 小时、约 {total_budget} 元。"
        if strategy == "richness_first":
            return f"这条路线优先覆盖更丰富的景点类型，兼顾历史、拍照和体验层次；核心点位包括 {names}。预计 {total_hours} 小时、约 {total_budget} 元。"
        return f"这条路线在预算、路程和景点质量之间做了均衡，适合第一次来北京的用户；核心点位包括 {names}。预计 {total_hours} 小时、约 {total_budget} 元。"

    def _distance_km(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        radius = 6371.0
        d_lat = radians(lat2 - lat1)
        d_lon = radians(lon2 - lon1)
        a = (
            sin(d_lat / 2) ** 2
            + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
        )
        c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return radius * c
