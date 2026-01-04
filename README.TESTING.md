> **Languages**: [English README](README.md) | [Chinese](README.zh.md) | [Japanese](README.jp.md) | [Russian](README.ru.md)

# Test ocrCourse API Locally

Prerequisites:
- Start Azure Functions host: `npm run start` (or `FUNCTIONS_WORKER_RUNTIME=node func start --verbose`)
- Optionally set `FUNC_KEY`, `SAMPLE_EXCEL_URL`, and `SAMPLE_IMAGE_URL` environment variables.

Run the script:
```bash
BASE_URL=http://localhost:7071/api/ocrCourse \
SAMPLE_EXCEL_URL=https://raw.githubusercontent.com/your/repo/main/samples/sampleSchedule.xlsx \
SAMPLE_IMAGE_URL=https://example.com/timetable.png \
node ./scripts/test_ocrCourse.js
```

This will run ICS/Excel/OCR tests against a running local host and print structured JSON responses.

If you want the script to verify Cosmos writes, ensure you have `COSMOS_DB_STRING` set in `local.settings.json` and the `CONTAINER` exists.
