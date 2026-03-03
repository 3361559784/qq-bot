import base64
import io
import json
import os
import threading
import time
from typing import Any, Dict, Optional

import httpx
import pyautogui
from fastapi import FastAPI
from pydantic import BaseModel
from openai import OpenAI


BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://127.0.0.1:7071/api").rstrip("/")
AGENT_TOKEN = os.getenv("ARIS_CU_AGENT_TOKEN", "").strip()
AGENT_ID = os.getenv("ARIS_CU_AGENT_ID", "mac-agent-1").strip()
PLANNER_MODEL = os.getenv("ARIS_CU_PLANNER_MODEL", "gpt-4o-mini").strip()
POLL_INTERVAL_SEC = max(1, int(os.getenv("ARIS_CU_POLL_INTERVAL_SEC", "2")))
STEP_DELAY_SEC = max(0.1, float(os.getenv("ARIS_CU_STEP_DELAY_SEC", "0.3")))

app = FastAPI(title="schoolbot-computer-use-agent")

stop_event = threading.Event()
worker_started = False
worker_lock = threading.Lock()
openai_client: Optional[OpenAI] = OpenAI(api_key=os.getenv("OPENAI_API_KEY")) if os.getenv("OPENAI_API_KEY") else None


class ExecuteStepRequest(BaseModel):
    action: str
    input: Dict[str, Any] = {}


def auth_headers() -> Dict[str, str]:
    return {
        "Content-Type": "application/json",
        "x-aris-agent-token": AGENT_TOKEN
    }


def screenshot_base64() -> str:
    image = pyautogui.screenshot()
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def execute_step(action: str, params: Dict[str, Any]) -> Dict[str, Any]:
    act = str(action or "").strip().lower()
    started = time.time()

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
            raise ValueError("hotkey requires non-empty keys array")
        pyautogui.hotkey(*[str(k) for k in keys])
    elif act == "scroll":
        pyautogui.scroll(int(params.get("dy", 0)))
    elif act == "wait":
        time.sleep(max(0.1, float(params.get("ms", 500)) / 1000.0))
    else:
        raise ValueError(f"unsupported_action:{act}")

    duration_ms = int((time.time() - started) * 1000)
    time.sleep(STEP_DELAY_SEC)
    return {"ok": True, "duration_ms": duration_ms}


def plan_next_step(objective: str, screenshot_b64: str, steps_executed: int, max_steps: int) -> Dict[str, Any]:
    if not openai_client:
        return {
            "action": "finish",
            "input": {},
            "done": True,
            "summary": "OPENAI_API_KEY not configured on agent."
        }

    system_prompt = (
        "You are a desktop computer-use planner. "
        "Return strict JSON with fields: action, input, done, summary. "
        "Allowed actions: click, double_click, right_click, type, hotkey, scroll, wait, finish."
    )
    user_prompt = (
        f"Objective: {objective}\n"
        f"Steps executed: {steps_executed}/{max_steps}\n"
        "Decide next single action based only on screenshot.\n"
        "If objective appears done or unsafe to continue, return action=finish and done=true."
    )

    resp = openai_client.chat.completions.create(
        model=PLANNER_MODEL,
        temperature=0.2,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{screenshot_b64}"}}
                ]
            }
        ],
    )
    text = (resp.choices[0].message.content or "").strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    parsed = json.loads(text)
    return {
        "action": str(parsed.get("action", "finish")),
        "input": parsed.get("input", {}) if isinstance(parsed.get("input", {}), dict) else {},
        "done": bool(parsed.get("done", False)),
        "summary": str(parsed.get("summary", "")),
    }


def post_json(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(f"{BACKEND_BASE_URL}{path}", headers=auth_headers(), json=payload)
        resp.raise_for_status()
        return resp.json()


def process_job(job: Dict[str, Any]) -> None:
    job_id = job["id"]
    lease = job.get("lease") or {}
    lease_token = lease.get("lease_token", "")
    max_steps = int(job.get("max_steps", 30))
    step_max_retry = int(job.get("step_max_retry", 2))
    objective = str(job.get("objective", "")).strip()
    steps_executed = int(job.get("steps_executed", 0))

    for step_idx in range(steps_executed, max_steps):
        if stop_event.is_set():
            return

        shot = screenshot_base64()
        plan = plan_next_step(objective, shot, step_idx, max_steps)

        if plan.get("done") or plan.get("action") == "finish":
            post_json("/v2/computer-use/agent/report", {
                "job_id": job_id,
                "agent_id": AGENT_ID,
                "lease_token": lease_token,
                "report_type": "final",
                "result": {
                    "success": True,
                    "summary": plan.get("summary") or "Task finished by planner.",
                    "last_screenshot_ref": f"inline://{len(shot)}",
                    "output": {
                        "final_action": "finish"
                    }
                }
            })
            return

        action = str(plan.get("action", "wait"))
        params = plan.get("input", {}) if isinstance(plan.get("input"), dict) else {}

        last_error = ""
        success = False
        duration_ms = 0
        for retry in range(step_max_retry + 1):
            try:
                executed = execute_step(action, params)
                success = True
                duration_ms = int(executed.get("duration_ms", 0))
                post_json("/v2/computer-use/agent/report", {
                    "job_id": job_id,
                    "agent_id": AGENT_ID,
                    "lease_token": lease_token,
                    "report_type": "step",
                    "step": {
                        "index": step_idx,
                        "action": action,
                        "status": "success",
                        "duration_ms": duration_ms,
                        "retry_count": retry,
                        "screenshot_ref": f"inline://{len(shot)}",
                        "output": {"input": params}
                    }
                })
                break
            except Exception as exc:
                last_error = str(exc)
                if retry < step_max_retry:
                    continue
                post_json("/v2/computer-use/agent/report", {
                    "job_id": job_id,
                    "agent_id": AGENT_ID,
                    "lease_token": lease_token,
                    "report_type": "step",
                    "step": {
                        "index": step_idx,
                        "action": action,
                        "status": "failed",
                        "duration_ms": duration_ms,
                        "retry_count": retry,
                        "error": last_error,
                        "screenshot_ref": f"inline://{len(shot)}",
                        "output": {"input": params}
                    }
                })

        if not success:
            post_json("/v2/computer-use/agent/report", {
                "job_id": job_id,
                "agent_id": AGENT_ID,
                "lease_token": lease_token,
                "report_type": "final",
                "result": {
                    "success": False,
                    "summary": f"Task failed at step {step_idx}",
                    "error": last_error or "step_failed",
                    "last_screenshot_ref": f"inline://{len(shot)}"
                }
            })
            return

        heartbeat = post_json("/v2/computer-use/agent/heartbeat", {
            "job_id": job_id,
            "agent_id": AGENT_ID,
            "lease_token": lease_token
        })
        current = heartbeat.get("job") or {}
        if current.get("status") == "waiting_confirmation":
            return

    post_json("/v2/computer-use/agent/report", {
        "job_id": job_id,
        "agent_id": AGENT_ID,
        "lease_token": lease_token,
        "report_type": "final",
        "result": {
            "success": False,
            "summary": "Task stopped because max steps reached.",
            "error": "max_steps_reached"
        }
    })


def polling_worker() -> None:
    while not stop_event.is_set():
        try:
            result = post_json("/v2/computer-use/agent/poll", {"agent_id": AGENT_ID})
            job = result.get("job")
            if job:
                process_job(job)
            else:
                time.sleep(POLL_INTERVAL_SEC)
        except Exception:
            time.sleep(POLL_INTERVAL_SEC)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "agent_id": AGENT_ID,
        "backend": BACKEND_BASE_URL,
        "worker_started": worker_started
    }


@app.post("/poll-loop")
def poll_loop() -> Dict[str, Any]:
    global worker_started
    if worker_started:
        return {"ok": True, "started": False, "message": "already running"}

    with worker_lock:
        if worker_started:
            return {"ok": True, "started": False, "message": "already running"}
        stop_event.clear()
        thread = threading.Thread(target=polling_worker, daemon=True)
        thread.start()
        worker_started = True
        return {"ok": True, "started": True}


@app.post("/execute-step")
def execute_step_route(req: ExecuteStepRequest) -> Dict[str, Any]:
    out = execute_step(req.action, req.input)
    return {"ok": True, "result": out}


@app.post("/shutdown")
def shutdown() -> Dict[str, Any]:
    global worker_started
    stop_event.set()
    worker_started = False
    return {"ok": True, "stopped": True}
