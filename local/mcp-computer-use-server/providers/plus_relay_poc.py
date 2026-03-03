import json
import os
import subprocess
from typing import Any, Dict

from .openai_byok import ProviderError


class ChatGPTPlusRelayPoCProvider:
    def __init__(self) -> None:
        self.env = str(os.getenv("NODE_ENV", "development")).strip().lower()
        self.enabled = str(os.getenv("ARIS_CU_RELAY_ENABLE_DEV", "true")).lower() == "true"
        self.force_prod = str(os.getenv("ARIS_CU_RELAY_FORCE_PROD", "false")).lower() == "true"
        self.max_retry = max(0, int(os.getenv("ARIS_CU_RELAY_MAX_RETRY", "2")))
        self.timeout_ms = max(1000, int(os.getenv("ARIS_CU_RELAY_TIMEOUT_MS", "45000")))
        self.mock_success = str(os.getenv("ARIS_CU_RELAY_POC_MOCK_SUCCESS", "false")).lower() == "true"
        self.command = str(os.getenv("ARIS_CU_RELAY_POC_CMD", "")).strip()

    def is_available(self) -> bool:
        if self.env == "production" and not self.force_prod:
            return False
        return self.enabled

    def plan_next_step(
        self,
        objective: str,
        screenshot_b64: str,
        steps_executed: int,
        max_steps: int,
    ) -> Dict[str, Any]:
        if not self.is_available():
            raise ProviderError("relay_disabled", "relay provider disabled")

        if self.mock_success:
            return {
                "action": "finish",
                "input": {},
                "done": True,
                "summary": "relay_poc_mock_finished",
                "experimental": True,
            }

        if not self.command:
            raise ProviderError("relay_not_configured", "ARIS_CU_RELAY_POC_CMD is not set")

        payload = {
            "objective": objective,
            "screenshot_base64": screenshot_b64,
            "steps_executed": steps_executed,
            "max_steps": max_steps,
        }

        try:
            completed = subprocess.run(
                self.command,
                input=json.dumps(payload),
                text=True,
                shell=True,
                capture_output=True,
                timeout=self.timeout_ms / 1000.0,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("relay_timeout", str(exc)) from exc

        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or "relay process failed"
            raise ProviderError("relay_process_failed", stderr)

        out = (completed.stdout or "").strip()
        if not out:
            raise ProviderError("relay_empty_response", "relay returned empty output")

        try:
            parsed = json.loads(out)
        except json.JSONDecodeError as exc:
            raise ProviderError("relay_invalid_json", str(exc)) from exc

        return {
            "action": str(parsed.get("action", "finish")).strip().lower() or "finish",
            "input": parsed.get("input", {}) if isinstance(parsed.get("input", {}), dict) else {},
            "done": bool(parsed.get("done", False)),
            "summary": str(parsed.get("summary", "")),
            "experimental": True,
        }
