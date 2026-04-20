"""Crawler task stubs.

This project should prioritize official scenic spot sites, Beijing open data,
and authorized APIs. OTA scraping should only be used as a supplemental source.
"""

from app.tasks.official_poi_sync import sync_official_pois


def sync_poi_catalog(replace: bool = False, limit: int | None = None) -> dict[str, int]:
    return sync_official_pois(replace=replace, limit=limit)
