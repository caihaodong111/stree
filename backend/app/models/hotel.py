from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class HotelPOI(Base):
    __tablename__ = "hotel_pois"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source: Mapped[str] = mapped_column(String(32), default="amap", index=True)
    source_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    normalized_name: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    district: Mapped[str] = mapped_column(String(64), default="北京", index=True)
    address: Mapped[str] = mapped_column(String(512), default="")
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    reference_price: Mapped[float | None] = mapped_column(Float, default=None)
    phone: Mapped[str] = mapped_column(String(128), default="")
    category: Mapped[str] = mapped_column(String(128), default="酒店")
    amap_type: Mapped[str] = mapped_column(String(256), default="")
    amap_typecode: Mapped[str] = mapped_column(String(32), default="")
    brand: Mapped[str] = mapped_column(String(128), default="")
    star_level: Mapped[str] = mapped_column(String(64), default="")
    raw_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
