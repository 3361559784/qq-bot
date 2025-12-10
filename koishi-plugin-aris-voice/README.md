# koishi-plugin-aris-voice

Dual-engine (Azure TTS + Edge TTS) speech plugin for Koishi v4.

## Install

```bash
cd koishi-plugin-aris-voice
npm install
npm run build
```

Add to Koishi config:

- `engine`: `azure` or `edge`.
- `azureRegion` / `azureKey`: required when using Azure.
- `voice`: default `zh-CN-XiaoxiaoNeural` (also supports `ja-JP-NanamiNeural`).
- `format`: default `audio-24khz-48kbitrate-mono-mp3`.
- `enableMiddleware`: auto TTS for short replies (<= `autoTextMaxLength`, default 20 chars).
- `fallbackToEdge`: Azure failover to Edge.
- `cleanupDelay`: temp file cleanup delay in ms.

## Commands

- `say <text>`: synthesize and send audio. Override engine per call with `-e azure|edge`.

## Notes

- Audio is streamed from a temp file and cleaned after `cleanupDelay`.
- Middleware sends audio in addition to the original text so users can still read if playback fails.
- Azure requires `microsoft-cognitiveservices-speech-sdk`; Edge path uses `edge-tts` and works without credentials.
