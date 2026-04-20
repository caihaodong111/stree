import argparse

from app.tasks.official_poi_sync import sync_official_pois


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync official Beijing scenic POIs into MySQL.")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace existing rows matched by scenic spot name.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only sync the first N official scenic spots for smoke testing.",
    )
    args = parser.parse_args()

    result = sync_official_pois(replace=args.replace, limit=args.limit)
    print(
        "official sync completed: "
        f"total={result['total']}, inserted={result['inserted']}, "
        f"updated={result['updated']}, skipped={result['skipped']}, replace={args.replace}"
    )


if __name__ == "__main__":
    main()
