from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.repositories.poi_repository import POIRepository
from app.schemas.poi import POISuggestionCatalogResponse, POISuggestionItem

router = APIRouter()
repository = POIRepository()


@router.get("/suggestions", response_model=POISuggestionCatalogResponse)
def list_poi_suggestions(
    db: Session = Depends(get_db),
) -> POISuggestionCatalogResponse:
    pois = repository.list_all(db)
    districts = list(dict.fromkeys(poi.district for poi in pois if poi.district))

    return POISuggestionCatalogResponse(
        pois=[
            POISuggestionItem(
                name=poi.name,
                district=poi.district,
                category=poi.category,
                tags=poi.tags,
                popularity=poi.popularity,
                rating=poi.rating,
            )
            for poi in pois
        ],
        districts=districts,
    )
