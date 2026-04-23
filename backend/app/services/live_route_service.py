from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from app.core.config import settings
from app.planners.beijing_route_planner import PlannerPOI
from app.schemas.recommendation import RecommendationRequest


logger = logging.getLogger("app.ai.live_route")


@dataclass(frozen=True)
class RouteFacts:
    total_duration_minutes: int
    total_distance_meters: int
    total_price: float
    max_leg_minutes: int


class LiveRouteService:
    BASE_URL = "https://restapi.amap.com"

    def __init__(self) -> None:
        self.key = settings.amap_web_service_key
        self.city = settings.amap_transit_city
        self._cache: dict[tuple[float, float, float, float], tuple[int, int, float]] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.key)

    def measure_sequence(
        self,
        payload: RecommendationRequest,
        selected: list[PlannerPOI],
    ) -> RouteFacts | None:
        if not self.enabled or not selected:
            return None

        total_duration = 0
        total_distance = 0
        total_price = 0.0
        max_leg_minutes = 0
        previous = (payload.origin_longitude, payload.origin_latitude)

        try:
            with httpx.Client(timeout=12.0) as client:
                for poi in selected:
                    duration, distance, price = self._plan_leg(
                        client,
                        start=previous,
                        end=(poi.longitude, poi.latitude),
                    )
                    total_duration += duration
                    total_distance += distance
                    total_price += price
                    max_leg_minutes = max(max_leg_minutes, duration)
                    previous = (poi.longitude, poi.latitude)
        except Exception as exc:
            logger.warning("measure_sequence failed error=%s", exc)
            return None

        return RouteFacts(
            total_duration_minutes=total_duration,
            total_distance_meters=total_distance,
            total_price=round(total_price, 2),
            max_leg_minutes=max_leg_minutes,
        )

    def _plan_leg(
        self,
        client: httpx.Client,
        *,
        start: tuple[float, float],
        end: tuple[float, float],
    ) -> tuple[int, int, float]:
        cache_key = (round(start[0], 6), round(start[1], 6), round(end[0], 6), round(end[1], 6))
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        transit_payload = self._request(
            client,
            "/v3/direction/transit/integrated",
            {
                "origin": f"{start[0]},{start[1]}",
                "destination": f"{end[0]},{end[1]}",
                "city": self.city,
                "extensions": "all",
                "strategy": "0",
            },
        )
        transits = transit_payload.get("route", {}).get("transits") or []
        if transits:
            first = transits[0]
            result = (
                self._safe_int(first.get("duration"), divide_by=60),
                self._safe_int(first.get("distance")),
                self._safe_float(first.get("cost")),
            )
            self._cache[cache_key] = result
            return result

        walking_payload = self._request(
            client,
            "/v3/direction/walking",
            {
                "origin": f"{start[0]},{start[1]}",
                "destination": f"{end[0]},{end[1]}",
            },
        )
        path = (walking_payload.get("route") or {}).get("paths", [{}])[0]
        result = (
            self._safe_int(path.get("duration"), divide_by=60),
            self._safe_int(path.get("distance")),
            0.0,
        )
        self._cache[cache_key] = result
        return result

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

    def _safe_int(self, value: object, *, divide_by: int | None = None) -> int:
        number = int(float(value or 0))
        if divide_by:
            number = round(number / divide_by)
        return number

    def _safe_float(self, value: object) -> float:
        if value in (None, ""):
            return 0.0
        return round(float(value), 2)
