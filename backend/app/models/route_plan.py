from sqlalchemy import Float, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RoutePlan(Base):
    __tablename__ = "route_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    origin_name: Mapped[str] = mapped_column(String(128), nullable=False)
    budget_estimate: Mapped[float] = mapped_column(Float, default=0)
    duration_hours: Mapped[float] = mapped_column(Float, default=0)
    score: Mapped[float] = mapped_column(Float, default=0)
    strategy: Mapped[str] = mapped_column(String(64), default="balanced")
    highlights: Mapped[list[str]] = mapped_column(JSON, default=list)


class RoutePlanItem(Base):
    __tablename__ = "route_plan_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    route_plan_id: Mapped[int] = mapped_column(ForeignKey("route_plans.id"), nullable=False)
    poi_id: Mapped[int] = mapped_column(ForeignKey("pois.id"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    arrival_time: Mapped[str] = mapped_column(String(16), default="")
    leave_time: Mapped[str] = mapped_column(String(16), default="")
    stay_hours: Mapped[float] = mapped_column(Float, default=0)
    transfer_minutes: Mapped[int] = mapped_column(Integer, default=0)
