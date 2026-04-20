from fastapi import APIRouter

from app.schemas.map_routing import MapRouteRequest, MapRouteResponse
from app.services.map_route_service import MapRouteService

router = APIRouter()
service = MapRouteService()


@router.post("/plan", response_model=MapRouteResponse)
async def plan_map_route(payload: MapRouteRequest) -> MapRouteResponse:
    return await service.plan(payload)
