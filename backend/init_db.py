from app.core.database import Base, engine
from app.models import poi, route_plan  # noqa: F401


def main() -> None:
    Base.metadata.create_all(bind=engine)
    print("database schema initialized")


if __name__ == "__main__":
    main()
