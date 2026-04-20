from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.poi import PointOfInterest


class POIRepository:
    def list_all(self, db: Session) -> Sequence[PointOfInterest]:
        stmt = select(PointOfInterest).order_by(PointOfInterest.popularity.desc(), PointOfInterest.rating.desc())
        return db.scalars(stmt).all()

    def get_by_name(self, db: Session, name: str) -> PointOfInterest | None:
        stmt = select(PointOfInterest).where(PointOfInterest.name == name)
        return db.scalars(stmt).first()

    def add(self, db: Session, poi_data: dict) -> PointOfInterest:
        poi = PointOfInterest(**poi_data)
        db.add(poi)
        return poi

    def update_from_dict(self, poi: PointOfInterest, poi_data: dict) -> PointOfInterest:
        for field, value in poi_data.items():
            setattr(poi, field, value)
        return poi
