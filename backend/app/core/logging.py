import logging

from app.core.config import settings


def configure_logging() -> None:
    level_name = settings.log_level.upper()
    level = getattr(logging, level_name, logging.INFO)

    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

    if settings.ai_logging_enabled:
        logging.getLogger("app.ai").setLevel(level)
    else:
        logging.getLogger("app.ai").setLevel(logging.WARNING)
