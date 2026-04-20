from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.planners.beijing_route_planner import BeijingRoutePlanner
from app.repositories.poi_repository import POIRepository
from app.schemas.recommendation import RecommendationRequest, RecommendationResponse


class RecommendationService:
    def __init__(self) -> None:
        self.planner = BeijingRoutePlanner()
        self.poi_repository = POIRepository()

    def recommend(self, payload: RecommendationRequest, db: Session) -> RecommendationResponse:
        pois = self.poi_repository.list_all(db)
        if not pois:
            raise HTTPException(
                status_code=400,
                detail="POI catalog is empty. Run `python seed_pois.py` in the backend directory first.",
            )
        route_options = self.planner.recommend(payload, pois)
        summary = (
            "系统已综合预算、游玩时长、景点丰富度和地理紧凑度生成候选路线。"
            "当前版本已支持从 MySQL 读取北京景点数据，后续可接入真实地图耗时、景区票务和酒店价格。"
        )
        return RecommendationResponse(
            origin_name=payload.origin_name,
            recommendation_summary=summary,
            route_options=route_options,
        )
