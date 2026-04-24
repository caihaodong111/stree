from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from difflib import SequenceMatcher
import json
import logging
import math
import re
import time
from typing import Any

import httpx
from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.hotel import HotelPOI
from app.repositories.hotel_repository import HotelRepository

logger = logging.getLogger("app.data.hotel_sync")

AMAP_BASE_URL = "https://restapi.amap.com"
TRIPADVISOR_BASE_URL = "https://www.tripadvisor.cn"
CTRIP_LIST_URL = "https://hotels.ctrip.com/hotels/list"

AMAP_MIN_INTERVAL_SECONDS = 0.30
TRIPADVISOR_MIN_INTERVAL_SECONDS = 0.80
CTRIP_MIN_INTERVAL_SECONDS = 1.20

SEARCH_OFFSET = 20
TRIPADVISOR_PAGE_SIZE = 30
DEFAULT_PAGES_PER_KEYWORD = 3
DEFAULT_AROUND_PAGES = 2
DEFAULT_AROUND_RADIUS_METERS = 9000
DEFAULT_TRIPADVISOR_PAGES = 12
DEFAULT_PRICE_ENRICH_LIMIT = 50

DEFAULT_DISTRICTS = (
    "东城区",
    "西城区",
    "朝阳区",
    "海淀区",
    "丰台区",
    "石景山区",
    "通州区",
    "顺义区",
    "昌平区",
    "大兴区",
    "房山区",
    "门头沟区",
    "怀柔区",
    "平谷区",
    "密云区",
    "延庆区",
)
DEFAULT_KEYWORDS = (
    "酒店",
    "宾馆",
    "旅馆",
    "民宿",
    "公寓酒店",
    "青年旅舍",
    "度假村",
    "快捷酒店",
    "商务酒店",
)
HOTEL_HINTS = ("酒店", "宾馆", "旅馆", "民宿", "客栈", "青旅", "青年旅舍", "公寓酒店", "度假村")
EXCLUDE_HINTS = ("停车场", "写字楼", "售楼处", "洗浴", "足疗", "KTV", "餐厅", "饭店停车场")
DISTRICT_HINTS = (
    "东城区",
    "西城区",
    "朝阳区",
    "海淀区",
    "丰台区",
    "石景山区",
    "通州区",
    "顺义区",
    "昌平区",
    "大兴区",
    "房山区",
    "门头沟区",
    "怀柔区",
    "平谷区",
    "密云区",
    "延庆区",
)
BEIJING_GRID_POINTS = (
    (116.200, 39.760),
    (116.320, 39.760),
    (116.440, 39.760),
    (116.560, 39.760),
    (116.200, 39.860),
    (116.320, 39.860),
    (116.440, 39.860),
    (116.560, 39.860),
    (116.200, 39.960),
    (116.320, 39.960),
    (116.440, 39.960),
    (116.560, 39.960),
    (116.200, 40.060),
    (116.320, 40.060),
    (116.440, 40.060),
    (116.560, 40.060),
)
TRANSIENT_AMAP_ERRORS = {"CUQPS_HAS_EXCEEDED_THE_LIMIT", "ENGINE_RESPONSE_DATA_ERROR", "SYSTEM_ERROR"}
DEFAULT_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

_last_amap_request_at = 0.0
_last_tripadvisor_request_at = 0.0
_last_ctrip_request_at = 0.0


@dataclass(frozen=True)
class SyncConfig:
    districts: tuple[str, ...]
    keywords: tuple[str, ...]
    pages_per_keyword: int
    around_pages: int
    around_radius_meters: int
    limit: int | None


def sync_hotels_from_amap(
    *,
    replace: bool = False,
    limit: int | None = None,
    districts: list[str] | None = None,
    keywords: list[str] | None = None,
    pages_per_keyword: int = DEFAULT_PAGES_PER_KEYWORD,
    around_pages: int = DEFAULT_AROUND_PAGES,
    around_radius_meters: int = DEFAULT_AROUND_RADIUS_METERS,
) -> dict[str, int]:
    if not settings.amap_web_service_key:
        raise RuntimeError("AMAP_WEB_SERVICE_KEY is not configured.")

    config = SyncConfig(
        districts=tuple(districts or DEFAULT_DISTRICTS),
        keywords=tuple(keywords or DEFAULT_KEYWORDS),
        pages_per_keyword=max(1, pages_per_keyword),
        around_pages=max(1, around_pages),
        around_radius_meters=max(1000, around_radius_meters),
        limit=limit,
    )
    repository = HotelRepository()
    inserted = 0
    updated = 0
    skipped = 0
    seen_source_ids: set[str] = set()
    processed = 0

    with httpx.Client(timeout=15.0) as client:
        with SessionLocal() as db:
            for district in config.districts:
                for keyword in config.keywords:
                    for page in range(1, config.pages_per_keyword + 1):
                        items = _search_hotels(client, district=district, keyword=keyword, page=page)
                        if not items:
                            break

                        for item in items:
                            source_id = str(item.get("id") or "").strip()
                            if not source_id or source_id in seen_source_ids:
                                continue

                            seen_source_ids.add(source_id)
                            detail = None
                            try:
                                detail = _fetch_place_detail(client, source_id=source_id)
                            except Exception:
                                detail = None
                            hotel_data = build_hotel_payload(item=item, district_hint=district)
                            if hotel_data is None:
                                skipped += 1
                                continue
                            if detail is not None:
                                hotel_data = apply_detail_payload(hotel_data, detail)

                            current = repository.get_by_source_id(db, hotel_data["source_id"])
                            if current is None:
                                repository.add(db, hotel_data)
                                inserted += 1
                            elif replace:
                                repository.update_from_dict(current, hotel_data)
                                updated += 1
                            else:
                                repository.update_from_dict(
                                    current,
                                    {
                                        "reference_price": hotel_data["reference_price"],
                                        "phone": hotel_data["phone"],
                                        "raw_payload": hotel_data["raw_payload"],
                                        "notes": hotel_data["notes"],
                                        "is_active": True,
                                        "last_seen_at": hotel_data["last_seen_at"],
                                    },
                                )
                                skipped += 1

                            processed += 1
                            if config.limit is not None and processed >= config.limit:
                                break

                        db.commit()
                        if config.limit is not None and processed >= config.limit:
                            break
                        if len(items) < SEARCH_OFFSET:
                            break

                    if config.limit is not None and processed >= config.limit:
                        break
                if config.limit is not None and processed >= config.limit:
                    break

            if config.limit is None or processed < config.limit:
                for longitude, latitude in BEIJING_GRID_POINTS:
                    for keyword in config.keywords:
                        for page in range(1, config.around_pages + 1):
                            items = _search_hotels_around(
                                client,
                                longitude=longitude,
                                latitude=latitude,
                                keyword=keyword,
                                radius=config.around_radius_meters,
                                page=page,
                            )
                            if not items:
                                break

                            for item in items:
                                source_id = str(item.get("id") or "").strip()
                                if not source_id or source_id in seen_source_ids:
                                    continue

                                seen_source_ids.add(source_id)
                                detail = None
                                try:
                                    detail = _fetch_place_detail(client, source_id=source_id)
                                except Exception:
                                    detail = None

                                hotel_data = build_hotel_payload(item=item, district_hint="北京")
                                if hotel_data is None:
                                    skipped += 1
                                    continue
                                if detail is not None:
                                    hotel_data = apply_detail_payload(hotel_data, detail)

                                current = repository.get_by_source_id(db, hotel_data["source_id"])
                                if current is None:
                                    repository.add(db, hotel_data)
                                    inserted += 1
                                elif replace:
                                    repository.update_from_dict(current, hotel_data)
                                    updated += 1
                                else:
                                    repository.update_from_dict(
                                        current,
                                        {
                                            "reference_price": hotel_data["reference_price"],
                                            "phone": hotel_data["phone"],
                                            "raw_payload": hotel_data["raw_payload"],
                                            "notes": hotel_data["notes"],
                                            "is_active": True,
                                            "last_seen_at": hotel_data["last_seen_at"],
                                        },
                                    )
                                    skipped += 1

                                processed += 1
                                if config.limit is not None and processed >= config.limit:
                                    break

                            db.commit()
                            if config.limit is not None and processed >= config.limit:
                                break
                            if len(items) < SEARCH_OFFSET:
                                break
                        if config.limit is not None and processed >= config.limit:
                            break
                    if config.limit is not None and processed >= config.limit:
                        break

            if replace:
                stale_stmt = select(HotelPOI).where(HotelPOI.source == "amap")
                for hotel in db.scalars(stale_stmt):
                    if hotel.source_id not in seen_source_ids:
                        hotel.is_active = False
                db.commit()

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "processed": processed,
        "seen": len(seen_source_ids),
    }


def sync_hotels_from_tripadvisor(
    *,
    replace: bool = False,
    max_pages: int = DEFAULT_TRIPADVISOR_PAGES,
    limit: int | None = None,
) -> dict[str, int]:
    repository = HotelRepository()
    inserted = 0
    updated = 0
    skipped = 0
    merged = 0
    processed = 0
    seen_source_ids: set[str] = set()

    with httpx.Client(timeout=20.0, follow_redirects=True, headers=DEFAULT_BROWSER_HEADERS) as client:
        with SessionLocal() as db:
            for page in range(1, max(1, max_pages) + 1):
                hotels = _fetch_tripadvisor_hotels_page(client, page=page)
                if not hotels:
                    break

                page_new_count = 0
                for item in hotels:
                    hotel_data = build_tripadvisor_hotel_payload(item)
                    if hotel_data is None:
                        skipped += 1
                        continue

                    if hotel_data["source_id"] in seen_source_ids:
                        continue
                    seen_source_ids.add(hotel_data["source_id"])
                    page_new_count += 1
                    outcome = _upsert_hotel_record(
                        db,
                        repository,
                        hotel_data,
                        replace=replace,
                        allow_merge=True,
                    )
                    if outcome == "inserted":
                        inserted += 1
                    elif outcome == "updated":
                        updated += 1
                    elif outcome == "merged":
                        merged += 1
                    else:
                        skipped += 1

                    processed += 1
                    if limit is not None and processed >= limit:
                        break

                db.commit()
                if limit is not None and processed >= limit:
                    break
                if page_new_count == 0:
                    break
                if len(hotels) < TRIPADVISOR_PAGE_SIZE:
                    break

            if replace:
                stale_stmt = select(HotelPOI).where(HotelPOI.source == "tripadvisor")
                for hotel in db.scalars(stale_stmt):
                    if hotel.source_id not in seen_source_ids:
                        hotel.is_active = False
                db.commit()

    return {
        "inserted": inserted,
        "updated": updated,
        "merged": merged,
        "skipped": skipped,
        "processed": processed,
        "seen": len(seen_source_ids),
    }


def enrich_hotel_prices_from_ctrip(
    *,
    limit: int = DEFAULT_PRICE_ENRICH_LIMIT,
    district: str | None = None,
    only_missing: bool = True,
) -> dict[str, int]:
    repository = HotelRepository()
    checked = 0
    matched = 0
    updated = 0
    no_price = 0
    failed = 0

    with httpx.Client(timeout=20.0, follow_redirects=True, headers=DEFAULT_BROWSER_HEADERS) as client:
        with SessionLocal() as db:
            hotels = (
                repository.list_missing_prices(db, district=district, limit=limit)
                if only_missing
                else repository.list_all(db, district=district, limit=limit)
            )

            for hotel in hotels:
                checked += 1
                try:
                    snapshot = _fetch_ctrip_price_snapshot(client, hotel.name)
                except Exception as exc:
                    logger.warning("ctrip_price_fetch_failed hotel=%s error=%s", hotel.name, exc)
                    failed += 1
                    continue

                if snapshot is None:
                    no_price += 1
                    continue

                matched_name = str(snapshot.get("matched_name") or "")
                if not _names_look_similar(hotel.normalized_name, normalize_name(matched_name)):
                    no_price += 1
                    continue

                matched += 1
                updates: dict[str, Any] = {
                    "raw_payload": _merge_external_payload(hotel.raw_payload, "ctrip", snapshot.get("raw_payload") or {}),
                    "notes": merge_notes(hotel.notes, build_ctrip_notes(snapshot)),
                    "last_seen_at": datetime.utcnow(),
                    "is_active": True,
                }
                reference_price = _safe_float(snapshot.get("reference_price"))
                if reference_price is None:
                    no_price += 1
                else:
                    updates["reference_price"] = reference_price
                    updated += 1
                repository.update_from_dict(hotel, updates)

            db.commit()

    return {
        "checked": checked,
        "matched": matched,
        "updated": updated,
        "no_price": no_price,
        "failed": failed,
    }


def _search_hotels(
    client: httpx.Client,
    *,
    district: str,
    keyword: str,
    page: int,
) -> list[dict]:
    payload = _request_amap(
        client,
        "/v3/place/text",
        {
            "keywords": f"{district} {keyword}",
            "city": settings.amap_transit_city,
            "citylimit": "true",
            "offset": str(SEARCH_OFFSET),
            "page": str(page),
            "extensions": "all",
        },
    )
    pois = payload.get("pois") or []
    return [item for item in pois if _is_hotel_like(item)]


def _search_hotels_around(
    client: httpx.Client,
    *,
    longitude: float,
    latitude: float,
    keyword: str,
    radius: int,
    page: int,
) -> list[dict]:
    payload = _request_amap(
        client,
        "/v3/place/around",
        {
            "location": f"{longitude},{latitude}",
            "keywords": keyword,
            "radius": str(radius),
            "offset": str(SEARCH_OFFSET),
            "page": str(page),
            "sortrule": "distance",
            "extensions": "all",
        },
    )
    pois = payload.get("pois") or []
    return [item for item in pois if _is_hotel_like(item)]


def _request_amap(client: httpx.Client, path: str, params: dict[str, str]) -> dict:
    global _last_amap_request_at

    now = time.monotonic()
    wait = AMAP_MIN_INTERVAL_SECONDS - (now - _last_amap_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_amap_request_at = time.monotonic()

    for attempt in range(4):
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
        if info in TRANSIENT_AMAP_ERRORS and attempt < 3:
            time.sleep(0.8 + attempt * 0.5)
            continue
        raise RuntimeError(info)

    raise RuntimeError(f"AMap request failed for {path}")


def _fetch_place_detail(client: httpx.Client, *, source_id: str) -> dict | None:
    payload = _request_amap(
        client,
        "/v3/place/detail",
        {
            "id": source_id,
            "extensions": "all",
        },
    )
    pois = payload.get("pois") or []
    return pois[0] if pois else None


def _fetch_tripadvisor_hotels_page(client: httpx.Client, *, page: int) -> list[dict]:
    global _last_tripadvisor_request_at

    offset = max(0, page - 1) * TRIPADVISOR_PAGE_SIZE
    path = "/Hotels-g294212-Beijing-Hotels.html" if offset == 0 else f"/Hotels-g294212-oa{offset}-Beijing-Hotels.html"

    now = time.monotonic()
    wait = TRIPADVISOR_MIN_INTERVAL_SECONDS - (now - _last_tripadvisor_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_tripadvisor_request_at = time.monotonic()

    response = client.get(f"{TRIPADVISOR_BASE_URL}{path}")
    response.raise_for_status()
    payload = _extract_tripadvisor_page_payload(response.text)
    hotel_list = None
    if isinstance(payload, dict):
        hotel_list = payload.get("hotelList")
        if not isinstance(hotel_list, list):
            hotel_list = payload.get("hotels")
    if not isinstance(hotel_list, list):
        return []
    return [item for item in hotel_list if isinstance(item, dict)]


def _fetch_ctrip_price_snapshot(client: httpx.Client, hotel_name: str) -> dict[str, Any] | None:
    global _last_ctrip_request_at

    checkin = (datetime.utcnow().date() + timedelta(days=14)).isoformat()
    checkout = (datetime.utcnow().date() + timedelta(days=15)).isoformat()
    params = {
        "city": "1",
        "checkin": checkin,
        "checkout": checkout,
        "keyword": hotel_name,
    }

    now = time.monotonic()
    wait = CTRIP_MIN_INTERVAL_SECONDS - (now - _last_ctrip_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_ctrip_request_at = time.monotonic()

    response = client.get(CTRIP_LIST_URL, params=params)
    response.raise_for_status()

    payload = _extract_ctrip_init_payload(response.text)
    hotel_list = payload.get("hotelList") if isinstance(payload, dict) else None
    if not hotel_list:
        return None

    first_hotel = hotel_list[0]
    if not isinstance(first_hotel, dict):
        return None
    hotel_info = first_hotel.get("hotelInfo") or {}
    name_info = hotel_info.get("nameInfo") or {}
    matched_name = str(name_info.get("name") or "").strip()
    if not matched_name:
        return None

    price = _extract_first_visible_ctrip_price(response.text)
    return {
        "matched_name": matched_name,
        "reference_price": price,
        "raw_payload": {
            "matched_name": matched_name,
            "checkin": checkin,
            "checkout": checkout,
            "hotel": first_hotel,
            "visible_price": price,
        },
    }


def build_hotel_payload(*, item: dict, district_hint: str) -> dict | None:
    source_id = str(item.get("id") or "").strip()
    name = str(item.get("name") or "").strip()
    location = str(item.get("location") or "").strip()
    if not source_id or not name or not location:
        return None

    try:
        longitude_text, latitude_text = location.split(",")
        longitude = round(float(longitude_text), 6)
        latitude = round(float(latitude_text), 6)
    except ValueError:
        return None

    biz_ext = item.get("biz_ext") or {}
    reference_price = _safe_float(biz_ext.get("cost"))
    raw_type = str(item.get("type") or "").strip()
    raw_name = str(item.get("name") or "").strip()
    district = str(item.get("adname") or "").strip() or district_hint
    phone = str(item.get("tel") or "").strip()

    return {
        "source": "amap",
        "source_id": source_id,
        "name": raw_name,
        "normalized_name": normalize_name(raw_name),
        "district": district,
        "address": str(item.get("address") or "").strip(),
        "latitude": latitude,
        "longitude": longitude,
        "reference_price": reference_price,
        "phone": phone,
        "category": "酒店",
        "amap_type": raw_type,
        "amap_typecode": str(item.get("typecode") or "").strip(),
        "brand": extract_brand(raw_name),
        "star_level": extract_star_level(raw_name, raw_type),
        "raw_payload": item,
        "notes": build_notes(item, reference_price),
        "is_active": True,
        "last_seen_at": datetime.utcnow(),
    }


def build_tripadvisor_hotel_payload(item: dict) -> dict | None:
    hotel_id = str(item.get("hotelId") or item.get("taLocationId") or item.get("ctripHotelId") or "").strip()
    name = str(item.get("name") or item.get("localName") or item.get("subName") or "").strip()
    latitude = _safe_float(item.get("latitude"))
    longitude = _safe_float(item.get("longitude"))
    if not hotel_id or not name or latitude is None or longitude is None:
        return None

    address = str(item.get("localAddress") or item.get("address") or "").strip()
    district = infer_district(address)
    reference_price = _safe_float(((item.get("prices") or {}) if isinstance(item.get("prices"), dict) else {}).get("price"))
    notes = build_tripadvisor_notes(item, reference_price)

    return {
        "source": "tripadvisor",
        "source_id": f"tripadvisor:{hotel_id}",
        "name": name,
        "normalized_name": normalize_name(name),
        "district": district,
        "address": address,
        "latitude": round(latitude, 6),
        "longitude": round(longitude, 6),
        "reference_price": reference_price,
        "phone": str(item.get("phone") or "").strip(),
        "category": "酒店",
        "amap_type": "",
        "amap_typecode": "",
        "brand": extract_brand(name),
        "star_level": extract_star_level(name, str(item.get("govLevel") or "")),
        "raw_payload": {"tripadvisor": item},
        "notes": notes,
        "is_active": True,
        "last_seen_at": datetime.utcnow(),
    }


def apply_detail_payload(hotel_data: dict, detail: dict) -> dict:
    detail_biz_ext = detail.get("biz_ext") or {}
    detail_price = _safe_float(detail_biz_ext.get("cost"))
    detail_rating = detail_biz_ext.get("rating")
    if detail_price is not None:
        hotel_data["reference_price"] = detail_price
    if detail.get("tel"):
        hotel_data["phone"] = str(detail.get("tel") or "").strip()
    hotel_data["raw_payload"] = detail
    hotel_data["notes"] = build_notes(detail, hotel_data["reference_price"], rating_override=detail_rating)
    return hotel_data


def normalize_name(value: str) -> str:
    return "".join(ch for ch in value if ch.isalnum() or "\u4e00" <= ch <= "\u9fff").lower()


def _is_hotel_like(item: dict) -> bool:
    name = str(item.get("name") or "").strip()
    raw_type = str(item.get("type") or "").strip()
    sample = f"{name} {raw_type}"
    if any(hint in sample for hint in EXCLUDE_HINTS):
        return False
    return any(hint in sample for hint in HOTEL_HINTS)


def extract_brand(name: str) -> str:
    known_brands = (
        "如家",
        "汉庭",
        "全季",
        "亚朵",
        "希尔顿",
        "万豪",
        "锦江",
        "格林豪泰",
        "7天",
        "桔子",
        "喆啡",
    )
    for brand in known_brands:
        if brand in name:
            return brand
    return ""


def extract_star_level(name: str, raw_type: str) -> str:
    sample = f"{name} {raw_type}"
    if "五星" in sample:
        return "五星"
    if "四星" in sample:
        return "四星"
    if "三星" in sample:
        return "三星"
    if "豪华" in sample:
        return "豪华型"
    if "高档" in sample:
        return "高档型"
    if "舒适" in sample:
        return "舒适型"
    return ""


def infer_district(address: str) -> str:
    for district in DISTRICT_HINTS:
        if district in address:
            return district
    return "北京"


def build_notes(item: dict, reference_price: float | None, rating_override: str | float | None = None) -> str:
    note_parts: list[str] = []
    if reference_price is not None:
        note_parts.append(f"高德参考价 {reference_price:.0f} 元")
    biz_ext = item.get("biz_ext") or {}
    rating = rating_override if rating_override not in (None, "") else biz_ext.get("rating")
    if rating not in (None, ""):
        note_parts.append(f"高德评分 {rating}")
    return "；".join(note_parts)


def build_tripadvisor_notes(item: dict, reference_price: float | None) -> str:
    note_parts: list[str] = []
    if reference_price is not None:
        note_parts.append(f"Tripadvisor参考价 {reference_price:.0f} 元")
    review_rating = item.get("reviewRating")
    if review_rating not in (None, ""):
        note_parts.append(f"Tripadvisor评分 {review_rating}")
    ranking = str(item.get("ranking") or "").strip()
    if ranking:
        note_parts.append(ranking)
    return "；".join(note_parts)


def build_ctrip_notes(snapshot: dict[str, Any]) -> str:
    matched_name = str(snapshot.get("matched_name") or "").strip()
    price = _safe_float(snapshot.get("reference_price"))
    if price is None:
        if matched_name:
            return f"携程匹配 {matched_name}，公开页未展示价格"
        return "携程公开页未展示价格"
    return f"携程参考价 {price:.0f} 元"


def merge_notes(current: str, extra: str) -> str:
    current = current.strip()
    extra = extra.strip()
    if not extra:
        return current
    if not current:
        return extra
    if extra in current:
        return current
    return f"{current}；{extra}"


def _safe_float(value: str | float | int | None) -> float | None:
    if value in (None, ""):
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _extract_tripadvisor_page_payload(html: str) -> dict[str, Any]:
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json".*?>(.*?)</script>', html, re.S)
    if not match:
        return {}
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}
    page_props = payload.get("props", {}).get("pageProps", {})
    initial_state = page_props.get("initialState")
    if isinstance(initial_state, dict) and (
        isinstance(initial_state.get("hotelList"), list) or isinstance(initial_state.get("hotels"), list)
    ):
        return initial_state
    page_info = page_props.get("pageInfo")
    if isinstance(page_info, dict):
        return page_info
    return {}


def _extract_ctrip_init_payload(html: str) -> dict[str, Any]:
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json".*?>(.*?)</script>', html, re.S)
    if not match:
        return {}
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}
    page_props = payload.get("props", {}).get("pageProps", {})
    init_list_data = page_props.get("initListData")
    if isinstance(init_list_data, dict):
        return init_list_data
    return {}


def _extract_first_visible_ctrip_price(html: str) -> float | None:
    first_card_start = html.find('<div class="list-item">')
    if first_card_start == -1:
        return None
    second_card_start = html.find('<div class="list-item">', first_card_start + 1)
    if second_card_start == -1:
        second_card_start = min(len(html), first_card_start + 6000)
    first_card = html[first_card_start:second_card_start]

    patterns = (
        r'room-price.*?¥\s*([\d,]{2,5})',
        r'每晚[^¥]{0,40}¥\s*([\d,]{2,5})',
        r'price-line[^<]{0,100}¥\s*([\d,]{2,5})',
        r'price-num[^>]*>\s*¥?\s*([\d,]{2,5})\s*<',
    )
    for pattern in patterns:
        match = re.search(pattern, first_card, re.S)
        if not match:
            continue
        try:
            return float(match.group(1).replace(",", ""))
        except ValueError:
            continue
    return None


def _upsert_hotel_record(
    db,
    repository: HotelRepository,
    hotel_data: dict[str, Any],
    *,
    replace: bool,
    allow_merge: bool,
) -> str:
    current = repository.get_by_source_id(db, hotel_data["source_id"])
    if current is not None:
        if replace:
            repository.update_from_dict(current, hotel_data)
            return "updated"
        repository.update_from_dict(
            current,
            {
                "reference_price": hotel_data["reference_price"] or current.reference_price,
                "phone": hotel_data["phone"] or current.phone,
                "raw_payload": _merge_external_payload(current.raw_payload, hotel_data["source"], hotel_data["raw_payload"]),
                "notes": merge_notes(current.notes, hotel_data["notes"]),
                "is_active": True,
                "last_seen_at": hotel_data["last_seen_at"],
            },
        )
        return "updated"

    if allow_merge:
        matched = _find_similar_hotel(db, repository, hotel_data)
        if matched is not None:
            updates: dict[str, Any] = {
                "phone": matched.phone or hotel_data["phone"],
                "reference_price": matched.reference_price if matched.reference_price is not None else hotel_data["reference_price"],
                "raw_payload": _merge_external_payload(matched.raw_payload, hotel_data["source"], hotel_data["raw_payload"]),
                "notes": merge_notes(matched.notes, hotel_data["notes"]),
                "last_seen_at": hotel_data["last_seen_at"],
                "is_active": True,
            }
            repository.update_from_dict(matched, updates)
            return "merged"

    repository.add(db, hotel_data)
    return "inserted"


def _find_similar_hotel(db, repository: HotelRepository, hotel_data: dict[str, Any]) -> HotelPOI | None:
    candidates = repository.list_by_normalized_name(db, hotel_data["normalized_name"])
    for candidate in candidates:
        distance = _distance_meters(
            candidate.longitude,
            candidate.latitude,
            float(hotel_data["longitude"]),
            float(hotel_data["latitude"]),
        )
        if distance <= 150:
            return candidate
    return None


def _merge_external_payload(raw_payload: Any, source: str, external_payload: dict[str, Any]) -> dict[str, Any]:
    base = raw_payload.copy() if isinstance(raw_payload, dict) else {}
    external_sources = base.get("external_sources")
    if not isinstance(external_sources, dict):
        external_sources = {}
    external_sources[source] = external_payload
    base["external_sources"] = external_sources
    return base


def _names_look_similar(left: str, right: str) -> bool:
    if not left or not right:
        return False
    if left == right:
        return True
    if left in right or right in left:
        return True
    return SequenceMatcher(None, left, right).ratio() >= 0.82


def _distance_meters(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 6371000.0
    lon1_rad = math.radians(lon1)
    lat1_rad = math.radians(lat1)
    lon2_rad = math.radians(lon2)
    lat2_rad = math.radians(lat2)
    delta_lon = lon2_rad - lon1_rad
    delta_lat = lat2_rad - lat1_rad
    hav = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(hav))
