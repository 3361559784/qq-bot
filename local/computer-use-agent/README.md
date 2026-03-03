# Computer-Use Agent (macOS, FastAPI)

Local desktop automation agent for SchoolBot `computer.use`.

## Env

- `BACKEND_BASE_URL` (default: `http://127.0.0.1:7071/api`)
- `ARIS_CU_AGENT_TOKEN` (must match backend)
- `ARIS_CU_AGENT_ID` (default: `mac-agent-1`)
- `OPENAI_API_KEY`
- `ARIS_CU_PLANNER_MODEL` (default: `gpt-4o-mini`)
- `ARIS_CU_POLL_INTERVAL_SEC` (default: `2`)

## Run

```bash
cd local/computer-use-agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8787
```

## API

- `GET /health`
- `POST /poll-loop`
- `POST /execute-step`
- `POST /shutdown`

The service starts idle. Call `/poll-loop` once to start background polling.
