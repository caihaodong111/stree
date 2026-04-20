from __future__ import annotations

from dataclasses import dataclass
import math
import re
import time
from typing import Any

import httpx
from bs4 import BeautifulSoup
from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.poi import PointOfInterest
from app.repositories.poi_repository import POIRepository

LIST_URL = "https://whlyj.beijing.gov.cn/ggfw/ly/202511/t20251119_4287815.html"
AMAP_BASE_URL = "https://restapi.amap.com"
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
    )
}
AMAP_MIN_INTERVAL_SECONDS = 0.25
_last_amap_request_at = 0.0


@dataclass(frozen=True)
class OfficialScenicItem:
    name: str
    level: str
    district: str
    detail_url: str


def sync_official_pois(replace: bool = False, limit: int | None = None) -> dict[str, int]:
    repository = POIRepository()
    inserted = 0
    updated = 0
    skipped = 0

    with httpx.Client(timeout=20.0, headers=REQUEST_HEADERS, follow_redirects=True) as client:
        scenic_items = fetch_official_scenic_list(client)
        if limit is not None:
            scenic_items = scenic_items[:limit]

        with SessionLocal() as db:
            known_names = set(db.scalars(select(PointOfInterest.name)).all())
            for index, item in enumerate(scenic_items, start=1):
                try:
                    poi_data = build_poi_payload(client, item)
                except Exception as exc:  # noqa: BLE001
                    skipped += 1
                    print(f"[{index}/{len(scenic_items)}] skip {item.name}: {exc}")
                    continue

                current = repository.get_by_name(db, poi_data["name"])
                if current is None:
                    if poi_data["name"] in known_names:
                        skipped += 1
                        action = "duplicate_in_batch"
                    else:
                        repository.add(db, poi_data)
                        known_names.add(poi_data["name"])
                        inserted += 1
                        action = "inserted"
                elif replace:
                    repository.update_from_dict(current, poi_data)
                    updated += 1
                    action = "updated"
                else:
                    skipped += 1
                    action = "exists"

                print(f"[{index}/{len(scenic_items)}] {action}: {poi_data['name']}")

            db.commit()

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "total": len(scenic_items),
    }


def fetch_official_scenic_list(client: httpx.Client) -> list[OfficialScenicItem]:
    html = client.get(LIST_URL).text
    soup = BeautifulSoup(html, "html.parser")
    rows = soup.select("table tr")
    scenic_items: list[OfficialScenicItem] = []

    for row in rows[1:]:
        columns = row.find_all("td")
        if len(columns) < 5:
            continue

        name = columns[1].get_text(strip=True)
        level = columns[2].get_text(strip=True)
        district = columns[3].get_text(strip=True)
        link = columns[4].find("a")
        detail_url = link.get("href", "").strip() if link else ""

        if not name or not detail_url:
            continue

        scenic_items.append(
            OfficialScenicItem(
                name=name,
                level=level,
                district=district,
                detail_url=detail_url,
            )
        )

    if not scenic_items:
        raise RuntimeError("No official scenic rows were parsed from the tourism bureau list page.")

    return scenic_items


def build_poi_payload(client: httpx.Client, item: OfficialScenicItem) -> dict[str, Any]:
    html = client.get(item.detail_url).text
    soup = BeautifulSoup(html, "html.parser")

    name = text_or_default(soup.select_one("h3.title"), item.name)
    summary = text_or_default(soup.select_one(".infos .summary"), "")
    description = text_or_default(soup.select_one(".infos .desc p"), summary)
    tags = parse_tags(soup, item.level)
    category = text_or_default(soup.select_one(".infos .tip1 span"), "景区")
    ticket_price = parse_ticket_price(soup)
    suggested_visit_hours = parse_visit_hours(soup)
    opening_hours = truncate_text(parse_opening_hours(soup), 120)
    address = parse_address(soup)
    latitude, longitude = resolve_coordinates(
        client=client,
        html=html,
        name=name,
        district=item.district,
        address=address,
    )

    rating, popularity, richness = metrics_from_level(item.level)

    return {
        "name": name,
        "district": item.district,
        "category": category,
        "latitude": latitude,
        "longitude": longitude,
        "ticket_price": ticket_price,
        "suggested_visit_hours": suggested_visit_hours,
        "opening_hours": opening_hours,
        "rating": rating,
        "popularity": popularity,
        "richness": richness,
        "tags": tags,
        "description": truncate_text(description or summary, 1200),
    }


def parse_tags(soup: BeautifulSoup, level: str) -> list[str]:
    raw_tags = [node.get_text(strip=True) for node in soup.select(".infos .tip1 span")]
    tags: list[str] = []

    for value in [*raw_tags, level]:
        if value and value not in tags:
            tags.append(value)

    return tags[:12]


def parse_ticket_price(soup: BeautifulSoup) -> float:
    price_block = soup.select_one(".phones li.price .price-txt")
    text = normalize_text(price_block.get_text(" ", strip=True) if price_block else "")
    if not text:
        return 0.0

    if "免费" in text and "元" not in text:
        return 0.0

    anchored = re.search(r"(?:门票|大门票|成人票|票价)[:：]?\s*([0-9]+(?:\.[0-9]+)?)\s*元", text)
    if anchored:
        return float(anchored.group(1))

    values = [float(match) for match in re.findall(r"([0-9]+(?:\.[0-9]+)?)\s*元", text)]
    if not values:
        return 0.0

    return min(values)


def parse_visit_hours(soup: BeautifulSoup) -> float:
    time_block = soup.select_one(".phones li.time span")
    text = normalize_text(time_block.get_text(" ", strip=True) if time_block else "")
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*小时", text)
    if match:
        return float(match.group(1))
    return 2.0


def parse_opening_hours(soup: BeautifulSoup) -> str:
    open_block = soup.select_one(".phones li.open .sp1")
    return normalize_text(open_block.get_text(" ", strip=True) if open_block else "")


def parse_address(soup: BeautifulSoup) -> str:
    return text_or_default(soup.select_one(".map .tit .sp2"), "")


def resolve_coordinates(
    client: httpx.Client,
    html: str,
    name: str,
    district: str,
    address: str,
) -> tuple[float, float]:
    try:
        latitude, longitude = parse_coordinates(html)
        return bd09_to_gcj02(latitude, longitude)
    except RuntimeError:
        pass

    if settings.amap_web_service_key:
        geocoded = geocode_with_amap(client, address=address, district=district)
        if geocoded is not None:
            return geocoded

        searched = search_place_with_amap(client, name=name, district=district)
        if searched is not None:
            return searched

    raise RuntimeError("Coordinates were not found in scenic detail page and AMap fallback did not resolve them.")


def parse_coordinates(html: str) -> tuple[float, float]:
    match = re.search(r"BMap\.Point\((?P<lon>116\.[0-9]+|117\.[0-9]+),(?P<lat>39\.[0-9]+|40\.[0-9]+)\)", html)
    if not match:
        raise RuntimeError("Coordinates were not found in scenic detail page.")

    return float(match.group("lat")), float(match.group("lon"))


def geocode_with_amap(
    client: httpx.Client,
    address: str,
    district: str,
) -> tuple[float, float] | None:
    if not address:
        return None

    payload = request_amap(
        client,
        "/v3/geocode/geo",
        {
            "address": address,
            "city": settings.amap_transit_city,
        },
    )
    geocodes = payload.get("geocodes") or []
    for item in geocodes:
        location = item.get("location")
        if not location:
            continue
        adcode = item.get("district") or item.get("adcode") or ""
        if district and district not in normalize_text(str(adcode)):
            continue
        return parse_amap_location(location)
    return None


def search_place_with_amap(
    client: httpx.Client,
    name: str,
    district: str,
) -> tuple[float, float] | None:
    payload = request_amap(
        client,
        "/v3/place/text",
        {
            "keywords": name,
            "city": settings.amap_transit_city,
            "citylimit": "true",
            "offset": "5",
            "extensions": "base",
        },
    )
    pois = payload.get("pois") or []
    if not pois:
        return None

    normalized_name = normalize_name(name)
    for poi in pois:
        location = poi.get("location")
        if not location:
            continue
        poi_name = normalize_name(str(poi.get("name") or ""))
        adname = normalize_text(str(poi.get("adname") or ""))
        if district and district not in adname:
            continue
        if normalized_name and normalized_name not in poi_name and poi_name not in normalized_name:
            continue
        return parse_amap_location(location)

    first = pois[0].get("location")
    if first:
        return parse_amap_location(first)
    return None


def request_amap(client: httpx.Client, path: str, params: dict[str, str]) -> dict[str, Any]:
    for attempt in range(4):
        throttle_amap_requests()
        response = client.get(
            f"{AMAP_BASE_URL}{path}",
            params={
                "key": settings.amap_web_service_key,
                "output": "json",
                **params,
            },
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("status") == "1":
            return payload

        info = str(payload.get("info") or f"AMap request failed for {path}")
        if info in {"CUQPS_HAS_EXCEEDED_THE_LIMIT", "ENGINE_RESPONSE_DATA_ERROR"} and attempt < 3:
            time.sleep(0.8 + attempt * 0.4)
            continue
        raise RuntimeError(info)

    raise RuntimeError(f"AMap request failed for {path}")


def throttle_amap_requests() -> None:
    global _last_amap_request_at

    now = time.monotonic()
    wait = AMAP_MIN_INTERVAL_SECONDS - (now - _last_amap_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_amap_request_at = time.monotonic()


def parse_amap_location(location: str) -> tuple[float, float]:
    longitude_str, latitude_str = location.split(",")
    return round(float(latitude_str), 6), round(float(longitude_str), 6)


def metrics_from_level(level: str) -> tuple[float, int, int]:
    mapping = {
        "5A": (4.9, 95, 92),
        "4A": (4.7, 86, 84),
        "3A": (4.5, 75, 74),
        "2A": (4.3, 66, 67),
        "1A": (4.1, 58, 60),
    }
    return mapping.get(level.upper(), (4.4, 70, 70))


def bd09_to_gcj02(latitude: float, longitude: float) -> tuple[float, float]:
    x = longitude - 0.0065
    y = latitude - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * math.pi * 3000.0 / 180.0)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * math.pi * 3000.0 / 180.0)
    gcj_lng = z * math.cos(theta)
    gcj_lat = z * math.sin(theta)
    return round(gcj_lat, 6), round(gcj_lng, 6)


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalize_name(value: str) -> str:
    return re.sub(r"[（）()·\-\s]", "", normalize_text(value))


def truncate_text(value: str, limit: int) -> str:
    text = normalize_text(value)
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def text_or_default(node: Any, default: str) -> str:
    if node is None:
        return default
    return normalize_text(node.get_text(" ", strip=True))
