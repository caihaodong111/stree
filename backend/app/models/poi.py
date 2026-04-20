from sqlalchemy import Float, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PointOfInterest(Base):
    __tablename__ = "pois"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    district: Mapped[str] = mapped_column(String(64), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    ticket_price: Mapped[float] = mapped_column(Float, default=0)
    suggested_visit_hours: Mapped[float] = mapped_column(Float, default=2)
    opening_hours: Mapped[str] = mapped_column(String(128), default="09:00-17:00")
    rating: Mapped[float] = mapped_column(Float, default=4.5)
    popularity: Mapped[int] = mapped_column(Integer, default=80)
    richness: Mapped[int] = mapped_column(Integer, default=80)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    description: Mapped[str] = mapped_column(Text, default="")
