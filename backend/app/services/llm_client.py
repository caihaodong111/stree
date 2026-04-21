import json
from typing import Any

import httpx

from app.core.config import settings


class LLMClientError(RuntimeError):
    """Raised when the configured LLM endpoint cannot return a usable response."""


class OpenAICompatibleLLMClient:
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

        response = self._post_chat_completions(
            {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
        )

        try:
            content = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMClientError("LLM response did not include message content.") from exc

        if isinstance(content, list):
            content = "".join(
                item.get("text", "")
                for item in content
                if isinstance(item, dict) and item.get("type") in {None, "text", "output_text"}
            )

        if not isinstance(content, str) or not content.strip():
            raise LLMClientError("LLM returned empty content.")

        return self._extract_json_object(content)

    def _post_chat_completions(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            with httpx.Client(timeout=25.0) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise LLMClientError(f"LLM request failed: {exc}") from exc

        try:
            return response.json()
        except json.JSONDecodeError as exc:
            raise LLMClientError("LLM response was not valid JSON.") from exc

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
