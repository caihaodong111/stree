from fastapi import APIRouter

from app.api.routes import ai, health, hotels, maps, pois, recommendations

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(recommendations.router, prefix="/recommendations", tags=["recommendations"])
api_router.include_router(ai.router, prefix="/ai", tags=["ai"])
api_router.include_router(maps.router, prefix="/maps", tags=["maps"])
api_router.include_router(pois.router, prefix="/pois", tags=["pois"])
api_router.include_router(hotels.router, prefix="/hotels", tags=["hotels"])
