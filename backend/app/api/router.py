from fastapi import APIRouter

from app.api.routes import ai, health, maps, recommendations

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(recommendations.router, prefix="/recommendations", tags=["recommendations"])
api_router.include_router(ai.router, prefix="/ai", tags=["ai"])
api_router.include_router(maps.router, prefix="/maps", tags=["maps"])
