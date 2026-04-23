from math import atan2, cos, radians, sin, sqrt

from fastapi import HTTPException

from app.providers.amap_route_provider import AMapRouteProvider, SegmentRouteData
from app.schemas.map_routing import CoordinatePoint, MapRouteRequest, MapRouteResponse, RouteSegment


class MapRouteService:
    WALKING_AUTO_DRIVE_DISTANCE_KM = 6.0

    def __init__(self) -> None:
        self.provider = AMapRouteProvider()

    async def plan(self, payload: MapRouteRequest) -> MapRouteResponse:
        if not payload.stops:
            raise HTTPException(status_code=400, detail="At least one stop is required for route planning.")

        segments: list[RouteSegment] = []
        total_duration = 0
        total_distance = 0
        total_price = 0.0
        fallback_notes: list[str] = []
        effective_modes: set[str] = set()

        previous_name = payload.origin_name
        previous_point = (payload.origin_longitude, payload.origin_latitude)

        for stop in payload.stops:
            requested_mode = payload.mode
            actual_mode = requested_mode
            straight_distance_km = self._distance_km(
                previous_point[1],
                previous_point[0],
                stop.latitude,
                stop.longitude,
            )

            if requested_mode == "walking" and straight_distance_km > self.WALKING_AUTO_DRIVE_DISTANCE_KM:
                actual_mode = "driving"
                fallback_notes.append(
                    f"{previous_name} -> {stop.name} 直线距离约 {straight_distance_km:.1f} km，已从步行自动切换为驾车"
                )

            try:
                result = await self.provider.plan_leg(
                    actual_mode,
                    start=previous_point,
                    end=(stop.longitude, stop.latitude),
                )
            except HTTPException as exc:
                if requested_mode == "walking" and exc.status_code == 502 and actual_mode == "walking":
                    actual_mode = "driving"
                    fallback_notes.append(f"{previous_name} -> {stop.name} 步行路线不可用，已自动切换为驾车")
                    try:
                        result = await self.provider.plan_leg(
                            actual_mode,
                            start=previous_point,
                            end=(stop.longitude, stop.latitude),
                        )
                    except HTTPException as driving_exc:
                        if self._should_use_estimate(driving_exc):
                            fallback_notes.append(f"{previous_name} -> {stop.name} 高德驾车额度超限，已切换为估算路线")
                            result = self._estimate_segment(actual_mode, previous_point, (stop.longitude, stop.latitude))
                        else:
                            raise
                elif self._should_use_estimate(exc):
                    fallback_notes.append(f"{previous_name} -> {stop.name} 高德路线额度超限，已切换为估算路线")
                    result = self._estimate_segment(actual_mode, previous_point, (stop.longitude, stop.latitude))
                else:
                    raise

            effective_modes.add(actual_mode)

            if result.duration_minutes is not None:
                total_duration += result.duration_minutes
            if result.distance_meters is not None:
                total_distance += result.distance_meters
            if result.price is not None:
                total_price += result.price

            segments.append(
                RouteSegment(
                    from_name=previous_name,
                    to_name=stop.name,
                    mode=actual_mode,
                    summary=result.summary,
                    duration_minutes=result.duration_minutes,
                    distance_meters=result.distance_meters,
                    price=result.price,
                    polyline=[
                        CoordinatePoint(longitude=longitude, latitude=latitude)
                        for longitude, latitude in result.polyline
                    ],
                )
            )

            previous_name = stop.name
            previous_point = (stop.longitude, stop.latitude)

        if payload.mode == "walking" and "driving" in effective_modes:
            summary_parts = [f"步行优先模式共 {len(segments)} 段"]
        else:
            summary_parts = [f"{payload.mode} 模式共 {len(segments)} 段"]
        if total_duration:
            summary_parts.append(f"总耗时约 {total_duration} 分钟")
        if total_distance:
            summary_parts.append(f"总距离约 {total_distance / 1000:.1f} km")
        if payload.mode == "transfer":
            summary_parts.append(f"总票价约 {total_price:.0f} 元")
        elif total_price:
            summary_parts.append(f"总费用约 {total_price:.0f} 元")
        if fallback_notes:
            summary_parts.append("；".join(fallback_notes[:2]))

        return MapRouteResponse(
            mode="driving" if payload.mode == "walking" and effective_modes == {"driving"} else payload.mode,
            requested_mode=payload.mode,
            summary=" · ".join(summary_parts),
            total_duration_minutes=total_duration or None,
            total_distance_meters=total_distance or None,
            total_price=round(total_price, 2) if total_price else (0 if payload.mode == "walking" else None),
            segments=segments,
        )

    def _should_use_estimate(self, exc: HTTPException) -> bool:
        if exc.status_code != 502:
            return False
        detail = str(exc.detail or "")
        return "infocode=10021" in detail or "CUQPS_HAS_EXCEEDED_THE_LIMIT" in detail

    def _estimate_segment(
        self,
        mode: str,
        start: tuple[float, float],
        end: tuple[float, float],
    ) -> SegmentRouteData:
        distance_km = self._distance_km(start[1], start[0], end[1], end[0])
        distance_meters = max(100, round(distance_km * 1000))

        if mode == "walking":
            duration_minutes = max(3, round(distance_km / 4.5 * 60))
            price = 0.0
            mode_label = "步行估算"
        elif mode == "transfer":
            duration_minutes = max(5, round(distance_km / 18 * 60))
            price = 3.0
            mode_label = "公交 / 地铁估算"
        else:
            duration_minutes = max(3, round(distance_km / 28 * 60))
            price = 0.0
            mode_label = "驾车估算"

        return SegmentRouteData(
            summary=f"{mode_label} · 高德额度超限，当前使用直线距离估算 · 约 {duration_minutes} 分钟 · 约 {distance_km:.1f} km",
            duration_minutes=duration_minutes,
            distance_meters=distance_meters,
            price=price,
            polyline=[start, end],
        )

    def _distance_km(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        radius = 6371.0
        d_lat = radians(lat2 - lat1)
        d_lon = radians(lon2 - lon1)
        a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
        c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return radius * c
