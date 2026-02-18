# Campus AI Web

Next.js frontend for Campus Copilot.

## Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4

## Local development

```bash
cd /Users/liuziheng/qq-bot-aris-clean/campus-ai-web
npm install
npm run dev
```

Set frontend backend target in `.env.local`:

```bash
NEXT_PUBLIC_AZURE_FUNCTION_URL=http://127.0.0.1:7071/api/schoolbot
```

## Build

```bash
cd /Users/liuziheng/qq-bot-aris-clean/campus-ai-web
npm run build
npm run start
```

## Notes

- Chat API proxy: `/Users/liuziheng/qq-bot-aris-clean/campus-ai-web/app/api/chat/route.ts`
- Streaming API proxy: `/Users/liuziheng/qq-bot-aris-clean/campus-ai-web/app/api/chat/stream/route.ts`
