from typing import Any, Callable, Dict, List, Tuple

from executor.desktop_executor import DesktopExecutor
from providers.openai_byok import OpenAIByokProvider, ProviderError
from providers.plus_relay_poc import ChatGPTPlusRelayPoCProvider


ToolHandler = Callable[[Dict[str, Any]], Dict[str, Any]]


def _safe_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


class ToolRuntime:
    def __init__(self) -> None:
        self.executor = DesktopExecutor()
        self.byok = OpenAIByokProvider()
        self.relay = ChatGPTPlusRelayPoCProvider()

    def _plan_with_provider_chain(
        self,
        objective: str,
        screenshot_b64: str,
        steps_executed: int,
        max_steps: int,
        allow_relay: bool,
    ) -> Dict[str, Any]:
        errors: List[Dict[str, Any]] = []
        attempts = 0

        try:
            attempts += 1
            result = self.byok.plan_next_step(objective, screenshot_b64, steps_executed, max_steps)
            return {
                "provider": "openai_byok",
                "plan": result,
                "attempts": attempts,
                "provider_error_chain": errors,
                "provider_fallback_used": False,
                "provider_mode": str(result.get("provider_mode", "unknown")),
                "planner_model_selected": str(result.get("planner_model_selected", "")),
                "planner_model_attempts": _safe_int(result.get("planner_model_attempts", attempts), attempts),
            }
        except ProviderError as exc:
            errors.append({
                "provider": "openai_byok",
                "code": exc.code,
                "message": exc.message,
            })
            for item in exc.details.get("model_error_chain", []):
                if isinstance(item, dict):
                    errors.append({
                        "provider": str(item.get("provider", "openai_byok")),
                        "model": str(item.get("model", "")),
                        "code": str(item.get("code", "provider_failed")),
                        "message": str(item.get("message", "")),
                    })

        if not allow_relay:
            raise ProviderError(
                "provider_failed",
                "BYOK failed and relay is disabled",
                details={"provider_error_chain": errors},
            )

        try:
            attempts += 1
            relay_result = self.relay.plan_next_step(objective, screenshot_b64, steps_executed, max_steps)
            return {
                "provider": "chatgpt_plus_relay_poc",
                "plan": relay_result,
                "attempts": attempts,
                "provider_error_chain": errors,
                "provider_fallback_used": True,
                "provider_mode": "relay_poc",
                "planner_model_selected": str(relay_result.get("planner_model_selected", "")),
                "planner_model_attempts": _safe_int(relay_result.get("planner_model_attempts", 0), 0),
            }
        except ProviderError as exc:
            errors.append({
                "provider": "chatgpt_plus_relay_poc",
                "code": exc.code,
                "message": exc.message,
            })
            raise ProviderError(
                "provider_failed",
                "provider chain failed",
                details={"provider_error_chain": errors},
            )

    def run_task(self, args: Dict[str, Any]) -> Dict[str, Any]:
        objective = str(args.get("objective", "")).strip()
        if not objective:
            return {
                "success": False,
                "status": "failed",
                "error": "missing_objective",
                "summary": "missing objective",
                "steps_executed": 0,
                "last_screenshot_ref": "",
                "provider": "unknown",
                "provider_mode": "unknown",
                "provider_attempts": 0,
                "provider_fallback_used": False,
                "provider_error_chain": [],
                "planner_model_selected": "",
                "planner_model_attempts": 0,
            }

        max_steps = max(1, min(200, int(args.get("max_steps", 30))))
        step_max_retry = max(0, min(10, int(args.get("step_max_retry", 2))))
        confirm_mode = str(args.get("confirm_mode", "periodic")).strip().lower()
        if confirm_mode not in {"periodic", "always", "never"}:
            confirm_mode = "periodic"
        confirm_every_steps = max(1, min(50, int(args.get("confirm_every_steps", 5))))
        allow_relay = bool(args.get("allow_relay", False))

        steps: List[Dict[str, Any]] = []
        steps_executed = 0
        provider = "unknown"
        provider_mode = "unknown"
        provider_attempts = 0
        provider_fallback_used = False
        provider_error_chain: List[Dict[str, Any]] = []
        planner_model_selected = ""
        planner_model_attempts = 0
        last_screenshot_ref = ""

        for step_index in range(max_steps):
            screenshot_b64 = self.executor.screenshot_base64()
            last_screenshot_ref = f"inline://{len(screenshot_b64)}"

            try:
                planned = self._plan_with_provider_chain(
                    objective,
                    screenshot_b64,
                    steps_executed,
                    max_steps,
                    allow_relay,
                )
            except ProviderError as exc:
                chain = provider_error_chain
                extra = exc.details.get("provider_error_chain", [])
                if isinstance(extra, list) and extra:
                    chain = [*chain, *extra]
                return {
                    "success": False,
                    "status": "failed",
                    "error": exc.code,
                    "summary": exc.message,
                    "steps_executed": steps_executed,
                    "last_screenshot_ref": last_screenshot_ref,
                    "provider": provider,
                    "provider_mode": provider_mode,
                    "provider_attempts": provider_attempts,
                    "provider_fallback_used": provider_fallback_used,
                    "provider_error_chain": chain,
                    "planner_model_selected": planner_model_selected,
                    "planner_model_attempts": planner_model_attempts,
                    "steps": steps,
                }

            provider = planned["provider"]
            provider_mode = str(planned.get("provider_mode", provider_mode))
            provider_attempts += _safe_int(planned["attempts"], 0)
            provider_fallback_used = provider_fallback_used or bool(planned.get("provider_fallback_used"))
            provider_error_chain.extend(planned.get("provider_error_chain", []))
            planner_model_selected = str(planned.get("planner_model_selected", planner_model_selected))
            planner_model_attempts = _safe_int(planned.get("planner_model_attempts", planner_model_attempts), planner_model_attempts)

            plan = planned["plan"]
            action = str(plan.get("action", "finish")).strip().lower() or "finish"
            action_input = plan.get("input", {}) if isinstance(plan.get("input"), dict) else {}
            done = bool(plan.get("done", False)) or action == "finish"
            summary = str(plan.get("summary", "")).strip()

            if done:
                return {
                    "success": True,
                    "status": "completed",
                    "summary": summary or "task completed",
                    "steps_executed": steps_executed,
                    "last_screenshot_ref": last_screenshot_ref,
                    "provider": provider,
                    "provider_mode": provider_mode,
                    "provider_attempts": provider_attempts,
                    "provider_fallback_used": provider_fallback_used,
                    "provider_error_chain": provider_error_chain,
                    "planner_model_selected": planner_model_selected,
                    "planner_model_attempts": planner_model_attempts,
                    "steps": steps,
                    "experimental": provider == "chatgpt_plus_relay_poc",
                }

            step_ok = False
            last_error = ""
            for retry in range(step_max_retry + 1):
                try:
                    out = self.executor.execute(action, action_input)
                    step_ok = True
                    steps_executed += 1
                    steps.append({
                        "index": step_index,
                        "action": action,
                        "status": "success",
                        "duration_ms": int(out.get("duration_ms", 0)),
                        "retry_count": retry,
                        "screenshot_ref": last_screenshot_ref,
                        "output": out,
                    })
                    break
                except Exception as exc:
                    last_error = str(exc)
                    if retry >= step_max_retry:
                        steps.append({
                            "index": step_index,
                            "action": action,
                            "status": "failed",
                            "duration_ms": 0,
                            "retry_count": retry,
                            "error": last_error,
                            "screenshot_ref": last_screenshot_ref,
                            "output": {"input": action_input},
                        })

            if not step_ok:
                return {
                    "success": False,
                    "status": "failed",
                    "error": "step_retry_exhausted",
                    "summary": last_error or "step execution failed",
                    "steps_executed": steps_executed,
                    "last_screenshot_ref": last_screenshot_ref,
                    "provider": provider,
                    "provider_mode": provider_mode,
                    "provider_attempts": provider_attempts,
                    "provider_fallback_used": provider_fallback_used,
                    "provider_error_chain": provider_error_chain,
                    "planner_model_selected": planner_model_selected,
                    "planner_model_attempts": planner_model_attempts,
                    "steps": steps,
                }

            should_confirm = confirm_mode == "always" or (
                confirm_mode == "periodic"
                and steps_executed > 0
                and steps_executed % confirm_every_steps == 0
                and steps_executed < max_steps
            )
            if should_confirm:
                return {
                    "success": True,
                    "status": "waiting_confirmation",
                    "summary": f"Executed {steps_executed} step(s), waiting confirmation.",
                    "steps_executed": steps_executed,
                    "confirm_round": max(1, int(steps_executed / confirm_every_steps)),
                    "last_screenshot_ref": last_screenshot_ref,
                    "provider": provider,
                    "provider_mode": provider_mode,
                    "provider_attempts": provider_attempts,
                    "provider_fallback_used": provider_fallback_used,
                    "provider_error_chain": provider_error_chain,
                    "planner_model_selected": planner_model_selected,
                    "planner_model_attempts": planner_model_attempts,
                    "steps": steps,
                    "experimental": provider == "chatgpt_plus_relay_poc",
                }

        return {
            "success": False,
            "status": "failed",
            "error": "max_steps_reached",
            "summary": "max steps reached",
            "steps_executed": steps_executed,
            "last_screenshot_ref": last_screenshot_ref,
            "provider": provider,
            "provider_mode": provider_mode,
            "provider_attempts": provider_attempts,
            "provider_fallback_used": provider_fallback_used,
            "provider_error_chain": provider_error_chain,
            "planner_model_selected": planner_model_selected,
            "planner_model_attempts": planner_model_attempts,
            "steps": steps,
        }


def build_tools(runtime: ToolRuntime) -> Tuple[List[Dict[str, Any]], Dict[str, ToolHandler]]:
    tools = [
        {
            "name": "screenshot",
            "description": "Capture a desktop screenshot.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
        {
            "name": "click",
            "description": "Click at screen coordinates.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                },
                "required": ["x", "y"],
                "additionalProperties": False,
            },
        },
        {
            "name": "double_click",
            "description": "Double click at screen coordinates.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                },
                "required": ["x", "y"],
                "additionalProperties": False,
            },
        },
        {
            "name": "right_click",
            "description": "Right click at screen coordinates.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                },
                "required": ["x", "y"],
                "additionalProperties": False,
            },
        },
        {
            "name": "type",
            "description": "Type text into focused input.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                },
                "required": ["text"],
                "additionalProperties": False,
            },
        },
        {
            "name": "hotkey",
            "description": "Press key combination.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "keys": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": ["keys"],
                "additionalProperties": False,
            },
        },
        {
            "name": "scroll",
            "description": "Scroll the screen.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dx": {"type": "integer"},
                    "dy": {"type": "integer"},
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "wait",
            "description": "Wait for given milliseconds.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ms": {"type": "integer"},
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "run_task",
            "description": "Run pure visual computer-use task with provider chain.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "objective": {"type": "string"},
                    "max_steps": {"type": "integer"},
                    "step_max_retry": {"type": "integer"},
                    "confirm_mode": {"type": "string", "enum": ["periodic", "always", "never"]},
                    "confirm_every_steps": {"type": "integer"},
                    "allow_relay": {"type": "boolean"},
                },
                "required": ["objective"],
                "additionalProperties": True,
            },
        },
    ]

    handlers: Dict[str, ToolHandler] = {
        "screenshot": lambda _args: {
            "screenshot_base64": runtime.executor.screenshot_base64(),
            "status": "ok",
        },
        "click": lambda args: runtime.executor.execute("click", args),
        "double_click": lambda args: runtime.executor.execute("double_click", args),
        "right_click": lambda args: runtime.executor.execute("right_click", args),
        "type": lambda args: runtime.executor.execute("type", args),
        "hotkey": lambda args: runtime.executor.execute("hotkey", args),
        "scroll": lambda args: runtime.executor.execute("scroll", args),
        "wait": lambda args: runtime.executor.execute("wait", args),
        "run_task": runtime.run_task,
    }

    return tools, handlers


def call_tool(handlers: Dict[str, ToolHandler], name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    handler = handlers.get(name)
    if handler is None:
        raise ValueError(f"unknown_tool:{name}")

    try:
        result = handler(args or {})
        return {
            "isError": False,
            "content": [{"type": "text", "text": "ok"}],
            "structuredContent": result,
        }
    except Exception as exc:
        return {
            "isError": True,
            "content": [{"type": "text", "text": str(exc)}],
            "structuredContent": {
                "error": str(exc),
                "trace": traceback.format_exc(limit=5),
            },
        }
