from app.core.database import Base, engine
import app.models.hotel  # noqa: F401
import app.models.poi  # noqa: F401
import app.models.route_plan  # noqa: F401


def main() -> None:
    Base.metadata.create_all(bind=engine)
    print("database schema initialized")


if __name__ == "__main__":
    main()
