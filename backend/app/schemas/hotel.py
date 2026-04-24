from datetime import datetime

from pydantic import BaseModel, Field


class HotelItem(BaseModel):
    id: int
    source: str
    source_id: str
    name: str
    district: str
    address: str
    latitude: float
    longitude: float
    reference_price: float | None = None
    phone: str = ""
    category: str
    amap_type: str = ""
    brand: str = ""
    star_level: str = ""
    notes: str = ""
    last_seen_at: datetime


class HotelCatalogResponse(BaseModel):
    hotels: list[HotelItem] = Field(default_factory=list)
    districts: list[str] = Field(default_factory=list)
    total: int = 0
