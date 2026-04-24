from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
import math
from pathlib import Path
import re
from typing import Any

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from app.core.database import SessionLocal
from app.models.hotel import HotelPOI
from app.repositories.hotel_repository import HotelRepository
from app.tasks.hotel_sync import merge_notes, normalize_name

DEFAULT_BROWSER_PRICE_LIMIT = 10
DEFAULT_HEADLESS = True


@dataclass(frozen=True)
class BrowserSessionConfig:
    headless: bool = DEFAULT_HEADLESS
    profile_dir: str | None = None


def enrich_hotel_ids_from_browser(
    *,
    provider: str = "ctrip",
    limit: int = DEFAULT_BROWSER_PRICE_LIMIT,
    district: str | None = None,
    only_missing: bool = True,
    headless: bool = DEFAULT_HEADLESS,
    profile_dir: str | None = None,
) -> dict[str, int | str]:
    repository = HotelRepository()
    checked = 0
    matched = 0
    updated = 0
    failed = 0

    with SessionLocal() as db:
        hotels = _select_browser_id_hotels(
            repository,
            db,
            provider=provider,
            district=district,
            limit=limit,
            only_missing=only_missing,
        )

        session_config = BrowserSessionConfig(headless=headless, profile_dir=profile_dir)

        with sync_playwright() as playwright:
            context = _launch_browser_context(playwright, session_config)
            try:
                page = context.new_page()

                for hotel in hotels:
                    checked += 1
                    try:
                        snapshot = _fetch_browser_id_snapshot(
                            page,
                            provider=provider,
                            hotel=hotel,
                        )
                    except (PlaywrightTimeoutError, PlaywrightError):
                        failed += 1
                        continue

                    matched_name = str(snapshot.get("matched_name") or "")
                    provider_hotel_id = str(snapshot.get("provider_hotel_id") or "")
                    notes = snapshot.get("notes") or ""
                    if matched_name and _names_look_similar(hotel.normalized_name, normalize_name(matched_name)):
                        matched += 1
                    if provider_hotel_id:
                        targets = _related_hotels_for_sync(repository, db, hotel)
                        for target in targets:
                            target.raw_payload = _merge_provider_payload(
                                target.raw_payload,
                                provider=provider,
                                provider_payload=snapshot.get("raw_payload") or {},
                            )
                            if notes:
                                target.notes = merge_notes(target.notes, notes)
                            target.last_seen_at = datetime.utcnow()
                            target.is_active = True
                        updated += 1
                    elif notes:
                        hotel.notes = merge_notes(hotel.notes, notes)
                        hotel.last_seen_at = datetime.utcnow()
                        hotel.is_active = True

                db.commit()
            finally:
                context.close()

    return {
        "provider": provider,
        "checked": checked,
        "matched": matched,
        "updated": updated,
        "failed": failed,
    }


def enrich_hotel_prices_from_browser(
    *,
    provider: str = "ctrip",
    limit: int = DEFAULT_BROWSER_PRICE_LIMIT,
    district: str | None = None,
    only_missing: bool = True,
    headless: bool = DEFAULT_HEADLESS,
    profile_dir: str | None = None,
) -> dict[str, int | str]:
    repository = HotelRepository()
    checked = 0
    matched = 0
    updated = 0
    no_price = 0
    blocked = 0
    failed = 0

    with SessionLocal() as db:
        hotels = _select_browser_price_hotels(
            repository,
            db,
            provider=provider,
            district=district,
            limit=limit,
            only_missing=only_missing,
        )

        session_config = BrowserSessionConfig(headless=headless, profile_dir=profile_dir)

        with sync_playwright() as playwright:
            context = _launch_browser_context(playwright, session_config)
            try:
                page = context.new_page()

                for hotel in hotels:
                    checked += 1
                    try:
                        snapshot = _fetch_browser_price_snapshot(
                            page,
                            provider=provider,
                            hotel=hotel,
                        )
                    except (PlaywrightTimeoutError, PlaywrightError):
                        failed += 1
                        continue

                    status = str(snapshot.get("status") or "")
                    matched_name = str(snapshot.get("matched_name") or "")
                    price = snapshot.get("reference_price")
                    notes = snapshot.get("notes") or ""

                    if status == "blocked":
                        blocked += 1
                    if matched_name and _names_look_similar(hotel.normalized_name, normalize_name(matched_name)):
                        matched += 1
                    if price is None:
                        no_price += 1
                        hotel.raw_payload = _merge_browser_payload(
                            hotel.raw_payload,
                            provider=provider,
                            browser_payload=snapshot.get("raw_payload") or {},
                        )
                        if notes:
                            hotel.notes = merge_notes(hotel.notes, notes)
                        hotel.last_seen_at = datetime.utcnow()
                        hotel.is_active = True
                    else:
                        targets = _related_hotels_for_sync(repository, db, hotel)
                        for target in targets:
                            target.reference_price = float(price)
                            target.raw_payload = _merge_browser_payload(
                                target.raw_payload,
                                provider=provider,
                                browser_payload=snapshot.get("raw_payload") or {},
                            )
                            if notes:
                                target.notes = merge_notes(target.notes, notes)
                            target.last_seen_at = datetime.utcnow()
                            target.is_active = True
                        updated += 1

                db.commit()
            finally:
                context.close()

    return {
        "provider": provider,
        "checked": checked,
        "matched": matched,
        "updated": updated,
        "no_price": no_price,
        "blocked": blocked,
        "failed": failed,
    }


def _fetch_browser_price_snapshot(page, *, provider: str, hotel: HotelPOI) -> dict[str, Any]:
    if provider == "ctrip":
        return _fetch_ctrip_snapshot(page, hotel)
    if provider == "meituan":
        return _fetch_meituan_snapshot(page, hotel)
    raise ValueError(f"Unsupported browser price provider: {provider}")


def _fetch_browser_id_snapshot(page, *, provider: str, hotel: HotelPOI) -> dict[str, Any]:
    if provider == "ctrip":
        return _search_ctrip_hotel_id(page, hotel)
    if provider == "meituan":
        return _search_meituan_hotel_id(page, hotel)
    raise ValueError(f"Unsupported browser ID provider: {provider}")


def open_login_browser(
    *,
    provider: str,
    profile_dir: str,
    headless: bool = False,
    wait_seconds: int = 900,
) -> dict[str, Any]:
    session_config = BrowserSessionConfig(headless=headless, profile_dir=profile_dir)

    with sync_playwright() as playwright:
        context = _launch_browser_context(playwright, session_config)
        try:
            page = context.new_page()
            if provider == "ctrip":
                page.goto("https://m.ctrip.com/webapp/hotel/beijing1/list", wait_until="domcontentloaded", timeout=45000)
            elif provider == "meituan":
                page.goto("https://i.meituan.com/", wait_until="domcontentloaded", timeout=45000)
            else:
                raise ValueError(f"Unsupported browser login provider: {provider}")
            page.wait_for_timeout(max(1, wait_seconds) * 1000)
            return {
                "provider": provider,
                "profile_dir": profile_dir,
                "final_url": page.url,
                "title": page.title(),
            }
        finally:
            context.close()


def _fetch_ctrip_snapshot(page, hotel: HotelPOI) -> dict[str, Any]:
    ctrip_hotel_id = _extract_ctrip_hotel_id(hotel)
    if not ctrip_hotel_id:
        return {
            "status": "no_source_id",
            "matched_name": "",
            "reference_price": None,
            "notes": "OTA浏览器补价：缺少携程酒店ID，暂无法直连详情页",
            "raw_payload": {"provider": "ctrip", "status": "no_source_id"},
        }

    room_payload_holder: dict[str, Any] = {}

    def handle_response(resp) -> None:
        if "33278/getHotelRoomListInland" not in resp.url:
            return
        try:
            room_payload_holder["url"] = resp.url
            room_payload_holder["json"] = resp.json()
        except Exception as exc:
            room_payload_holder["error"] = str(exc)

    page.on("response", handle_response)
    try:
        url = f"https://m.ctrip.com/html5/hotel/hoteldetail/{ctrip_hotel_id}.html"
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(8000)

        current_url = page.url
        title = page.title()
        body_text = page.locator("body").inner_text(timeout=15000)
        detail_name = _extract_ctrip_detail_name(title, body_text) or hotel.name

        room_json = room_payload_holder.get("json")
        if isinstance(room_json, dict):
            room_data = room_json.get("data") or {}
            bar_info = room_data.get("hotelDetailBarInfo") or {}
            price = _safe_float(bar_info.get("price"))
            check_in_info = ((room_data.get("calendarInfo") or {}).get("checkInInfo") or {}).get("date")
            check_out_info = ((room_data.get("calendarInfo") or {}).get("checkOutInfo") or {}).get("date")
            if price is not None:
                return {
                    "status": "ok",
                    "matched_name": detail_name,
                    "reference_price": price,
                    "notes": f"OTA浏览器补价：携程H5参考价 {price:.0f} 元",
                    "raw_payload": {
                        "provider": "ctrip",
                        "url": current_url,
                        "title": title,
                        "ctrip_hotel_id": ctrip_hotel_id,
                        "matched_name": detail_name,
                        "price": price,
                        "check_in": check_in_info,
                        "check_out": check_out_info,
                        "room_api_url": room_payload_holder.get("url", ""),
                    },
                }

        if "/login" in current_url or "登录" in title:
            return {
                "status": "blocked",
                "matched_name": "",
                "reference_price": None,
                "notes": "OTA浏览器补价：携程详情页跳转登录或风控页",
                "raw_payload": {
                    "provider": "ctrip",
                    "url": current_url,
                    "title": title,
                    "status": "blocked",
                },
            }

        return {
            "status": "no_price",
            "matched_name": detail_name,
            "reference_price": _extract_first_price(body_text),
            "notes": "OTA浏览器补价：详情页已打开，但未拿到H5房型接口价格",
            "raw_payload": {
                "provider": "ctrip",
                "url": current_url,
                "title": title,
                "ctrip_hotel_id": ctrip_hotel_id,
                "captured_text": body_text[:1500],
                "room_api_error": room_payload_holder.get("error", ""),
            },
        }
    finally:
        try:
            page.remove_listener("response", handle_response)
        except Exception:
            pass


def _fetch_meituan_snapshot(page, hotel: HotelPOI) -> dict[str, Any]:
    meituan_hotel_id = _extract_meituan_hotel_id(hotel)
    if not meituan_hotel_id:
        return {
            "status": "no_source_id",
            "matched_name": "",
            "reference_price": None,
            "notes": "OTA浏览器补价：缺少美团酒店ID，暂无法直连详情页",
            "raw_payload": {"provider": "meituan", "status": "no_source_id"},
        }

    detail_url = f"https://i.meituan.com/hotel/detail/{meituan_hotel_id}.html"
    page.goto(detail_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(8000)

    current_url = page.url
    title = page.title()
    body_text = page.locator("body").inner_text(timeout=15000)
    detail_name = _extract_meituan_detail_name(title, body_text) or hotel.name
    price = _extract_first_price(body_text)

    status = "ok" if price is not None else "no_price"
    notes = (
        f"OTA浏览器补价：美团参考价 {price:.0f} 元"
        if price is not None
        else "OTA浏览器补价：美团详情页已打开，但未识别到可用价格"
    )
    return {
        "status": status,
        "matched_name": detail_name,
        "reference_price": price,
        "notes": notes,
        "raw_payload": {
            "provider": "meituan",
            "url": current_url,
            "title": title,
            "meituan_hotel_id": meituan_hotel_id,
            "matched_name": detail_name,
            "price": price,
            "captured_text": body_text[:1500],
        },
    }


def _search_ctrip_hotel_id(page, hotel: HotelPOI) -> dict[str, Any]:
    holder: dict[str, Any] = {}

    def handle_response(resp) -> None:
        if "fetchHotelInfoList" not in resp.url:
            return
        try:
            holder["url"] = resp.url
            holder["json"] = resp.json()
        except Exception as exc:
            holder["error"] = str(exc)

    page.on("response", handle_response)
    try:
        page.goto("https://m.ctrip.com/webapp/hotel/beijing1/list", wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(3500)
        page.get_by_text("位置/品牌/酒店").first.click(timeout=10000)
        page.wait_for_timeout(1000)
        search_input = page.locator("input").first
        search_input.fill("")
        search_input.fill(hotel.name, timeout=5000)
        page.wait_for_timeout(1200)
        search_input.press("Enter")
        page.wait_for_timeout(7000)

        response_json = holder.get("json")
        if not isinstance(response_json, dict):
            return {
                "status": "no_result",
                "matched_name": "",
                "provider_hotel_id": "",
                "notes": "OTA ID匹配：携程搜索未返回可解析的酒店列表",
                "raw_payload": {
                    "provider": "ctrip",
                    "status": "no_result",
                    "search_name": hotel.name,
                    "response_url": holder.get("url", ""),
                    "response_error": holder.get("error", ""),
                },
            }

        candidate = _pick_ctrip_hotel_candidate(hotel, response_json)
        if candidate is None:
            return {
                "status": "no_match",
                "matched_name": "",
                "provider_hotel_id": "",
                "notes": "OTA ID匹配：携程搜索已返回结果，但未找到足够接近的酒店",
                "raw_payload": {
                    "provider": "ctrip",
                    "status": "no_match",
                    "search_name": hotel.name,
                    "response_url": holder.get("url", ""),
                },
            }

        provider_hotel_id = str(candidate.get("hotel_id") or "")
        matched_name = str(candidate.get("matched_name") or "")
        distance = candidate.get("distance_meters")
        price = candidate.get("reference_price")
        note_parts = [f"OTA ID匹配：携程候选 {matched_name}"]
        if distance is not None:
            note_parts.append(f"距离约 {distance:.0f} 米")
        if price is not None:
            note_parts.append(f"列表参考价 {price:.0f} 元")
        return {
            "status": "ok",
            "matched_name": matched_name,
            "provider_hotel_id": provider_hotel_id,
            "notes": "，".join(note_parts),
            "raw_payload": {
                "provider": "ctrip",
                "ctripHotelId": provider_hotel_id,
                "matched_name": matched_name,
                "distance_meters": distance,
                "reference_price": price,
                "search_name": hotel.name,
                "response_url": holder.get("url", ""),
                "candidate": candidate.get("raw_payload") or {},
            },
        }
    finally:
        try:
            page.remove_listener("response", handle_response)
        except Exception:
            pass


def _search_meituan_hotel_id(page, hotel: HotelPOI) -> dict[str, Any]:
    search_url = f"https://i.meituan.com/s/{hotel.name}"
    page.goto(search_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(6000)

    current_url = page.url
    title = page.title()
    body_text = page.locator("body").inner_text(timeout=15000)
    content = page.content()
    candidate = _extract_first_meituan_hotel_candidate(content, body_text, hotel.name)
    if candidate is None:
        return {
            "status": "no_match",
            "matched_name": "",
            "provider_hotel_id": "",
            "notes": "OTA ID匹配：美团搜索页未识别到足够接近的酒店",
            "raw_payload": {
                "provider": "meituan",
                "status": "no_match",
                "search_name": hotel.name,
                "url": current_url,
                "title": title,
                "captured_text": body_text[:1200],
            },
        }

    provider_hotel_id = str(candidate.get("hotel_id") or "")
    matched_name = str(candidate.get("matched_name") or "")
    return {
        "status": "ok",
        "matched_name": matched_name,
        "provider_hotel_id": provider_hotel_id,
        "notes": f"OTA ID匹配：美团候选 {matched_name}",
        "raw_payload": {
            "provider": "meituan",
            "meituanHotelId": provider_hotel_id,
            "matched_name": matched_name,
            "search_name": hotel.name,
            "url": current_url,
            "title": title,
        },
    }


def _extract_first_hotel_name(body_text: str) -> str:
    for line in body_text.splitlines():
        line = line.strip()
        if not line:
            continue
        if "酒店" in line or "宾馆" in line or "民宿" in line or "旅馆" in line:
            return line
    return ""


def _extract_ctrip_detail_name(title: str, body_text: str) -> str:
    match = re.search(r"携程酒店-(.*?)(?:预订|价格)", title)
    if match:
        return match.group(1).strip()
    return _extract_first_hotel_name(body_text)


def _extract_meituan_detail_name(title: str, body_text: str) -> str:
    match = re.search(r"(.*?)(?:预订|团购|价格|美团)", title)
    if match:
        candidate = match.group(1).strip()
        if candidate:
            return candidate
    return _extract_first_hotel_name(body_text)


def _extract_first_price(body_text: str) -> float | None:
    patterns = (
        r"¥\s*([\d,]{2,5})",
        r"￥\s*([\d,]{2,5})",
        r"([\d,]{2,5})\s*元",
    )
    for pattern in patterns:
        match = re.search(pattern, body_text)
        if not match:
            continue
        try:
            value = float(match.group(1).replace(",", ""))
        except ValueError:
            continue
        if 50 <= value <= 20000:
            return value
    return None


def _merge_browser_payload(raw_payload: Any, *, provider: str, browser_payload: dict[str, Any]) -> dict[str, Any]:
    base = raw_payload.copy() if isinstance(raw_payload, dict) else {}
    external_sources = base.get("external_sources")
    if not isinstance(external_sources, dict):
        external_sources = {}
    browser_sources = external_sources.get("browser")
    if not isinstance(browser_sources, dict):
        browser_sources = {}
    browser_sources[provider] = browser_payload
    external_sources["browser"] = browser_sources
    base["external_sources"] = external_sources
    return base


def _merge_provider_payload(raw_payload: Any, *, provider: str, provider_payload: dict[str, Any]) -> dict[str, Any]:
    base = raw_payload.copy() if isinstance(raw_payload, dict) else {}
    external_sources = base.get("external_sources")
    if not isinstance(external_sources, dict):
        external_sources = {}
    current = external_sources.get(provider)
    if isinstance(current, dict):
        merged = current.copy()
        merged.update(provider_payload)
        external_sources[provider] = merged
    else:
        external_sources[provider] = provider_payload
    base["external_sources"] = external_sources
    return base


def _names_look_similar(left: str, right: str) -> bool:
    if not left or not right:
        return False
    if left == right:
        return True
    if left in right or right in left:
        return True
    shorter = min(len(left), len(right))
    longer = max(len(left), len(right))
    return shorter / longer >= 0.75


def _browser_user_agent() -> str:
    return (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36"
    )


def _extract_ctrip_hotel_id(hotel: HotelPOI) -> str:
    raw_payload = hotel.raw_payload if isinstance(hotel.raw_payload, dict) else {}
    if hotel.source == "tripadvisor":
        tripadvisor_payload = raw_payload.get("tripadvisor") or {}
        candidate = tripadvisor_payload.get("ctripHotelId")
        if candidate:
            return str(candidate)

    external_sources = raw_payload.get("external_sources")
    if isinstance(external_sources, dict):
        ctrip_payload = external_sources.get("ctrip") or {}
        if isinstance(ctrip_payload, dict):
            candidate = ctrip_payload.get("ctripHotelId")
            if candidate:
                return str(candidate)
        tripadvisor_payload = external_sources.get("tripadvisor") or {}
        if isinstance(tripadvisor_payload, dict):
            candidate = tripadvisor_payload.get("ctripHotelId")
            if candidate:
                return str(candidate)

    return ""


def _extract_meituan_hotel_id(hotel: HotelPOI) -> str:
    raw_payload = hotel.raw_payload if isinstance(hotel.raw_payload, dict) else {}
    external_sources = raw_payload.get("external_sources")
    if isinstance(external_sources, dict):
        meituan_payload = external_sources.get("meituan") or {}
        if isinstance(meituan_payload, dict):
            candidate = meituan_payload.get("meituanHotelId")
            if candidate:
                return str(candidate)
    return ""


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _select_browser_price_hotels(
    repository: HotelRepository,
    db,
    *,
    provider: str,
    district: str | None,
    limit: int,
    only_missing: bool,
) -> list[HotelPOI]:
    pool_limit = max(limit * 20, 200)
    pool = (
        repository.list_missing_prices(db, district=district, limit=pool_limit)
        if only_missing
        else repository.list_all(db, district=district, limit=pool_limit)
    )
    selected: list[HotelPOI] = []
    for hotel in pool:
        if provider == "ctrip" and not _extract_ctrip_hotel_id(hotel):
            continue
        if provider == "meituan" and not _extract_meituan_hotel_id(hotel):
            continue
        selected.append(hotel)
        if len(selected) >= limit:
            break
    return selected


def _select_browser_id_hotels(
    repository: HotelRepository,
    db,
    *,
    provider: str,
    district: str | None,
    limit: int,
    only_missing: bool,
) -> list[HotelPOI]:
    pool_limit = max(limit * 30, 300)
    pool = (
        repository.list_missing_prices(db, district=district, limit=pool_limit)
        if only_missing
        else repository.list_all(db, district=district, limit=pool_limit)
    )
    selected: list[HotelPOI] = []
    for hotel in pool:
        if provider == "ctrip" and _extract_ctrip_hotel_id(hotel):
            continue
        if provider == "meituan" and _extract_meituan_hotel_id(hotel):
            continue
        selected.append(hotel)
        if len(selected) >= limit:
            break
    return selected


def _pick_ctrip_hotel_candidate(hotel: HotelPOI, response_json: dict[str, Any]) -> dict[str, Any] | None:
    hotel_list = ((((response_json.get("data") or {}).get("hotelListInfo") or {}).get("hotelInfoList")) or [])
    candidates: list[dict[str, Any]] = []
    for item in hotel_list:
        if not isinstance(item, dict):
            continue
        base_info = item.get("baseInfo") or {}
        base_ui_info = item.get("baseUIInfo") or {}
        name_info = base_ui_info.get("name") or {}
        matched_name = str(name_info.get("hotelName") or "").strip()
        hotel_id = base_info.get("hotelId")
        if not matched_name or not hotel_id:
            continue

        candidate_normalized_name = normalize_name(matched_name)
        similarity = 0.0
        if hotel.normalized_name and candidate_normalized_name:
            if hotel.normalized_name == candidate_normalized_name:
                similarity = 1.0
            elif hotel.normalized_name in candidate_normalized_name or candidate_normalized_name in hotel.normalized_name:
                similarity = min(len(hotel.normalized_name), len(candidate_normalized_name)) / max(
                    len(hotel.normalized_name), len(candidate_normalized_name)
                )
            else:
                similarity = SequenceMatcher(None, hotel.normalized_name, candidate_normalized_name).ratio()

        distance = _extract_ctrip_distance_meters(hotel, base_info)
        price = _extract_ctrip_list_price(item)
        candidates.append(
            {
                "hotel_id": str(hotel_id),
                "matched_name": matched_name,
                "distance_meters": distance,
                "reference_price": price,
                "similarity": similarity,
                "raw_payload": item,
            }
        )

    if not candidates:
        return None

    candidates.sort(
        key=lambda item: (
            -(item["similarity"] or 0.0),
            item["distance_meters"] if item["distance_meters"] is not None else 10**9,
        )
    )
    best = candidates[0]
    similarity = float(best.get("similarity") or 0.0)
    distance = best.get("distance_meters")
    if similarity >= 0.92:
        return best
    if similarity >= 0.82 and distance is not None and distance <= 1200:
        return best
    if similarity >= 0.72 and distance is not None and distance <= 150:
        return best
    return None


def _extract_ctrip_distance_meters(hotel: HotelPOI, base_info: dict[str, Any]) -> float | None:
    hotel_coordinate = base_info.get("hotelCoordinate") or {}
    coordinate_list = hotel_coordinate.get("coordinateList") or []
    for item in coordinate_list:
        if not isinstance(item, dict):
            continue
        latitude = _safe_float(item.get("latitude"))
        longitude = _safe_float(item.get("longitude"))
        if latitude is None or longitude is None:
            continue
        return _distance_meters(hotel.longitude, hotel.latitude, longitude, latitude)
    return None


def _extract_ctrip_list_price(item: dict[str, Any]) -> float | None:
    price_info = item.get("priceInfo") or {}
    if not isinstance(price_info, dict):
        return None
    for key in ("price", "discountPrice", "salePrice", "finalPrice"):
        value = _safe_float(price_info.get(key))
        if value is not None:
            return value
    return None


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


def _extract_first_meituan_hotel_candidate(html: str, body_text: str, hotel_name: str) -> dict[str, str] | None:
    normalized_target = normalize_name(hotel_name)
    matches: list[dict[str, str | float]] = []

    for match in re.finditer(r"/hotel/(\d+)\.html", html):
        hotel_id = match.group(1)
        context = html[max(0, match.start() - 500): min(len(html), match.end() + 500)]
        name_match = re.search(r'>([^<>]{2,80}(?:酒店|宾馆|旅馆|民宿|客栈|青旅|公寓))<', context)
        matched_name = name_match.group(1).strip() if name_match else ""
        if not matched_name:
            continue
        similarity = SequenceMatcher(None, normalized_target, normalize_name(matched_name)).ratio()
        matches.append({"hotel_id": hotel_id, "matched_name": matched_name, "similarity": similarity})

    if not matches:
        for line in body_text.splitlines():
            line = line.strip()
            if not line:
                continue
            if not any(token in line for token in ("酒店", "宾馆", "旅馆", "民宿", "客栈", "青旅", "公寓")):
                continue
            similarity = SequenceMatcher(None, normalized_target, normalize_name(line)).ratio()
            matches.append({"hotel_id": "", "matched_name": line, "similarity": similarity})

    matches.sort(key=lambda item: -(float(item.get("similarity") or 0.0)))
    if not matches:
        return None
    best = matches[0]
    if float(best.get("similarity") or 0.0) < 0.72:
        return None
    return {"hotel_id": str(best.get("hotel_id") or ""), "matched_name": str(best.get("matched_name") or "")}


def _launch_browser_context(playwright, session_config: BrowserSessionConfig):
    if session_config.profile_dir:
        profile_path = Path(session_config.profile_dir).expanduser().resolve()
        profile_path.mkdir(parents=True, exist_ok=True)
        return playwright.chromium.launch_persistent_context(
            user_data_dir=str(profile_path),
            headless=session_config.headless,
            locale="zh-CN",
            user_agent=_browser_user_agent(),
        )

    browser = playwright.chromium.launch(headless=session_config.headless)
    return browser.new_context(locale="zh-CN", user_agent=_browser_user_agent())


def _related_hotels_for_sync(repository: HotelRepository, db, hotel: HotelPOI) -> list[HotelPOI]:
    candidates = repository.list_by_normalized_name(db, hotel.normalized_name)
    related: list[HotelPOI] = []
    seen_ids: set[int] = set()
    for candidate in candidates:
        if candidate.id in seen_ids:
            continue
        if (
            _distance_meters(hotel.longitude, hotel.latitude, candidate.longitude, candidate.latitude)
            <= 500
        ):
            related.append(candidate)
            seen_ids.add(candidate.id)
    if hotel.id not in seen_ids:
        related.append(hotel)
    return related
