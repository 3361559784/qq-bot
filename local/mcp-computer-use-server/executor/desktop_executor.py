import base64
import io
import os
import time
from typing import Any, Dict, List


class DesktopExecutor:
    def __init__(self) -> None:
        self.dry_run = str(os.getenv("ARIS_CU_EXECUTOR_DRY_RUN", "false")).lower() == "true"
        self.step_delay_sec = max(0.0, float(os.getenv("ARIS_CU_STEP_DELAY_SEC", "0.2")))
        self._pyautogui = None

    def _ensure_pyautogui(self):
        if self._pyautogui is not None:
            return self._pyautogui
        if self.dry_run:
            return None

        try:
            import pyautogui  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("pyautogui_unavailable") from exc

        self._pyautogui = pyautogui
        return self._pyautogui

    @staticmethod
    def supported_actions() -> List[str]:
        return [
            "click",
            "double_click",
            "right_click",
            "type",
            "hotkey",
            "scroll",
            "wait",
        ]

    def screenshot_base64(self) -> str:
        if self.dry_run:
            # 1x1 transparent PNG
            return (
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8"
                "/w8AAgMBgL3N6X8AAAAASUVORK5CYII="
            )

        pyautogui = self._ensure_pyautogui()
        image = pyautogui.screenshot()
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    def execute(self, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
        act = str(action or "").strip().lower()
        started = time.time()

        if self.dry_run:
            duration_ms = int((time.time() - started) * 1000)
            return {
                "ok": True,
                "duration_ms": duration_ms,
                "dry_run": True,
                "action": act,
                "input": params,
            }

        pyautogui = self._ensure_pyautogui()

        if act == "click":
            pyautogui.click(int(params.get("x", 0)), int(params.get("y", 0)))
        elif act == "double_click":
            pyautogui.doubleClick(int(params.get("x", 0)), int(params.get("y", 0)))
        elif act == "right_click":
            pyautogui.rightClick(int(params.get("x", 0)), int(params.get("y", 0)))
        elif act == "type":
            pyautogui.write(str(params.get("text", "")), interval=0.02)
        elif act == "hotkey":
            keys = params.get("keys", [])
            if not isinstance(keys, list) or not keys:
                raise ValueError("hotkey_requires_keys")
            pyautogui.hotkey(*[str(k) for k in keys])
        elif act == "scroll":
            dx = int(params.get("dx", 0))
            dy = int(params.get("dy", 0))
            if dx:
                pyautogui.hscroll(dx)
            if dy:
                pyautogui.scroll(dy)
        elif act == "wait":
            ms = max(50, int(params.get("ms", 500)))
            time.sleep(ms / 1000.0)
        else:
            raise ValueError(f"unsupported_action:{act}")

        duration_ms = int((time.time() - started) * 1000)
        if self.step_delay_sec > 0:
            time.sleep(self.step_delay_sec)

        return {
            "ok": True,
            "duration_ms": duration_ms,
            "dry_run": False,
            "action": act,
            "input": params,
        }
