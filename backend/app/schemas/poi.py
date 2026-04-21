from pydantic import BaseModel, Field


class POISuggestionItem(BaseModel):
    name: str
    district: str
    category: str
    tags: list[str] = Field(default_factory=list)
    popularity: int
    rating: float


class POISuggestionCatalogResponse(BaseModel):
    pois: list[POISuggestionItem] = Field(default_factory=list)
    districts: list[str] = Field(default_factory=list)
