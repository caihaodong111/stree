from collections.abc import Sequence

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.models.hotel import HotelPOI


class HotelRepository:
    def list_all(
        self,
        db: Session,
        *,
        district: str | None = None,
        limit: int | None = None,
        active_only: bool = True,
    ) -> Sequence[HotelPOI]:
        stmt: Select[tuple[HotelPOI]] = select(HotelPOI)
        if active_only:
            stmt = stmt.where(HotelPOI.is_active.is_(True))
        if district:
            stmt = stmt.where(HotelPOI.district == district)
        stmt = stmt.order_by(HotelPOI.last_seen_at.desc(), HotelPOI.reference_price.is_(None), HotelPOI.reference_price.asc(), HotelPOI.name.asc())
        if limit is not None:
            stmt = stmt.limit(limit)
        return db.scalars(stmt).all()

    def get_by_source_id(self, db: Session, source_id: str) -> HotelPOI | None:
        stmt = select(HotelPOI).where(HotelPOI.source_id == source_id)
        return db.scalars(stmt).first()

    def list_by_normalized_name(
        self,
        db: Session,
        normalized_name: str,
        *,
        active_only: bool = True,
    ) -> Sequence[HotelPOI]:
        stmt: Select[tuple[HotelPOI]] = select(HotelPOI).where(HotelPOI.normalized_name == normalized_name)
        if active_only:
            stmt = stmt.where(HotelPOI.is_active.is_(True))
        stmt = stmt.order_by(HotelPOI.last_seen_at.desc(), HotelPOI.name.asc())
        return db.scalars(stmt).all()

    def list_missing_prices(
        self,
        db: Session,
        *,
        district: str | None = None,
        limit: int | None = None,
        active_only: bool = True,
    ) -> Sequence[HotelPOI]:
        stmt: Select[tuple[HotelPOI]] = select(HotelPOI).where(HotelPOI.reference_price.is_(None))
        if active_only:
            stmt = stmt.where(HotelPOI.is_active.is_(True))
        if district:
            stmt = stmt.where(HotelPOI.district == district)
        stmt = stmt.order_by(HotelPOI.last_seen_at.desc(), HotelPOI.name.asc())
        if limit is not None:
            stmt = stmt.limit(limit)
        return db.scalars(stmt).all()

    def add(self, db: Session, hotel_data: dict) -> HotelPOI:
        hotel = HotelPOI(**hotel_data)
        db.add(hotel)
        return hotel

    def update_from_dict(self, hotel: HotelPOI, hotel_data: dict) -> HotelPOI:
        for field, value in hotel_data.items():
            setattr(hotel, field, value)
        return hotel
