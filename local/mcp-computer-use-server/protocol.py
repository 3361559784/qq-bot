import json
import sys
from typing import Any, Dict, Optional


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Optional[Any] = None):
        super().__init__(message)
        self.code = int(code)
        self.message = str(message)
        self.data = data


def read_message(stdin) -> Optional[Dict[str, Any]]:
    headers = {}

    while True:
        line = stdin.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RpcError(-32700, "invalid_header_encoding", str(exc)) from exc

        if ":" not in text:
            raise RpcError(-32700, "invalid_header", text.strip())
        key, value = text.split(":", 1)
        headers[key.strip().lower()] = value.strip()

    content_length = headers.get("content-length")
    if not content_length:
        raise RpcError(-32700, "missing_content_length")

    try:
        length = int(content_length)
    except ValueError as exc:
        raise RpcError(-32700, "invalid_content_length", content_length) from exc

    if length <= 0:
        raise RpcError(-32700, "invalid_content_length", content_length)

    body = stdin.read(length)
    if len(body) != length:
        raise RpcError(-32700, "incomplete_body")

    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RpcError(-32700, "invalid_json", str(exc)) from exc


def write_message(stdout, payload: Dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    header = f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii")
    stdout.write(header)
    stdout.write(encoded)
    stdout.flush()


def stderr_log(message: str) -> None:
    sys.stderr.write(f"[mcp-cu] {message}\n")
    sys.stderr.flush()
