from pydantic import BaseModel, Field


class CoordinatePoint(BaseModel):
    longitude: float
    latitude: float


class RouteStop(BaseModel):
    name: str
    longitude: float
    latitude: float


class MapRouteRequest(BaseModel):
    mode: str = Field(description="walking | driving | transfer")
    origin_name: str
    origin_longitude: float
    origin_latitude: float
    stops: list[RouteStop]


class RouteSegment(BaseModel):
    from_name: str
    to_name: str
    mode: str
    summary: str
    duration_minutes: int | None = None
    distance_meters: int | None = None
    price: float | None = None
    polyline: list[CoordinatePoint]


class MapRouteResponse(BaseModel):
    mode: str
    requested_mode: str | None = None
    summary: str
    total_duration_minutes: int | None = None
    total_distance_meters: int | None = None
    total_price: float | None = None
    segments: list[RouteSegment]
