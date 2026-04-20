from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import HTTPException

from app.core.config import settings


@dataclass(frozen=True)
class SegmentRouteData:
    summary: str
    duration_minutes: int | None
    distance_meters: int | None
    price: float | None
    polyline: list[tuple[float, float]]


class AMapRouteProvider:
    def __init__(self) -> None:
        self.key = settings.amap_web_service_key
        self.city = settings.amap_transit_city
        self.base_url = "https://restapi.amap.com"

    async def plan_leg(
        self,
        mode: str,
        start: tuple[float, float],
        end: tuple[float, float],
    ) -> SegmentRouteData:
        if not self.key:
            raise HTTPException(status_code=400, detail="AMAP_WEB_SERVICE_KEY is not configured in backend/.env.")

        if mode == "walking":
            data = await self._request("/v3/direction/walking", start, end)
            return self._parse_walking(data)
        if mode == "driving":
            data = await self._request("/v3/direction/driving", start, end, extra={"extensions": "all", "strategy": "0"})
            return self._parse_driving(data)
        if mode == "transfer":
            data = await self._request(
                "/v3/direction/transit/integrated",
                start,
                end,
                extra={"city": self.city, "extensions": "all", "strategy": "0"},
            )
            return self._parse_transit(data)

        raise HTTPException(status_code=400, detail=f"Unsupported route mode: {mode}")

    async def _request(
        self,
        path: str,
        start: tuple[float, float],
        end: tuple[float, float],
        extra: dict[str, str] | None = None,
    ) -> dict:
        params = {
            "key": self.key,
            "origin": f"{start[0]},{start[1]}",
            "destination": f"{end[0]},{end[1]}",
        }
        if extra:
            params.update(extra)

        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(f"{self.base_url}{path}", params=params)
            response.raise_for_status()
            payload = response.json()

        if payload.get("status") != "1":
            info = payload.get("info") or "AMap routing failed"
            raise HTTPException(status_code=502, detail=f"AMap routing failed: {info}")
        return payload

    def _parse_walking(self, payload: dict) -> SegmentRouteData:
        path = payload.get("route", {}).get("paths", [{}])[0]
        coordinates = self._collect_step_polylines(path.get("steps", []))
        duration = self._safe_int(path.get("duration"), divide_by=60)
        distance = self._safe_int(path.get("distance"))
        summary = self._build_summary("步行", duration, distance, 0)
        return SegmentRouteData(summary, duration, distance, 0, coordinates)

    def _parse_driving(self, payload: dict) -> SegmentRouteData:
        path = payload.get("route", {}).get("paths", [{}])[0]
        coordinates = self._collect_step_polylines(path.get("steps", []))
        duration = self._safe_int(path.get("duration"), divide_by=60)
        distance = self._safe_int(path.get("distance"))
        tolls = self._safe_float(path.get("tolls"))
        summary = self._build_summary("驾车", duration, distance, tolls)
        return SegmentRouteData(summary, duration, distance, tolls, coordinates)

    def _parse_transit(self, payload: dict) -> SegmentRouteData:
        transit = payload.get("route", {}).get("transits", [{}])[0]
        segments = transit.get("segments", [])
        coordinates: list[tuple[float, float]] = []
        line_names: list[str] = []

        for segment in segments:
            walking = segment.get("walking", {})
            coordinates.extend(self._collect_step_polylines(walking.get("steps", [])))

            for busline in segment.get("bus", {}).get("buslines", []):
                coordinates.extend(self._decode_polyline(busline.get("polyline", "")))
                name = busline.get("name")
                if name:
                    line_names.append(name)

        duration = self._safe_int(transit.get("duration"), divide_by=60)
        distance = self._safe_int(transit.get("distance"))
        cost = self._safe_float(transit.get("cost"))
        summary = self._build_transit_summary(duration, distance, cost, line_names)
        return SegmentRouteData(summary, duration, distance, cost, self._dedupe(coordinates))

    def _collect_step_polylines(self, steps: list[dict]) -> list[tuple[float, float]]:
        coordinates: list[tuple[float, float]] = []
        for step in steps:
            coordinates.extend(self._decode_polyline(step.get("polyline", "")))
        return self._dedupe(coordinates)

    def _decode_polyline(self, polyline: str) -> list[tuple[float, float]]:
        if not polyline:
            return []
        result: list[tuple[float, float]] = []
        for point in polyline.split(";"):
            try:
                longitude, latitude = point.split(",")
                result.append((float(longitude), float(latitude)))
            except ValueError:
                continue
        return result

    def _dedupe(self, coordinates: list[tuple[float, float]]) -> list[tuple[float, float]]:
        unique: list[tuple[float, float]] = []
        for point in coordinates:
            if not unique or unique[-1] != point:
                unique.append(point)
        return unique

    def _safe_int(self, value: str | int | None, divide_by: int | None = None) -> int | None:
        if value in (None, ""):
            return None
        number = int(float(value))
        if divide_by:
            number = round(number / divide_by)
        return number

    def _safe_float(self, value: str | float | None) -> float | None:
        if value in (None, ""):
            return None
        return round(float(value), 2)

    def _build_summary(self, mode_label: str, duration: int | None, distance: int | None, price: float | None) -> str:
        parts = [f"{mode_label}路线"]
        if duration is not None:
            parts.append(f"约 {duration} 分钟")
        if distance is not None:
            parts.append(self._distance_label(distance))
        if price:
            parts.append(f"费用约 {price:.0f} 元")
        return " · ".join(parts)

    def _build_transit_summary(
        self,
        duration: int | None,
        distance: int | None,
        cost: float | None,
        line_names: list[str],
    ) -> str:
        parts = ["公交 / 地铁路线"]
        if duration is not None:
            parts.append(f"约 {duration} 分钟")
        if distance is not None:
            parts.append(self._distance_label(distance))
        if cost is not None:
            parts.append(f"票价约 {cost:.0f} 元")
        if line_names:
            parts.append(" -> ".join(line_names[:4]))
        return " · ".join(parts)

    def _distance_label(self, meters: int) -> str:
        if meters >= 1000:
            return f"{meters / 1000:.1f} km"
        return f"{meters} m"
