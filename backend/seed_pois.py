import argparse

from app.core.database import SessionLocal
from app.data.beijing_pois import BEIJING_POIS
from app.repositories.poi_repository import POIRepository


def seed(replace: bool = False) -> None:
    repository = POIRepository()
    inserted = 0
    updated = 0

    with SessionLocal() as db:
        for poi_data in BEIJING_POIS:
            current = repository.get_by_name(db, poi_data["name"])
            if current is None:
                repository.add(db, poi_data)
                inserted += 1
                continue

            if replace:
                repository.update_from_dict(current, poi_data)
                updated += 1

        db.commit()

    print(f"seed completed: inserted={inserted}, updated={updated}, replace={replace}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed Beijing POIs into MySQL.")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace existing rows matched by scenic spot name.",
    )
    args = parser.parse_args()
    seed(replace=args.replace)


if __name__ == "__main__":
    main()
