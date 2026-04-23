from __future__ import annotations

import logging
from collections.abc import Iterable

import httpx
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.poi import PointOfInterest
from app.planners.beijing_route_planner import BeijingRoutePlanner, PlannerPOI
from app.repositories.poi_repository import POIRepository
from app.schemas.recommendation import RecommendationRequest


logger = logging.getLogger("app.ai.live_poi")


class LivePOIService:
    BASE_URL = "https://restapi.amap.com"
    DEFAULT_RADIUS_METERS = 22000
    SEARCH_OFFSET = 10
    MAX_CANDIDATES = 24
    MIN_LIVE_CANDIDATES = 8

    def __init__(self) -> None:
        self.key = settings.amap_web_service_key
        self.city = settings.amap_transit_city
        self.repository = POIRepository()
        self.planner = BeijingRoutePlanner()

    def list_candidates(
        self,
        payload: RecommendationRequest,
        db: Session,
    ) -> list[PlannerPOI]:
        cached_models = list(self.repository.list_all(db))
        cached_pois = self.planner.to_planner_pois(cached_models)
        if not self.key:
            logger.warning("list_candidates fallback reason=missing_amap_key cached=%s", len(cached_pois))
            return cached_pois

        live_items: list[dict] = []
        try:
            with httpx.Client(timeout=8.0) as client:
                for name in payload.must_visit_names:
                    live_items.extend(self._search_text(client, keywords=name, district_hint=self._primary_district(payload)))

                for district in payload.preferred_districts[:2]:
                    live_items.extend(self._search_text(client, keywords=f"{district} 景点", district_hint=district, pages=2))

                live_items.extend(
                    self._search_around(
                        client,
                        longitude=payload.origin_longitude,
                        latitude=payload.origin_latitude,
                        radius=self.DEFAULT_RADIUS_METERS,
                    )
                )
        except Exception as exc:
            logger.warning("list_candidates fallback reason=amap_error error=%s cached=%s", exc, len(cached_pois))
            return cached_pois

        live_candidates = self._materialize_candidates(
            payload=payload,
            live_items=live_items,
            cached_models=cached_models,
        )
        if len(live_candidates) < max(self.MIN_LIVE_CANDIDATES, len(payload.must_visit_names) + 3):
            live_candidates = self._top_up_from_cache(payload, live_candidates, cached_pois)

        if not live_candidates:
            logger.warning("list_candidates fallback reason=empty_live_candidates cached=%s", len(cached_pois))
            return cached_pois

        logger.info(
            "list_candidates success live=%s cached=%s must_visit=%s districts=%s",
            len(live_candidates),
            len(cached_pois),
            len(payload.must_visit_names),
            len(payload.preferred_districts),
        )
        return live_candidates[: self.MAX_CANDIDATES]

    def _search_text(
        self,
        client: httpx.Client,
        *,
        keywords: str,
        district_hint: str | None = None,
        pages: int = 1,
    ) -> list[dict]:
        items: list[dict] = []
        for page in range(1, pages + 1):
            payload = self._request(
                client,
                "/v3/place/text",
                {
                    "keywords": keywords,
                    "city": self.city,
                    "citylimit": "true",
                    "offset": str(self.SEARCH_OFFSET),
                    "page": str(page),
                    "extensions": "all",
                },
            )
            pois = payload.get("pois") or []
            if not pois:
                break
            items.extend(self._filter_live_items(pois, district_hint=district_hint, requested_name=keywords))
            if len(pois) < self.SEARCH_OFFSET:
                break
        return items

    def _search_around(
        self,
        client: httpx.Client,
        *,
        longitude: float,
        latitude: float,
        radius: int,
    ) -> list[dict]:
        payload = self._request(
            client,
            "/v3/place/around",
            {
                "location": f"{longitude},{latitude}",
                "keywords": "景点",
                "radius": str(radius),
                "offset": "15",
                "page": "1",
                "sortrule": "distance",
                "extensions": "all",
            },
        )
        return list(payload.get("pois") or [])

    def _request(
        self,
        client: httpx.Client,
        path: str,
        params: dict[str, str],
    ) -> dict:
        response = client.get(
            f"{self.BASE_URL}{path}",
            params={
                "key": self.key,
                "output": "json",
                **params,
            },
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("status") != "1":
            raise RuntimeError(str(payload.get("info") or f"AMap request failed for {path}"))
        return payload

    def _filter_live_items(
        self,
        items: Iterable[dict],
        *,
        district_hint: str | None,
        requested_name: str,
    ) -> list[dict]:
        normalized_name = self.planner._normalize_name(requested_name)
        filtered: list[dict] = []
        for item in items:
            name = str(item.get("name") or "").strip()
            if not name or not item.get("location"):
                continue
            adname = str(item.get("adname") or "").strip()
            if district_hint and district_hint not in adname:
                continue
            normalized_candidate = self.planner._normalize_name(name)
            if normalized_name and "景点" not in requested_name:
                if normalized_name not in normalized_candidate and normalized_candidate not in normalized_name:
                    continue
            filtered.append(item)
        return filtered or list(items)

    def _materialize_candidates(
        self,
        *,
        payload: RecommendationRequest,
        live_items: list[dict],
        cached_models: list[PointOfInterest],
    ) -> list[PlannerPOI]:
        candidates: list[PlannerPOI] = []
        seen_names: set[str] = set()
        next_id = -1

        for item in live_items:
            poi = self._to_planner_poi(item=item, cached_models=cached_models, synthetic_id=next_id)
            if poi is None:
                continue
            normalized_name = self.planner._normalize_name(poi.name)
            if normalized_name in seen_names:
                continue
            seen_names.add(normalized_name)
            candidates.append(poi)
            next_id -= 1

        candidates.sort(
            key=lambda poi: (
                self._must_visit_rank(payload.must_visit_names, poi.name),
                self._district_rank(payload.preferred_districts, poi.district),
                self.planner._poi_utility(
                    poi=poi,
                    payload=payload,
                    strategy=payload.preference_mode,
                    current_lat=payload.origin_latitude,
                    current_lon=payload.origin_longitude,
                ),
            ),
            reverse=True,
        )
        return candidates

    def _to_planner_poi(
        self,
        *,
        item: dict,
        cached_models: list[PointOfInterest],
        synthetic_id: int,
    ) -> PlannerPOI | None:
        location = str(item.get("location") or "").strip()
        if not location:
            return None
        try:
            longitude_str, latitude_str = location.split(",")
            longitude = round(float(longitude_str), 6)
            latitude = round(float(latitude_str), 6)
        except ValueError:
            return None

        name = str(item.get("name") or "").strip()
        if not name:
            return None

        cached = self._match_cached(name, cached_models)
        raw_type = str(item.get("type") or "").strip()
        category = cached.category if cached else (raw_type.split(";")[0] if raw_type else "景点")
        district = str(item.get("adname") or "").strip() or (cached.district if cached else self.city)
        address = str(item.get("address") or "").strip()
        biz_ext = item.get("biz_ext") or {}
        rating = self._safe_float(biz_ext.get("rating"))
        cost = self._safe_float(biz_ext.get("cost"))
        tags = self._build_tags(raw_type, district)

        return PlannerPOI(
            id=cached.id if cached else synthetic_id,
            name=cached.name if cached else name,
            district=cached.district if cached else district,
            category=category,
            latitude=cached.latitude if cached else latitude,
            longitude=cached.longitude if cached else longitude,
            ticket_price=cached.ticket_price if cached else (cost if cost is not None and cost >= 0 else 0.0),
            suggested_visit_hours=cached.suggested_visit_hours if cached else self._guess_visit_hours(name, raw_type),
            rating=cached.rating if cached else (rating if rating is not None else 4.4),
            popularity=cached.popularity if cached else self._guess_popularity(name, rating),
            richness=cached.richness if cached else self._guess_richness(raw_type),
            tags=tuple(cached.tags if cached and cached.tags else tags),
            description=cached.description if cached and cached.description else address or raw_type or "来自高德实时检索",
        )

    def _match_cached(
        self,
        live_name: str,
        cached_models: list[PointOfInterest],
    ) -> PointOfInterest | None:
        normalized_live = self.planner._normalize_name(live_name)
        if not normalized_live:
            return None

        best: PointOfInterest | None = None
        best_score = -1
        for item in cached_models:
            normalized_cached = self.planner._normalize_name(item.name)
            if normalized_live not in normalized_cached and normalized_cached not in normalized_live:
                continue
            score = self.planner._match_score(normalized_live, normalized_cached)
            if score > best_score:
                best = item
                best_score = score
        return best

    def _top_up_from_cache(
        self,
        payload: RecommendationRequest,
        live_candidates: list[PlannerPOI],
        cached_pois: list[PlannerPOI],
    ) -> list[PlannerPOI]:
        existing_names = {self.planner._normalize_name(item.name) for item in live_candidates}
        supplemented = list(live_candidates)

        filtered_cache = [
            poi
            for poi in cached_pois
            if self.planner._normalize_name(poi.name) not in existing_names
            and (not payload.preferred_districts or poi.district in payload.preferred_districts or self._must_visit_rank(payload.must_visit_names, poi.name))
        ]
        filtered_cache.sort(
            key=lambda poi: self.planner._poi_utility(
                poi=poi,
                payload=payload,
                strategy=payload.preference_mode,
                current_lat=payload.origin_latitude,
                current_lon=payload.origin_longitude,
            ),
            reverse=True,
        )
        supplemented.extend(filtered_cache[: max(0, self.MAX_CANDIDATES - len(supplemented))])
        return supplemented

    def _build_tags(self, raw_type: str, district: str) -> list[str]:
        tags = [item.strip() for item in raw_type.split(";") if item.strip()]
        if district:
            tags.append(district)
        return list(dict.fromkeys(tags))[:4]

    def _guess_visit_hours(self, name: str, raw_type: str) -> float:
        combined = f"{name} {raw_type}"
        if any(keyword in combined for keyword in ("博物馆", "故宫", "陵", "长城", "环球", "乐园")):
            return 3.5
        if any(keyword in combined for keyword in ("公园", "胡同", "街区", "园林")):
            return 2.5
        return 2.0

    def _guess_popularity(self, name: str, rating: float | None) -> int:
        base = 78 if rating is None else round(min(5.0, rating) / 5 * 100)
        if any(keyword in name for keyword in ("故宫", "长城", "天坛", "颐和园", "十三陵")):
            base += 8
        return min(98, max(60, base))

    def _guess_richness(self, raw_type: str) -> int:
        if any(keyword in raw_type for keyword in ("博物馆", "风景名胜", "公园")):
            return 82
        return 74

    def _must_visit_rank(self, must_visits: list[str], name: str) -> int:
        normalized_name = self.planner._normalize_name(name)
        for raw_name in must_visits:
            normalized_must = self.planner._normalize_name(raw_name)
            if normalized_must and (normalized_must in normalized_name or normalized_name in normalized_must):
                return 1
        return 0

    def _district_rank(self, districts: list[str], district: str) -> int:
        return 1 if district and district in districts else 0

    def _primary_district(self, payload: RecommendationRequest) -> str | None:
        return payload.preferred_districts[0] if payload.preferred_districts else None

    def _safe_float(self, value: object) -> float | None:
        if value in (None, "", []):
            return None
        try:
            return round(float(value), 2)
        except (TypeError, ValueError):
            return None
