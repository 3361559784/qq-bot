import os
import sys
from typing import Any, Dict

from protocol import RpcError, read_message, stderr_log, write_message
from tools import ToolRuntime, build_tools, call_tool


SERVER_INFO = {
    "name": "schoolbot-computer-use-mcp",
    "version": "0.1.0",
}


def success_response(req_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": result,
    }


def error_response(req_id: Any, code: int, message: str, data: Any = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {
            "code": int(code),
            "message": str(message),
        },
    }
    if data is not None:
        payload["error"]["data"] = data
    return payload


def handle_request(req: Dict[str, Any], tools, handlers) -> Dict[str, Any]:
    if not isinstance(req, dict):
        raise RpcError(-32600, "invalid_request")

    req_id = req.get("id")
    method = str(req.get("method", "")).strip()
    params = req.get("params") if isinstance(req.get("params"), dict) else {}

    if method == "initialize":
        return success_response(req_id, {
            "protocolVersion": "2025-11-05",
            "serverInfo": SERVER_INFO,
            "capabilities": {
                "tools": {},
            },
        })

    if method == "tools/list":
        return success_response(req_id, {
            "tools": tools,
        })

    if method == "tools/call":
        name = str(params.get("name", "")).strip()
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        out = call_tool(handlers, name, args)
        return success_response(req_id, out)

    if method == "ping":
        return success_response(req_id, {"ok": True})

    raise RpcError(-32601, "method_not_found", method)


def main() -> int:
    runtime = ToolRuntime()
    tools, handlers = build_tools(runtime)

    stderr_log(
        f"started profile={os.getenv('ARIS_RUNTIME_PROFILE', 'host')} "
        f"relay_dev={os.getenv('ARIS_CU_RELAY_ENABLE_DEV', 'true')}"
    )

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    while True:
        try:
            req = read_message(stdin)
            if req is None:
                stderr_log("stdin closed, exiting")
                return 0

            req_id = req.get("id") if isinstance(req, dict) else None
            try:
                resp = handle_request(req, tools, handlers)
            except RpcError as exc:
                resp = error_response(req_id, exc.code, exc.message, exc.data)
            except Exception as exc:  # pragma: no cover
                resp = error_response(req_id, -32603, "internal_error", str(exc))

            write_message(stdout, resp)
        except RpcError as exc:
            write_message(stdout, error_response(None, exc.code, exc.message, exc.data))
        except Exception as exc:  # pragma: no cover
            stderr_log(f"fatal error: {exc}")
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
