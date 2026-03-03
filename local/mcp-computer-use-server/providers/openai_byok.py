import json
import os
from typing import Any, Dict


class ProviderError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class OpenAIByokProvider:
    def __init__(self) -> None:
        self.api_key = str(os.getenv("OPENAI_API_KEY", "")).strip()
        self.model = str(os.getenv("ARIS_CU_PLANNER_MODEL", "gpt-4o-mini")).strip()
        self.base_url = str(os.getenv("ARIS_CU_OPENAI_BASE_URL", "")).strip()
        self.organization = str(os.getenv("OPENAI_ORGANIZATION", "")).strip()
        self.project = str(os.getenv("OPENAI_PROJECT", "")).strip()
        self.mock = str(os.getenv("ARIS_CU_PROVIDER_MOCK", "false")).lower() == "true"

    def plan_next_step(
        self,
        objective: str,
        screenshot_b64: str,
        steps_executed: int,
        max_steps: int,
    ) -> Dict[str, Any]:
        if self.mock:
            return {
                "action": "finish",
                "input": {},
                "done": True,
                "summary": "mock_byok_finished",
            }

        if not self.api_key:
            raise ProviderError("byok_missing_api_key", "OPENAI_API_KEY is not configured")

        try:
            from openai import OpenAI  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise ProviderError("byok_sdk_missing", "openai_sdk_unavailable") from exc

        options: Dict[str, Any] = {
            "api_key": self.api_key,
        }
        if self.base_url:
            options["base_url"] = self.base_url
        if self.organization:
            options["organization"] = self.organization
        if self.project:
            options["project"] = self.project

        client = OpenAI(**options)

        system_prompt = (
            "You are a desktop automation planner. "
            "Return strict JSON with fields: action,input,done,summary. "
            "Allowed actions: click,double_click,right_click,type,hotkey,scroll,wait,finish."
        )
        user_prompt = (
            f"Objective: {objective}\n"
            f"Steps executed: {steps_executed}/{max_steps}\n"
            "Based on the screenshot, return exactly one next action in JSON."
        )

        try:
            resp = client.responses.create(
                model=self.model,
                temperature=0.2,
                input=[
                    {
                        "role": "system",
                        "content": [{"type": "input_text", "text": system_prompt}],
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": user_prompt},
                            {
                                "type": "input_image",
                                "image_url": f"data:image/png;base64,{screenshot_b64}",
                            },
                        ],
                    },
                ],
            )
        except Exception as exc:
            text = str(exc)
            lowered = text.lower()
            if "401" in lowered or "invalid api key" in lowered or "unauthorized" in lowered:
                raise ProviderError("byok_auth_failed", text) from exc
            if "429" in lowered or "rate" in lowered:
                raise ProviderError("byok_rate_limited", text) from exc
            if "timeout" in lowered:
                raise ProviderError("byok_timeout", text) from exc
            raise ProviderError("byok_request_failed", text) from exc

        text = str(getattr(resp, "output_text", "") or "").strip()
        if not text:
            raise ProviderError("byok_empty_response", "empty planner response")

        normalized = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            parsed = json.loads(normalized)
        except json.JSONDecodeError as exc:
            raise ProviderError("byok_invalid_json", f"invalid json: {exc}") from exc

        return {
            "action": str(parsed.get("action", "finish")).strip().lower() or "finish",
            "input": parsed.get("input", {}) if isinstance(parsed.get("input", {}), dict) else {},
            "done": bool(parsed.get("done", False)),
            "summary": str(parsed.get("summary", "")),
        }
