import json
import logging
from typing import Any

import httpx

from app.core.config import settings


class LLMClientError(RuntimeError):
    """Raised when the configured LLM endpoint cannot return a usable response."""


logger = logging.getLogger("app.ai.llm")


class OpenAICompatibleLLMClient:
    REQUEST_TIMEOUT_SECONDS = 60.0

    def __init__(self) -> None:
        self.base_url = settings.llm_base_url.rstrip("/")
        self.api_key = settings.llm_api_key
        self.model = settings.llm_model
        self.provider = settings.llm_provider

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)

    def chat_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.1,
        max_tokens: int = 1200,
    ) -> dict[str, Any]:
        if not self.enabled:
            raise LLMClientError("LLM is not configured.")

        logger.info(
            "chat_json start provider=%s model=%s system_len=%s user_len=%s max_tokens=%s thinking_disabled=%s",
            self.provider,
            self.model,
            len(system_prompt),
            len(user_prompt),
            max_tokens,
            self._should_disable_thinking(),
        )
        payload = self._build_payload(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        response = self._post_chat_completions(payload)
        content = self._extract_content(response)
        reasoning_content = self._extract_reasoning_content(response)
        logger.info(
            "chat_json first_response model=%s content_len=%s reasoning_len=%s",
            self.model,
            len(content),
            len(reasoning_content),
        )

        if not content.strip() and reasoning_content.strip():
            try:
                logger.info("chat_json parsed_json_from_reasoning model=%s", self.model)
                return self._extract_json_object(reasoning_content)
            except LLMClientError:
                logger.warning("chat_json reasoning_content_not_json model=%s", self.model)
                pass

        if not content.strip() and reasoning_content.strip():
            logger.warning("chat_json empty_content_retry model=%s", self.model)
            retry_payload = self._build_payload(
                system_prompt=f"{system_prompt} 不要输出推理过程，直接输出最终答案。",
                user_prompt=user_prompt,
                temperature=temperature,
                max_tokens=max(max_tokens * 2, 1600),
            )
            response = self._post_chat_completions(retry_payload)
            content = self._extract_content(response)
            reasoning_content = self._extract_reasoning_content(response)
            logger.info(
                "chat_json retry_response model=%s content_len=%s reasoning_len=%s",
                self.model,
                len(content),
                len(reasoning_content),
            )

            if not content.strip() and reasoning_content.strip():
                try:
                    logger.info("chat_json retry_parsed_json_from_reasoning model=%s", self.model)
                    return self._extract_json_object(reasoning_content)
                except LLMClientError:
                    logger.warning("chat_json retry_reasoning_content_not_json model=%s", self.model)
                    pass

        if not content.strip():
            logger.error("chat_json empty_content_after_retry model=%s", self.model)
            raise LLMClientError("LLM returned empty content.")

        logger.info("chat_json parse_content_json model=%s content_len=%s", self.model, len(content))
        return self._extract_json_object(content)

    def _build_payload(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        max_tokens: int,
    ) -> dict[str, Any]:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        if self._should_disable_thinking():
            payload["thinking"] = {"type": "disabled"}

        return payload

    def _post_chat_completions(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            with httpx.Client(timeout=self.REQUEST_TIMEOUT_SECONDS) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.exception("llm_http_error provider=%s model=%s", self.provider, self.model)
            raise LLMClientError(f"LLM request failed: {exc}") from exc

        logger.info("llm_http_ok provider=%s model=%s status=%s", self.provider, self.model, response.status_code)

        try:
            return response.json()
        except json.JSONDecodeError as exc:
            logger.exception("llm_invalid_json provider=%s model=%s", self.provider, self.model)
            raise LLMClientError("LLM response was not valid JSON.") from exc

    def _extract_content(self, response: dict[str, Any]) -> str:
        try:
            content = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMClientError("LLM response did not include message content.") from exc

        if isinstance(content, list):
            return "".join(
                item.get("text", "")
                for item in content
                if isinstance(item, dict) and item.get("type") in {None, "text", "output_text"}
            )

        if isinstance(content, str):
            return content

        return ""

    def _extract_reasoning_content(self, response: dict[str, Any]) -> str:
        try:
            reasoning = response["choices"][0]["message"].get("reasoning_content", "")
        except (KeyError, IndexError, AttributeError, TypeError):
            return ""
        return reasoning if isinstance(reasoning, str) else ""

    def _should_disable_thinking(self) -> bool:
        if self.provider != "zhipu":
            return False

        model_name = (self.model or "").lower()
        return model_name.startswith("glm-4.7") or model_name.startswith("glm-5")

    def _extract_json_object(self, content: str) -> dict[str, Any]:
        raw = content.strip()

        for candidate in (raw, self._slice_first_json_object(raw)):
            if not candidate:
                continue
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed

        raise LLMClientError("LLM content did not contain a valid JSON object.")

    @staticmethod
    def _slice_first_json_object(content: str) -> str:
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return ""
        return content[start : end + 1]
