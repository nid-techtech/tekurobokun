// GoogleSpeechRecognizer：Google Cloud Speech-to-Text V2の`Recognize`（同期。1分未満の音声）で文字にする（imple 3節）。
// 認識器は作らず、暗黙の認識器`_`に設定を毎回付けて送る。言語はja-JP、モデルとリージョンは設定。
// 機体はWAV（16kHzモノラル、LINEAR16）を送るので、デコードの設定は自動（autoDecodingConfig）にする。
//
// データロギング（Googleが音声を改善に使う代わりに安くなる）は、リクエストの項目ではなく、
// プロジェクトの設定でオプトインするもの。設定の`stt.google.dataLogging`は、プロジェクトでの選択の記録として持つ。

import type { SttConfig } from "../config.ts";
import { type Recognition, type SpeechRecognizer, SttError } from "./engine.ts";
import type { GoogleAccessToken } from "./google_auth.ts";

export const STT_LANGUAGE = "ja-JP";
/** 応答があった・失敗した結果を、問い合わせ（probe）でこの時間は使い回す（APIを呼びすぎない） */
const PROBE_CACHE_MS = 60_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** リージョンごとのエンドポイント（`global`は`speech.googleapis.com`、それ以外は`{location}-speech.googleapis.com`）。 */
export function speechHost(location: string): string {
  return location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
}

/** 暗黙の認識器`_`でのRecognizeのURL。 */
export function recognizeUrl(projectId: string, location: string): string {
  return `https://${speechHost(location)}/v2/projects/${projectId}/locations/${location}/recognizers/_:recognize`;
}

/** Recognizeの本文。 */
export function recognizeBody(model: string, wav: Uint8Array): unknown {
  return {
    config: { autoDecodingConfig: {}, languageCodes: [STT_LANGUAGE], model },
    content: Buffer.from(wav).toString("base64"),
  };
}

/** Recognizeの応答から文字を取り出す。結果がない（声がない）ときは空。形が違えば例外。 */
export function transcriptOf(body: unknown): string {
  if (typeof body !== "object" || body === null) throw new SttError("unexpected response");
  const results = (body as { results?: unknown }).results;
  if (results === undefined) return "";
  if (!Array.isArray(results)) throw new SttError("unexpected response: results");
  return results
    .map((r: { alternatives?: { transcript?: unknown }[] }) => {
      const t = r?.alternatives?.[0]?.transcript;
      return typeof t === "string" ? t : "";
    })
    .join("")
    .trim();
}

export type GoogleSttOptions = {
  config: SttConfig;
  token: GoogleAccessToken;
  fetch?: Fetch;
  now?: () => number;
};

export class GoogleSpeechRecognizer implements SpeechRecognizer {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private lastProbe: { ok: boolean; atMs: number } | null = null;

  constructor(private readonly options: GoogleSttOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  async recognize(wav: Uint8Array): Promise<Recognition> {
    const { projectId, location, model } = this.options.config.google;
    const started = performance.now();
    const res = await this.call(recognizeUrl(projectId, location), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(recognizeBody(model, wav)),
    });
    const text = transcriptOf(await res.json());
    this.lastProbe = { ok: true, atMs: this.now() };
    return { text, ms: Math.round(performance.now() - started) };
  }

  /**
   * 応答の有無。リージョンの情報（Locations APIのget。課金されない）を取れるかで確かめる。
   * 直前の結果（認識の成功を含む）が新しければ、それを使う。
   */
  async probe(): Promise<boolean> {
    const now = this.now();
    if (this.lastProbe?.ok && now - this.lastProbe.atMs < PROBE_CACHE_MS) return true;
    const { projectId, location } = this.options.config.google;
    let ok: boolean;
    try {
      await this.call(
        `https://${speechHost(location)}/v2/projects/${projectId}/locations/${location}`,
        { method: "GET" },
      );
      ok = true;
    } catch {
      ok = false;
    }
    this.lastProbe = { ok, atMs: now };
    return ok;
  }

  /** トークンを付けて呼ぶ。401なら1回だけトークンを取り直す。失敗はSttError。 */
  private async call(url: string, init: RequestInit, retry = true): Promise<Response> {
    let res: Response;
    try {
      const token = await this.options.token.get();
      res = await this.fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.options.config.timeoutMs),
      });
    } catch (e) {
      this.lastProbe = { ok: false, atMs: this.now() };
      throw new SttError(`stt request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401 && retry) {
      this.options.token.invalidate();
      return this.call(url, init, false);
    }
    if (!res.ok) {
      this.lastProbe = { ok: false, atMs: this.now() };
      throw new SttError(`stt ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res;
  }
}

/** Googleの設定がそろっているか。足りない項目の名前を返す（そろっていれば空）。 */
export function missingGoogleSettings(config: SttConfig): string[] {
  const g = config.google;
  return (["projectId", "location", "model", "keyFile"] as const)
    .filter((k) => g[k] === "")
    .map((k) => `stt.google.${k}`);
}
