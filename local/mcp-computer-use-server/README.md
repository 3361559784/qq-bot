# SchoolBot Computer-Use MCP Server (stdio)

Python MCP stdio server for local desktop automation.

## Features

- Transport: stdio JSON-RPC (Content-Length framing)
- Tools: `screenshot`, `click`, `double_click`, `right_click`, `type`, `hotkey`, `scroll`, `wait`, `run_task`
- Provider chain in `run_task`:
  - primary: `openai_byok`
  - fallback: `chatgpt_plus_relay_poc` (dev/test only by default)

## Quick Start

```bash
cd local/mcp-computer-use-server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

## Important Env

- `OPENAI_API_KEY`
- `ARIS_CU_PLANNER_MODEL` (default `gpt-4o-mini`)
- `ARIS_CU_OPENAI_BASE_URL` (optional)
- `ARIS_CU_RELAY_ENABLE_DEV=true|false` (default `true`)
- `ARIS_CU_RELAY_FORCE_PROD=true|false` (default `false`)
- `ARIS_CU_RELAY_POC_CMD` (optional external relay command)
- `ARIS_CU_PROVIDER_MOCK=true|false` (test mode)
- `ARIS_CU_EXECUTOR_DRY_RUN=true|false` (no real click/type)

## Claude Desktop config example

Add to Claude Desktop MCP config (adjust paths):

```json
{
  "mcpServers": {
    "schoolbot-computer-use": {
      "command": "python3",
      "args": ["/ABS/PATH/local/mcp-computer-use-server/main.py"],
      "env": {
        "OPENAI_API_KEY": "<YOUR_KEY>",
        "ARIS_CU_PLANNER_MODEL": "gpt-4o-mini"
      }
    }
  }
}
```

## Notes

- `stdout` is reserved for JSON-RPC messages only.
- All logs go to `stderr`.
- For CI/local tests, use `ARIS_CU_PROVIDER_MOCK=true` and `ARIS_CU_EXECUTOR_DRY_RUN=true`.
