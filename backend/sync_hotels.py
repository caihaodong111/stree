import argparse

from app.tasks.hotel_browser_price_sync import (
    enrich_hotel_ids_from_browser,
    enrich_hotel_prices_from_browser,
    open_login_browser,
)
from app.tasks.hotel_sync import (
    DEFAULT_DISTRICTS,
    enrich_hotel_prices_from_ctrip,
    sync_hotels_from_amap,
    sync_hotels_from_tripadvisor,
)


def resolve_districts(
    explicit_districts: list[str] | None,
    *,
    batch_size: int | None,
    batch_index: int | None,
) -> list[str] | None:
    if explicit_districts:
        return explicit_districts
    if not batch_size:
        return None

    safe_batch_size = max(1, batch_size)
    safe_batch_index = max(1, batch_index or 1)
    start = (safe_batch_index - 1) * safe_batch_size
    end = start + safe_batch_size
    districts = list(DEFAULT_DISTRICTS[start:end])
    if not districts:
        raise ValueError("District batch is out of range.")
    return districts


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Beijing hotel POIs and enrich hotel prices.")
    parser.add_argument(
        "--source",
        choices=("amap", "tripadvisor", "all"),
        default="all",
        help="Hotel coverage source to run.",
    )
    parser.add_argument("--replace", action="store_true", help="Update existing rows and mark unseen rows inactive.")
    parser.add_argument("--limit", type=int, default=None, help="Maximum number of processed hotel rows.")
    parser.add_argument("--district", action="append", dest="districts", help="Restrict sync to specific Beijing districts.")
    parser.add_argument(
        "--district-batch-size",
        type=int,
        default=None,
        help="Process default Beijing districts in batches of this size.",
    )
    parser.add_argument(
        "--district-batch-index",
        type=int,
        default=1,
        help="1-based batch index when using --district-batch-size.",
    )
    parser.add_argument("--keyword", action="append", dest="keywords", help="Restrict sync to specific hotel keywords.")
    parser.add_argument("--pages-per-keyword", type=int, default=3, help="Page count per district-keyword query.")
    parser.add_argument("--around-pages", type=int, default=2, help="Page count per around-grid query.")
    parser.add_argument("--around-radius", type=int, default=9000, help="Radius in meters for around-grid queries.")
    parser.add_argument("--tripadvisor-pages", type=int, default=12, help="Page count for Tripadvisor hotel list pages.")
    parser.add_argument("--skip-price-enrich", action="store_true", help="Skip the second price source enrichment pass.")
    parser.add_argument("--price-limit", type=int, default=50, help="Maximum hotel rows to run through price enrichment.")
    parser.add_argument(
        "--price-district",
        default=None,
        help="Restrict the price enrichment pass to one district.",
    )
    parser.add_argument(
        "--price-include-priced",
        action="store_true",
        help="Include hotels that already have reference_price when running price enrichment.",
    )
    parser.add_argument(
        "--browser-id-provider",
        choices=("ctrip", "meituan"),
        default=None,
        help="Run the OTA browser-based hotel ID enrichment pass before browser price enrichment.",
    )
    parser.add_argument(
        "--browser-id-limit",
        type=int,
        default=5,
        help="Maximum hotel rows to run through OTA browser-based hotel ID enrichment.",
    )
    parser.add_argument(
        "--browser-price-provider",
        choices=("ctrip", "meituan"),
        default=None,
        help="Run the OTA browser-based price enrichment pass after the normal sync.",
    )
    parser.add_argument(
        "--browser-price-limit",
        type=int,
        default=5,
        help="Maximum hotel rows to run through OTA browser-based price enrichment.",
    )
    parser.add_argument(
        "--browser-price-headed",
        action="store_true",
        help="Launch the browser in headed mode for OTA browser-based price enrichment.",
    )
    parser.add_argument(
        "--browser-profile-dir",
        default=None,
        help="Persistent Playwright profile directory for logged-in OTA sessions.",
    )
    parser.add_argument(
        "--browser-open-provider",
        choices=("ctrip", "meituan"),
        default=None,
        help="Open a persistent login browser window and keep it alive for manual login.",
    )
    parser.add_argument(
        "--browser-open-seconds",
        type=int,
        default=900,
        help="How long to keep the manual login browser window open.",
    )
    args = parser.parse_args()

    districts = resolve_districts(
        args.districts,
        batch_size=args.district_batch_size,
        batch_index=args.district_batch_index,
    )

    results: dict[str, dict] = {}
    if args.source in {"amap", "all"}:
        results["amap"] = sync_hotels_from_amap(
            replace=args.replace,
            limit=args.limit,
            districts=districts,
            keywords=args.keywords,
            pages_per_keyword=args.pages_per_keyword,
            around_pages=args.around_pages,
            around_radius_meters=args.around_radius,
        )

    if args.source in {"tripadvisor", "all"}:
        results["tripadvisor"] = sync_hotels_from_tripadvisor(
            replace=args.replace,
            max_pages=args.tripadvisor_pages,
            limit=args.limit,
        )

    if not args.skip_price_enrich:
        results["ctrip_price"] = enrich_hotel_prices_from_ctrip(
            limit=args.price_limit,
            district=args.price_district,
            only_missing=not args.price_include_priced,
        )

    if args.browser_open_provider:
        if not args.browser_profile_dir:
            raise ValueError("--browser-profile-dir is required when using --browser-open-provider.")
        results["browser_open"] = open_login_browser(
            provider=args.browser_open_provider,
            profile_dir=args.browser_profile_dir,
            headless=False,
            wait_seconds=args.browser_open_seconds,
        )

    if args.browser_id_provider:
        results["browser_id"] = enrich_hotel_ids_from_browser(
            provider=args.browser_id_provider,
            limit=args.browser_id_limit,
            district=args.price_district,
            only_missing=not args.price_include_priced,
            headless=not args.browser_price_headed,
            profile_dir=args.browser_profile_dir,
        )

    if args.browser_price_provider:
        results["browser_price"] = enrich_hotel_prices_from_browser(
            provider=args.browser_price_provider,
            limit=args.browser_price_limit,
            district=args.price_district,
            only_missing=not args.price_include_priced,
            headless=not args.browser_price_headed,
            profile_dir=args.browser_profile_dir,
        )

    print(results)


if __name__ == "__main__":
    main()
