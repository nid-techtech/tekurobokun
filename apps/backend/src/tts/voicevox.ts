// VoicevoxTtsEngine：VOICEVOX ENGINEの`/audio_query`→`/synthesis`で1文をWAVにする。
// API：POST /audio_query?text=&speaker= で音声合成用のクエリ（JSON）を得て、
//      POST /synthesis?speaker= にそのJSONを渡すとaudio/wavが返る（VOICEVOX ENGINEのREADME）。

import type { TtsConfig } from "../config.ts";
import { type Speech, splitSentences, type TtsEngine, TtsError, wavDurationMs } from "./engine.ts";

const DEFAULT_TIMEOUT_MS = 30000;

export class VoicevoxTtsEngine implements TtsEngine {
  constructor(
    private readonly config: TtsConfig,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  split(say: string): string[] {
    return splitSentences(say);
  }

  async synthesize(sentence: string): Promise<Speech> {
    const { baseUrl, speaker } = this.config;
    const queryUrl = `${baseUrl}/audio_query?${new URLSearchParams({ text: sentence, speaker: String(speaker) })}`;
    const query = await this.post(queryUrl);
    const queryJson = await query.text();

    const synthesisUrl = `${baseUrl}/synthesis?${new URLSearchParams({ speaker: String(speaker) })}`;
    const res = await this.post(synthesisUrl, queryJson);
    const wav = new Uint8Array(await res.arrayBuffer());
    const durationMs = wavDurationMs(wav);
    if (durationMs === null) throw new TtsError("synthesis did not return a WAV");
    return { wav, durationMs };
  }

  private async post(url: string, json?: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: json === undefined ? undefined : { "Content-Type": "application/json" },
        body: json,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new TtsError(`voicevox unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new TtsError(`voicevox ${new URL(url).pathname} returned ${res.status}`);
    return res;
  }
}
