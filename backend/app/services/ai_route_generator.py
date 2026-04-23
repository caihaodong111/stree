import json
import logging
from dataclasses import dataclass

from app.models.poi import PointOfInterest
from app.planners.beijing_route_planner import BeijingRoutePlanner, PlannerPOI
from app.schemas.ai import AIGeneratedRouteOption, AIGeneratedRoutePlan
from app.schemas.recommendation import PreferenceWeights, RecommendationRequest, RouteOption, StopHighlight
from app.services.llm_client import LLMClientError, OpenAICompatibleLLMClient
from app.services.live_route_service import LiveRouteService, RouteFacts


logger = logging.getLogger("app.ai.route_generator")


@dataclass(frozen=True)
class AIRouteGenerationOutcome:
    recommendation_summary: str
    route_options: list[RouteOption]
    matched_must_visit_names: list[str]
    missing_must_visit_names: list[str]


class AIRouteGenerator:
    STRATEGIES = ("balanced", "time_first", "richness_first")
    CANDIDATES_PER_STRATEGY = 4
    MAX_SHORTLIST_SIZE = 8

    def __init__(self) -> None:
        self.client = OpenAICompatibleLLMClient()
        self.planner = BeijingRoutePlanner()
        self.live_route_service = LiveRouteService()

    def generate(
        self,
        payload: RecommendationRequest,
        pois: list[PointOfInterest | PlannerPOI],
    ) -> AIRouteGenerationOutcome | None:
        if not self.client.enabled:
            logger.warning("generate skipped llm_disabled")
            return None

        planner_pois = self.planner.to_planner_pois(pois)
        must_visit_pois, missing_must_visits = self.planner._resolve_must_visit_pois(payload.must_visit_names, planner_pois)
        candidates = self.planner._filter_candidates(payload, planner_pois, must_visit_pois)
        shortlist = self._build_shortlist(payload, candidates, must_visit_pois)
        logger.info(
            "generate start model=%s pois=%s candidates=%s shortlist=%s must_visit_matched=%s must_visit_missing=%s",
            self.client.model,
            len(planner_pois),
            len(candidates),
            len(shortlist),
            len(must_visit_pois),
            len(missing_must_visits),
        )
        if not shortlist:
            logger.warning("generate empty_shortlist model=%s", self.client.model)
            return None

        raw = self._request_route_plan(payload, shortlist, must_visit_pois, missing_must_visits)
        if raw is None:
            logger.warning("generate route_plan_none model=%s", self.client.model)
            return None

        route_options = self._materialize_route_options(
            payload=payload,
            candidates=candidates,
            generated=raw.route_options,
            must_visit_pois=must_visit_pois,
        )
        if not route_options:
            logger.warning("generate no_materialized_routes model=%s raw_routes=%s", self.client.model, len(raw.route_options))
            return None

        missing_from_ai = [name for name in raw.missing_must_visit_names if name.strip()]
        effective_missing = list(dict.fromkeys(missing_must_visits + missing_from_ai))
        matched_names = [poi.name for poi in must_visit_pois if poi.name not in effective_missing]
        summary = raw.recommendation_summary.strip()
        if not summary:
            logger.warning("generate empty_summary model=%s", self.client.model)
            return None

        logger.info(
            "generate success model=%s route_count=%s matched=%s missing=%s",
            self.client.model,
            len(route_options),
            len(matched_names),
            len(effective_missing),
        )
        return AIRouteGenerationOutcome(
            recommendation_summary=summary,
            route_options=route_options,
            matched_must_visit_names=matched_names,
            missing_must_visit_names=effective_missing,
        )

    def _request_route_plan(
        self,
        payload: RecommendationRequest,
        shortlist: list[PlannerPOI],
        must_visit_pois: list[PlannerPOI],
        missing_must_visits: list[str],
    ) -> AIGeneratedRoutePlan | None:
        system_prompt = (
            "你是北京旅行路线设计助手。"
            "基于用户条件和候选景点生成 1 到 3 个可落地方案。"
            "候选景点只是可选素材，不代表用户已指定；只有 must_visit_names 才是硬约束。"
            "只能使用候选池里的景点，poi_names 必须逐字复用候选名称。"
            "不要虚构景点、坐标、门票、时长、距离、营业信息或交通事实。"
            "strategy 只能是 balanced、time_first、richness_first。"
            "每个方案要尽量顺路，并尽量满足预算、时长、点位数上限。"
            "如果无法满足某个必去点，把它写进 missing_must_visit_names。"
            "只输出一个 JSON 对象，不要 Markdown，不要解释，不要推理过程。"
            'JSON: {"recommendation_summary":"","missing_must_visit_names":[],"route_options":[{"strategy":"","title":"","highlight_reason":"","poi_names":[],"stop_highlights":[{"poi_name":"","reason_title":"","reason_body":"","tags":[]}]}]}'
        )
        user_prompt = json.dumps(
            {
                "request": self._compact_request(payload),
                "resolved_constraints": {
                    "matched_must_visit_names": [poi.name for poi in must_visit_pois],
                    "missing_must_visit_names": missing_must_visits,
                },
                "candidate_pois": self._compact_candidates(payload, shortlist),
            },
            ensure_ascii=False,
        )

        try:
            raw = self.client.chat_json(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=0.0,
                max_tokens=1400,
            )
        except LLMClientError as exc:
            logger.warning("request_route_plan llm_error model=%s error=%s", self.client.model, exc)
            return None

        try:
            return AIGeneratedRoutePlan.model_validate(self._normalize_model_route_payload(raw))
        except Exception as exc:
            logger.warning("request_route_plan validate_failed model=%s error=%s raw_keys=%s", self.client.model, exc, list(raw.keys()))
            return None

    def _build_shortlist(
        self,
        payload: RecommendationRequest,
        candidates: list[PlannerPOI],
        must_visit_pois: list[PlannerPOI],
    ) -> list[PlannerPOI]:
        selected: dict[int, PlannerPOI] = {poi.id: poi for poi in must_visit_pois}
        current_lat = payload.origin_latitude
        current_lon = payload.origin_longitude

        for strategy in self.STRATEGIES:
            ranked = sorted(
                candidates,
                key=lambda poi: self.planner._poi_utility(
                    poi=poi,
                    payload=payload,
                    strategy=strategy,
                    current_lat=current_lat,
                    current_lon=current_lon,
                ),
                reverse=True,
            )
            for poi in ranked[: self.CANDIDATES_PER_STRATEGY]:
                selected[poi.id] = poi

        for poi in candidates[: self.CANDIDATES_PER_STRATEGY]:
            selected[poi.id] = poi

        ordered = list(selected.values())
        ordered.sort(
            key=lambda poi: self.planner._poi_utility(
                poi=poi,
                payload=payload,
                strategy=payload.preference_mode,
                current_lat=current_lat,
                current_lon=current_lon,
            ),
            reverse=True,
        )
        return ordered[: self.MAX_SHORTLIST_SIZE]

    def _materialize_route_options(
        self,
        *,
        payload: RecommendationRequest,
        candidates: list[PlannerPOI],
        generated: list[AIGeneratedRouteOption],
        must_visit_pois: list[PlannerPOI],
    ) -> list[RouteOption]:
        if not generated:
            return []

        candidate_map = self._build_candidate_map(candidates)
        weights = PreferenceWeights.from_user_preferences(payload.preferences)
        route_options: list[RouteOption] = []
        seen_strategies: set[str] = set()

        for item in generated:
            if item.strategy not in self.STRATEGIES or item.strategy in seen_strategies:
                continue

            selected = self._resolve_selected_pois(
                requested_names=item.poi_names,
                candidate_map=candidate_map,
                must_visit_pois=must_visit_pois,
                max_poi_count=payload.max_poi_count or 0,
            )
            selected = self._fit_sequence_to_constraints(payload, selected, must_visit_pois)
            if not selected:
                continue

            base_option = self.planner._build_option(selected, payload, weights, item.strategy)
            live_facts = self.live_route_service.measure_sequence(payload, selected)
            if live_facts is not None:
                base_option = self._apply_live_route_facts(base_option, selected, live_facts)
            stop_highlights = self._resolve_stop_highlights(item, selected)
            route_options.append(
                base_option.model_copy(
                    update={
                        "title": item.title.strip() or base_option.title,
                        "highlight_reason": item.highlight_reason.strip() or base_option.highlight_reason,
                        "stop_highlights": stop_highlights or base_option.stop_highlights,
                    }
                )
            )
            seen_strategies.add(item.strategy)

        route_options.sort(key=lambda option: option.score, reverse=True)
        return route_options

    def _build_candidate_map(self, shortlist: list[PlannerPOI]) -> dict[str, PlannerPOI]:
        candidate_map: dict[str, PlannerPOI] = {}
        for poi in shortlist:
            candidate_map[poi.name] = poi
            candidate_map[self.planner._normalize_name(poi.name)] = poi
        return candidate_map

    def _resolve_selected_pois(
        self,
        *,
        requested_names: list[str],
        candidate_map: dict[str, PlannerPOI],
        must_visit_pois: list[PlannerPOI],
        max_poi_count: int,
    ) -> list[PlannerPOI]:
        ordered: list[PlannerPOI] = []
        seen_ids: set[int] = set()

        for raw_name in requested_names:
            name = raw_name.strip()
            if not name:
                continue
            poi = candidate_map.get(name) or candidate_map.get(self.planner._normalize_name(name))
            if poi is None:
                poi = self._fuzzy_match_candidate(name, candidate_map.values())
            if poi is None or poi.id in seen_ids:
                continue
            ordered.append(poi)
            seen_ids.add(poi.id)

        for poi in must_visit_pois:
            if poi.id in seen_ids:
                continue
            ordered.append(poi)
            seen_ids.add(poi.id)

        if max_poi_count > 0:
            ordered = ordered[:max_poi_count]
        return ordered

    def _fit_sequence_to_constraints(
        self,
        payload: RecommendationRequest,
        selected: list[PlannerPOI],
        must_visit_pois: list[PlannerPOI],
    ) -> list[PlannerPOI]:
        if not selected:
            return []

        must_visit_ids = {poi.id for poi in must_visit_pois}
        candidate = list(selected)
        while candidate:
            live_facts = self.live_route_service.measure_sequence(payload, candidate)
            if self._sequence_is_feasible(payload, candidate, live_facts):
                return candidate
            removable_indexes = [index for index, poi in enumerate(candidate) if poi.id not in must_visit_ids]
            if not removable_indexes:
                return []
            candidate.pop(removable_indexes[-1])

        return []

    def _sequence_is_feasible(
        self,
        payload: RecommendationRequest,
        selected: list[PlannerPOI],
        live_facts: RouteFacts | None = None,
    ) -> bool:
        if live_facts is not None:
            total_visit_hours = sum(poi.suggested_visit_hours for poi in selected)
            total_hours = total_visit_hours + live_facts.total_duration_minutes / 60
            total_ticket = sum(poi.ticket_price for poi in selected)
            estimated_food = 80 if total_hours <= 8 else 150
            total_budget = total_ticket + live_facts.total_price + estimated_food
            if (
                payload.max_transit_minutes_per_leg is not None
                and live_facts.max_leg_minutes > payload.max_transit_minutes_per_leg
            ):
                return False
            if (payload.available_hours is not None and total_hours > payload.available_hours) or total_budget > payload.budget:
                return False
            return True

        total_budget = 0.0
        total_hours = 0.0
        current_lat = payload.origin_latitude
        current_lon = payload.origin_longitude

        for poi in selected:
            distance = self.planner._distance_km(current_lat, current_lon, poi.latitude, poi.longitude)
            transit_minutes = distance * 6
            if (
                payload.max_transit_minutes_per_leg is not None
                and transit_minutes > payload.max_transit_minutes_per_leg
            ):
                return False

            total_hours += distance / 10 + poi.suggested_visit_hours
            total_budget += poi.ticket_price
            if (payload.available_hours is not None and total_hours > payload.available_hours) or total_budget > payload.budget:
                return False

            current_lat, current_lon = poi.latitude, poi.longitude

        return True

    def _apply_live_route_facts(
        self,
        route_option: RouteOption,
        selected: list[PlannerPOI],
        live_facts: RouteFacts,
    ) -> RouteOption:
        total_visit_hours = sum(poi.suggested_visit_hours for poi in selected)
        total_hours = round(total_visit_hours + live_facts.total_duration_minutes / 60, 1)
        total_ticket = sum(poi.ticket_price for poi in selected)
        estimated_food = 80 if total_hours <= 8 else 150
        total_budget = round(total_ticket + estimated_food + live_facts.total_price, 2)
        return route_option.model_copy(
            update={
                "total_duration_hours": total_hours,
                "total_travel_km": round(live_facts.total_distance_meters / 1000, 1),
                "total_budget": total_budget,
            }
        )

    def _fuzzy_match_candidate(self, name: str, candidates: list[PlannerPOI]) -> PlannerPOI | None:
        normalized_name = self.planner._normalize_name(name)
        if not normalized_name:
            return None

        matches = [
            poi
            for poi in candidates
            if normalized_name in self.planner._normalize_name(poi.name)
            or self.planner._normalize_name(poi.name) in normalized_name
        ]
        if not matches:
            return None

        return max(matches, key=lambda poi: (poi.rating, poi.richness, poi.popularity))

    def _resolve_stop_highlights(
        self,
        item: AIGeneratedRouteOption,
        selected: list[PlannerPOI],
    ) -> list[StopHighlight]:
        selected_names = {poi.name for poi in selected}
        highlights: list[StopHighlight] = []

        for highlight in item.stop_highlights:
            if highlight.poi_name not in selected_names:
                continue
            reason_title = highlight.reason_title.strip()
            reason_body = highlight.reason_body.strip()
            if not reason_title or not reason_body:
                continue
            highlights.append(
                StopHighlight(
                    poi_name=highlight.poi_name,
                    reason_title=reason_title,
                    reason_body=reason_body,
                    tags=list(dict.fromkeys(tag.strip() for tag in highlight.tags if tag.strip()))[:3],
                )
            )

        return highlights

    def _compact_request(self, payload: RecommendationRequest) -> dict[str, object]:
        return {
            "origin_name": payload.origin_name,
            "destination_name": payload.destination_name,
            "must_visit_names": payload.must_visit_names,
            "preferred_districts": payload.preferred_districts,
            "budget": payload.budget,
            "available_hours": payload.available_hours,
            "travel_days": payload.travel_days,
            "preference_mode": payload.preference_mode,
            "preferences": payload.preferences.model_dump(mode="json"),
            "special_interests": payload.special_interests,
            "max_poi_count": payload.max_poi_count,
            "max_transit_minutes_per_leg": payload.max_transit_minutes_per_leg,
        }

    def _compact_candidates(
        self,
        payload: RecommendationRequest,
        shortlist: list[PlannerPOI],
    ) -> list[dict[str, object]]:
        items: list[dict[str, object]] = []
        for poi in shortlist:
            items.append(
                {
                    "name": poi.name,
                    "district": poi.district,
                    "category": poi.category,
                    "ticket_price": round(poi.ticket_price, 1),
                    "suggested_visit_hours": round(poi.suggested_visit_hours, 1),
                    "rating": round(poi.rating, 1),
                    "distance_from_origin_km": round(
                        self.planner._distance_km(
                            payload.origin_latitude,
                            payload.origin_longitude,
                            poi.latitude,
                            poi.longitude,
                        ),
                        1,
                    ),
                    "tags": list(poi.tags)[:4],
                }
            )
        return items

    def _normalize_model_route_payload(self, payload: dict) -> dict:
        normalized = dict(payload)
        alias_map = {
            "summary": "recommendation_summary",
            "route_summary": "recommendation_summary",
            "missing_required_names": "missing_must_visit_names",
            "missing_must_visits": "missing_must_visit_names",
            "routes": "route_options",
            "plans": "route_options",
        }
        for source_key, target_key in alias_map.items():
            if target_key not in normalized and source_key in normalized:
                normalized[target_key] = normalized[source_key]

        route_options = normalized.get("route_options")
        if isinstance(route_options, list):
            normalized["route_options"] = [self._normalize_model_route_option(item) for item in route_options]

        return normalized

    def _normalize_model_route_option(self, item: object) -> dict:
        if not isinstance(item, dict):
            return {}

        normalized = dict(item)
        alias_map = {
            "route_title": "title",
            "reason": "highlight_reason",
            "poi_list": "poi_names",
            "pois": "poi_names",
            "highlights": "stop_highlights",
        }
        for source_key, target_key in alias_map.items():
            if target_key not in normalized and source_key in normalized:
                normalized[target_key] = normalized[source_key]

        stop_highlights = normalized.get("stop_highlights")
        if isinstance(stop_highlights, list):
            normalized["stop_highlights"] = [self._normalize_stop_highlight(item) for item in stop_highlights]

        return normalized

    def _normalize_stop_highlight(self, item: object) -> dict:
        if not isinstance(item, dict):
            return {}

        normalized = dict(item)
        alias_map = {
            "name": "poi_name",
            "title": "reason_title",
            "reason": "reason_body",
        }
        for source_key, target_key in alias_map.items():
            if target_key not in normalized and source_key in normalized:
                normalized[target_key] = normalized[source_key]

        return normalized
