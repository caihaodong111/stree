from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.repositories.hotel_repository import HotelRepository
from app.schemas.hotel import HotelCatalogResponse, HotelItem

router = APIRouter()
repository = HotelRepository()


@router.get("", response_model=HotelCatalogResponse)
def list_hotels(
    district: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> HotelCatalogResponse:
    hotels = repository.list_all(db, district=district, limit=limit)
    districts = list(dict.fromkeys(item.district for item in repository.list_all(db, limit=20000) if item.district))

    return HotelCatalogResponse(
        hotels=[
            HotelItem(
                id=hotel.id,
                source=hotel.source,
                source_id=hotel.source_id,
                name=hotel.name,
                district=hotel.district,
                address=hotel.address,
                latitude=hotel.latitude,
                longitude=hotel.longitude,
                reference_price=hotel.reference_price,
                phone=hotel.phone,
                category=hotel.category,
                amap_type=hotel.amap_type,
                brand=hotel.brand,
                star_level=hotel.star_level,
                notes=hotel.notes,
                last_seen_at=hotel.last_seen_at,
            )
            for hotel in hotels
        ],
        districts=districts,
        total=len(hotels),
    )
