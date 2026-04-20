from fastapi import HTTPException

from app.providers.amap_route_provider import AMapRouteProvider
from app.schemas.map_routing import CoordinatePoint, MapRouteRequest, MapRouteResponse, RouteSegment


class MapRouteService:
    def __init__(self) -> None:
        self.provider = AMapRouteProvider()

    async def plan(self, payload: MapRouteRequest) -> MapRouteResponse:
        if not payload.stops:
            raise HTTPException(status_code=400, detail="At least one stop is required for route planning.")

        segments: list[RouteSegment] = []
        total_duration = 0
        total_distance = 0
        total_price = 0.0

        previous_name = payload.origin_name
        previous_point = (payload.origin_longitude, payload.origin_latitude)

        for stop in payload.stops:
            result = await self.provider.plan_leg(
                payload.mode,
                start=previous_point,
                end=(stop.longitude, stop.latitude),
            )

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
                    mode=payload.mode,
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

        summary_parts = [f"{payload.mode} 模式共 {len(segments)} 段"]
        if total_duration:
            summary_parts.append(f"总耗时约 {total_duration} 分钟")
        if total_distance:
            summary_parts.append(f"总距离约 {total_distance / 1000:.1f} km")
        if payload.mode == "transfer":
            summary_parts.append(f"总票价约 {total_price:.0f} 元")
        elif total_price:
            summary_parts.append(f"总费用约 {total_price:.0f} 元")

        return MapRouteResponse(
            mode=payload.mode,
            summary=" · ".join(summary_parts),
            total_duration_minutes=total_duration or None,
            total_distance_meters=total_distance or None,
            total_price=round(total_price, 2) if total_price else (0 if payload.mode == "walking" else None),
            segments=segments,
        )
