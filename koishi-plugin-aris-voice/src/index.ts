import { Context, Logger, Schema, Session, h } from 'koishi'
import sdk from 'microsoft-cognitiveservices-speech-sdk'
import * as edgeTTS from 'edge-tts'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const logger = new Logger('koishi-plugin-aris-voice')

type Engine = 'azure' | 'edge'

export interface Config {
  engine: Engine
  azureRegion?: string
  azureKey?: string
  voice: string
  format: string
  enableMiddleware: boolean
  autoTextMaxLength: number
  fallbackToEdge: boolean
  cleanupDelay: number
}

export const Config: Schema<Config> = Schema.object({
  engine: Schema.union(['azure', 'edge']).default('azure').description('首选的语音合成引擎。'),
  azureRegion: Schema.string().description('Azure TTS 区域，例如 eastasia。').required(false),
  azureKey: Schema.string().description('Azure TTS 密钥。').role('secret').required(false),
  voice: Schema.string().default('zh-CN-XiaoxiaoNeural').description('默认说话人，例如 zh-CN-XiaoxiaoNeural / ja-JP-NanamiNeural。'),
  format: Schema.string().default('audio-24khz-48kbitrate-mono-mp3').description('输出音频格式，Azure/Edge 均支持。'),
  enableMiddleware: Schema.boolean().default(false).description('启用自动 TTS 中间件：回复文本长度小于阈值时自动转语音。'),
  autoTextMaxLength: Schema.number().default(20).description('自动 TTS 生效的文本最大长度。'),
  fallbackToEdge: Schema.boolean().default(true).description('Azure 失败时是否自动降级到 Edge 免费引擎。'),
  cleanupDelay: Schema.number().default(30_000).description('音频文件清理延迟（毫秒）。'),
})

async function synthesizeAzure(text: string, config: Config, outPath: string) {
  if (!config.azureRegion || !config.azureKey) {
    throw new Error('Azure TTS 未配置 region 或 key')
  }
  const speechConfig = sdk.SpeechConfig.fromSubscription(config.azureKey, config.azureRegion)
  speechConfig.speechSynthesisVoiceName = config.voice
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3
  const audioConfig = sdk.AudioConfig.fromAudioFileOutput(outPath)

  await new Promise<void>((resolve, reject) => {
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig)
    synthesizer.speakTextAsync(
      text,
      result => {
        synthesizer.close()
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve()
        } else {
          reject(new Error(`Azure TTS 未完成，reason: ${result.reason}`))
        }
      },
      err => {
        synthesizer.close()
        reject(err)
      },
    )
  })
}

async function synthesizeEdge(text: string, config: Config, outPath: string) {
  const stream = edgeTTS.tts({
    text,
    voice: config.voice,
    format: config.format,
  })
  const chunks: Buffer[] = []
  for await (const data of stream) {
    if (data.type === 'audio') {
      chunks.push(data.data)
    }
  }
  if (!chunks.length) {
    throw new Error('Edge TTS 未返回音频数据')
  }
  await fsp.writeFile(outPath, Buffer.concat(chunks))
}

async function synthesize(text: string, config: Config): Promise<{ dir: string; file: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aris-voice-'))
  const ext = config.format.includes('wav') ? 'wav' : 'mp3'
  const file = path.join(dir, `${crypto.randomUUID()}.${ext}`)

  try {
    if (config.engine === 'azure') {
      await synthesizeAzure(text, config, file)
    } else {
      await synthesizeEdge(text, config, file)
    }
    return { dir, file }
  } catch (err) {
    if (config.engine === 'azure' && config.fallbackToEdge) {
      logger.warn('Azure TTS 失败，降级到 Edge：%s', (err as Error).message)
      await synthesizeEdge(text, { ...config, engine: 'edge' }, file)
      return { dir, file }
    }
    await safeCleanup(dir)
    throw err
  }
}

async function sendAudio(session: Session, file: string) {
  await session.send(
    h.audio({
      file: fs.createReadStream(file),
      name: path.basename(file),
    }),
  )
}

async function safeCleanup(dir: string) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(err => logger.debug('cleanup failed: %s', err))
}

function toText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (Array.isArray(payload)) return h.toText(payload as any)
  return ''
}

export function apply(ctx: Context, config: Config) {
  ctx.command('say <text:string>', '发送语音合成消息')
    .option('engine', '-e [engine:string] 指定引擎 (azure|edge)')
    .action(async ({ session, options }, text) => {
      if (!text || !text.trim()) return '要合成的文本不能为空。'
      const selected: Engine = (options.engine as Engine) || config.engine
      const runtimeConfig = { ...config, engine: selected }
      let assets: { dir: string; file: string } | undefined
      try {
        assets = await synthesize(text.trim(), runtimeConfig)
        await sendAudio(session, assets.file)
        return `语音合成完成（${selected}）`
      } catch (err) {
        logger.error('TTS 失败：%s', (err as Error).message)
        return `语音合成失败：${(err as Error).message}`
      } finally {
        if (assets) {
          setTimeout(() => {
            safeCleanup(assets!.dir)
          }, config.cleanupDelay)
        }
      }
    })

  if (config.enableMiddleware) {
    ctx.middleware(async (session, next) => {
      const result = await next()
      const text = toText(result)
      if (!text) return result
      const normalized = text.trim()
      if (!normalized || normalized.length > config.autoTextMaxLength) return result
      let assets: { dir: string; file: string } | undefined
      try {
        assets = await synthesize(normalized, config)
        await sendAudio(session, assets.file)
      } catch (err) {
        logger.warn('自动 TTS 失败：%s', (err as Error).message)
      } finally {
        if (assets) {
          setTimeout(() => {
            safeCleanup(assets!.dir)
          }, config.cleanupDelay)
        }
      }
      return result
    })
  }
}
