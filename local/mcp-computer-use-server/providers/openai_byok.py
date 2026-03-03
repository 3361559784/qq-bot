import json
import os
from typing import Any, Dict, List, Optional


GITHUB_MODELS_BASE_URL = "https://models.github.ai/inference"
DEFAULT_PLANNER_MODELS = [
    "openai/gpt-5-nano",
    "openai/gpt-4.1-mini",
    "openai/gpt-4o-mini",
]


class ProviderError(Exception):
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def _parse_csv_list(value: str) -> List[str]:
    if not value:
        return []
    seen = set()
    out: List[str] = []
    for raw in value.split(","):
        item = raw.strip()
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _normalize_provider_mode(value: str) -> str:
    mode = str(value or "").strip().lower()
    if mode in {"github_models", "openai_compatible", "auto"}:
        return mode
    return "auto"


class OpenAIByokProvider:
    def __init__(self) -> None:
        self.github_models_token = str(os.getenv("GITHUB_MODELS_TOKEN", "")).strip()
        self.github_token = str(os.getenv("GITHUB_TOKEN", "")).strip()
        self.gh_token = str(os.getenv("GH_TOKEN", "")).strip()
        self.openai_api_key = str(os.getenv("OPENAI_API_KEY", "")).strip()
        self.provider_mode_configured = _normalize_provider_mode(str(os.getenv("ARIS_CU_PROVIDER_MODE", "auto")))
        self.explicit_base_url = str(os.getenv("ARIS_CU_OPENAI_BASE_URL", "")).strip()
        self.organization = str(os.getenv("OPENAI_ORGANIZATION", "")).strip()
        self.project = str(os.getenv("OPENAI_PROJECT", "")).strip()
        self.mock = str(os.getenv("ARIS_CU_PROVIDER_MOCK", "false")).lower() == "true"
        self.models = self._resolve_models()

    def _resolve_models(self) -> List[str]:
        csv = _parse_csv_list(str(os.getenv("ARIS_CU_PLANNER_MODELS", "")).strip())
        if csv:
            return csv

        single = str(os.getenv("ARIS_CU_PLANNER_MODEL", "")).strip()
        if single:
            return [single]
        return list(DEFAULT_PLANNER_MODELS)

    def _resolve_provider_mode(self) -> str:
        if self.provider_mode_configured != "auto":
            return self.provider_mode_configured
        if self._resolve_github_token():
            return "github_models"
        return "openai_compatible"

    def _resolve_github_token(self) -> str:
        return self.github_models_token or self.github_token or self.gh_token

    def _resolve_client_options(self) -> Dict[str, Any]:
        provider_mode = self._resolve_provider_mode()
        github_token = self._resolve_github_token()
        api_key = ""
        if provider_mode == "github_models":
            api_key = github_token
        else:
            api_key = self.openai_api_key or github_token

        if not api_key:
            raise ProviderError(
                "unauthorized",
                "missing credentials: set GITHUB_MODELS_TOKEN/GITHUB_TOKEN/GH_TOKEN or OPENAI_API_KEY",
                details={"provider_mode": provider_mode},
            )

        base_url = self.explicit_base_url
        if not base_url and provider_mode == "github_models":
            base_url = GITHUB_MODELS_BASE_URL

        options: Dict[str, Any] = {"api_key": api_key}
        if base_url:
            options["base_url"] = base_url
        if self.organization:
            options["organization"] = self.organization
        if self.project:
            options["project"] = self.project
        options["_provider_mode"] = provider_mode
        return options

    def _classify_error_code(self, err_text: str) -> str:
        lowered = str(err_text or "").lower()
        if (
            ("404" in lowered and "model" in lowered)
            or "model_not_found" in lowered
            or "does not exist" in lowered
            or "unknown model" in lowered
        ):
            return "model_not_found"
        if "401" in lowered or "403" in lowered or "unauthorized" in lowered or "invalid api key" in lowered:
            return "unauthorized"
        if "429" in lowered or "rate limit" in lowered or "quota" in lowered:
            return "rate_limited"
        if "timeout" in lowered or "timed out" in lowered:
            return "timeout"
        return "provider_failed"

    def _parse_plan_text(self, text: str) -> Dict[str, Any]:
        normalized = (
            str(text or "")
            .strip()
            .removeprefix("```json")
            .removeprefix("```")
            .removesuffix("```")
            .strip()
        )
        if not normalized:
            raise ProviderError("provider_failed", "empty planner response")
        try:
            parsed = json.loads(normalized)
        except json.JSONDecodeError as exc:
            raise ProviderError("provider_failed", f"invalid planner json: {exc}") from exc
        if not isinstance(parsed, dict):
            raise ProviderError("provider_failed", "planner response must be an object")
        return parsed

    def plan_next_step(
        self,
        objective: str,
        screenshot_b64: str,
        steps_executed: int,
        max_steps: int,
    ) -> Dict[str, Any]:
        provider_mode = self._resolve_provider_mode()
        if self.mock:
            return {
                "action": "finish",
                "input": {},
                "done": True,
                "summary": "mock_byok_finished",
                "provider_mode": provider_mode,
                "planner_model_selected": self.models[0] if self.models else "",
                "planner_model_attempts": 1,
                "model_error_chain": [],
            }

        try:
            from openai import OpenAI  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise ProviderError("provider_failed", "openai_sdk_unavailable") from exc

        options = self._resolve_client_options()
        provider_mode = str(options.pop("_provider_mode", provider_mode))
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

        model_error_chain: List[Dict[str, Any]] = []
        for attempt, model in enumerate(self.models, start=1):
            try:
                resp = client.responses.create(
                    model=model,
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
                parsed = self._parse_plan_text(str(getattr(resp, "output_text", "") or ""))
                return {
                    "action": str(parsed.get("action", "finish")).strip().lower() or "finish",
                    "input": parsed.get("input", {}) if isinstance(parsed.get("input", {}), dict) else {},
                    "done": bool(parsed.get("done", False)),
                    "summary": str(parsed.get("summary", "")),
                    "provider_mode": provider_mode,
                    "planner_model_selected": model,
                    "planner_model_attempts": attempt,
                    "model_error_chain": model_error_chain,
                }
            except ProviderError as exc:
                code = exc.code if exc.code in {
                    "model_not_found",
                    "unauthorized",
                    "rate_limited",
                    "timeout",
                    "provider_failed",
                } else "provider_failed"
                model_error_chain.append(
                    {
                        "provider": "openai_byok",
                        "model": model,
                        "code": code,
                        "message": exc.message,
                    }
                )
                if code == "unauthorized":
                    break
            except Exception as exc:
                message = str(exc)
                code = self._classify_error_code(message)
                model_error_chain.append(
                    {
                        "provider": "openai_byok",
                        "model": model,
                        "code": code,
                        "message": message,
                    }
                )
                if code == "unauthorized":
                    break

        final_code = "provider_failed"
        if model_error_chain:
            # Prefer surfacing non-provider_failed errors if available.
            for item in model_error_chain:
                if item.get("code") in {"model_not_found", "unauthorized", "rate_limited", "timeout"}:
                    final_code = str(item["code"])
                    break

        raise ProviderError(
            final_code,
            "all planner models failed",
            details={
                "provider_mode": provider_mode,
                "planner_models": self.models,
                "model_error_chain": model_error_chain,
            },
        )
