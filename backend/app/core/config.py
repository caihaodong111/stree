from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = Field(default="STREE Beijing Travel Planner", alias="APP_NAME")
    app_env: str = Field(default="development", alias="APP_ENV")
    app_host: str = Field(default="0.0.0.0", alias="APP_HOST")
    app_port: int = Field(default=8000, alias="APP_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    ai_log_enabled: bool = Field(default=False, alias="AI_LOG_ENABLED")
    allowed_origins_raw: str = Field(default="http://localhost:5173", alias="ALLOWED_ORIGINS")

    mysql_host: str = Field(alias="MYSQL_HOST")
    mysql_port: int = Field(default=3306, alias="MYSQL_PORT")
    mysql_user: str = Field(alias="MYSQL_USER")
    mysql_password: str = Field(alias="MYSQL_PASSWORD")
    mysql_database: str = Field(default="stree", alias="MYSQL_DATABASE")

    llm_provider: str = Field(default="zhipu", alias="LLM_PROVIDER")
    llm_api_key: str = Field(default="", alias="LLM_API_KEY")
    llm_base_url: str = Field(default="https://open.bigmodel.cn/api/paas/v4", alias="LLM_BASE_URL")
    llm_model: str = Field(default="glm-4.7", alias="LLM_MODEL")
    amap_web_service_key: str = Field(default="", alias="AMAP_WEB_SERVICE_KEY")
    amap_transit_city: str = Field(default="北京", alias="AMAP_TRANSIT_CITY")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    @property
    def allowed_origins(self) -> list[str]:
        return [item.strip() for item in self.allowed_origins_raw.split(",") if item.strip()]

    @property
    def mysql_dsn(self) -> str:
        return (
            f"mysql+pymysql://{self.mysql_user}:{self.mysql_password}"
            f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_database}?charset=utf8mb4"
        )

    @property
    def ai_logging_enabled(self) -> bool:
        return self.ai_log_enabled or self.app_env.lower() == "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
