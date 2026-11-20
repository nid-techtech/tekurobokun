import { describe, expect, test } from "bun:test";
import type { SttConfig } from "../config.ts";
import { encodeWav } from "../tts/engine.ts";
import { SttError } from "./engine.ts";
import {
  GoogleSpeechRecognizer,
  missingGoogleSettings,
  recognizeBody,
  recognizeUrl,
  speechHost,
  transcriptOf,
} from "./google.ts";
import {
  GoogleAccessToken,
  GoogleAuthError,
  parseServiceAccountKey,
  type ServiceAccountKey,
  signAssertion,
} from "./google_auth.ts";
import { STUB_MIN_SPEECH_MS, StubSpeechRecognizer, stubTranscript } from "./stub.ts";

const wavOf = (ms: number) => encodeWav(new Int16Array(Math.round(16 * ms)), 16000);

describe("StubSpeechRecognizer", () => {
  const utterances = ["a", "b", "c"];

  test("WAVの長さの1秒ごとに次の文を返す。短すぎれば空", () => {
    expect(stubTranscript(STUB_MIN_SPEECH_MS - 1, utterances)).toBe("");
    expect(stubTranscript(STUB_MIN_SPEECH_MS, utterances)).toBe("a");
    expect(stubTranscript(1500, utterances)).toBe("b");
    expect(stubTranscript(3200, utterances)).toBe("a");
    expect(stubTranscript(5000, [])).toBe("");
  });

  test("WAVを読んで文を返し、止めている間は失敗する", async () => {
    let up = true;
    const stt = new StubSpeechRecognizer({ utterances, delayMs: 0, isUp: () => up });
    expect((await stt.recognize(wavOf(2100))).text).toBe("c");
    expect((await stt.recognize(wavOf(100))).text).toBe("");
    expect(await stt.probe()).toBe(true);
    up = false;
    await expect(stt.recognize(wavOf(2100))).rejects.toBeInstanceOf(SttError);
    expect(await stt.probe()).toBe(false);
  });

  test("WAVでなければ失敗する", async () => {
    const stt = new StubSpeechRecognizer({ delayMs: 0 });
    await expect(stt.recognize(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(SttError);
  });

  test("既定の文の一覧がある", async () => {
    const stt = new StubSpeechRecognizer({ delayMs: 0 });
    expect((await stt.recognize(wavOf(1000))).text).not.toBe("");
  });
});

const sttConfig: SttConfig = {
  provider: "google",
  timeoutMs: 5000,
  google: {
    projectId: "proj",
    location: "asia-northeast1",
    model: "chirp_3",
    keyFile: "C:/keys/stt.json",
    dataLogging: false,
  },
};

describe("Google STTの要求と応答", () => {
  test("globalとリージョンでエンドポイントを分ける", () => {
    expect(speechHost("global")).toBe("speech.googleapis.com");
    expect(speechHost("us")).toBe("us-speech.googleapis.com");
    expect(recognizeUrl("proj", "asia-northeast1")).toBe(
      "https://asia-northeast1-speech.googleapis.com/v2/projects/proj/locations/asia-northeast1/recognizers/_:recognize",
    );
  });

  test("本文はja-JP、モデル、自動デコード、base64のWAV", () => {
    const body = recognizeBody("chirp_3", new Uint8Array([1, 2, 3])) as Record<string, unknown>;
    expect(body).toEqual({
      config: { autoDecodingConfig: {}, languageCodes: ["ja-JP"], model: "chirp_3" },
      content: "AQID",
    });
  });

  test("結果をつなげて文字にする。結果がなければ空、形が違えば失敗", () => {
    expect(
      transcriptOf({
        results: [
          { alternatives: [{ transcript: "abc", confidence: 0.9 }] },
          { alternatives: [{ transcript: "def" }] },
          { alternatives: [] },
        ],
      }),
    ).toBe("abcdef");
    expect(transcriptOf({ metadata: {} })).toBe("");
    expect(() => transcriptOf({ results: "x" })).toThrow(SttError);
    expect(() => transcriptOf(null)).toThrow(SttError);
  });

  test("足りない設定の項目を挙げる", () => {
    expect(missingGoogleSettings(sttConfig)).toEqual([]);
    expect(
      missingGoogleSettings({
        ...sttConfig,
        google: { ...sttConfig.google, model: "", keyFile: "" },
      }),
    ).toEqual(["stt.google.model", "stt.google.keyFile"]);
  });
});

/** 決まったトークンを返す偽のGoogleAccessToken。 */
function fakeToken() {
  let gets = 0;
  let invalidated = 0;
  const token = {
    get: async () => `t${++gets}`,
    invalidate: () => {
      invalidated++;
    },
  } as unknown as GoogleAccessToken;
  return { token, gets: () => gets, invalidated: () => invalidated };
}

describe("GoogleSpeechRecognizer", () => {
  test("トークンを付けてRecognizeを呼び、文字を返す", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const { token } = fakeToken();
    const stt = new GoogleSpeechRecognizer({
      config: sttConfig,
      token,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ results: [{ alternatives: [{ transcript: " hello " }] }] });
      },
    });
    const result = await stt.recognize(wavOf(1000));
    expect(result.text).toBe("hello");
    expect(calls[0]?.url).toBe(recognizeUrl("proj", "asia-northeast1"));
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer t1");
    // 認識できた直後の問い合わせは、APIを呼ばずに応答ありとする
    expect(await stt.probe()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("401なら1回だけトークンを取り直す。ほかの失敗はSttError", async () => {
    const statuses = [401, 200];
    const t = fakeToken();
    const stt = new GoogleSpeechRecognizer({
      config: sttConfig,
      token: t.token,
      fetch: async () => {
        const status = statuses.shift() ?? 500;
        return status === 200 ? Response.json({}) : new Response("no", { status });
      },
    });
    expect((await stt.recognize(wavOf(1000))).text).toBe("");
    expect(t.invalidated()).toBe(1);
    await expect(stt.recognize(wavOf(1000))).rejects.toBeInstanceOf(SttError);
  });

  test("通信の失敗はSttError。問い合わせはLocations APIのgetで確かめ、結果を1分使い回す", async () => {
    let now = 0;
    let reachable = false;
    const urls: string[] = [];
    const stt = new GoogleSpeechRecognizer({
      config: sttConfig,
      token: fakeToken().token,
      now: () => now,
      fetch: async (url) => {
        urls.push(url);
        if (!reachable) throw new Error("offline");
        return Response.json({ name: "projects/proj/locations/asia-northeast1" });
      },
    });
    await expect(stt.recognize(wavOf(1000))).rejects.toBeInstanceOf(SttError);
    expect(await stt.probe()).toBe(false);
    reachable = true;
    expect(await stt.probe()).toBe(true);
    expect(urls.at(-1)).toBe(
      "https://asia-northeast1-speech.googleapis.com/v2/projects/proj/locations/asia-northeast1",
    );
    const count = urls.length;
    now += 30_000;
    expect(await stt.probe()).toBe(true);
    expect(urls).toHaveLength(count);
    now += 31_000;
    expect(await stt.probe()).toBe(true);
    expect(urls).toHaveLength(count + 1);
  });
});

async function testKey(): Promise<{ key: ServiceAccountKey; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  return {
    key: {
      clientEmail: "stt@proj.iam.gserviceaccount.com",
      privateKey: pem,
      tokenUri: "https://oauth2.example/token",
    },
    publicKey: pair.publicKey,
  };
}

const decodePart = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("GoogleAccessToken", () => {
  test("鍵のJSONを読む。足りなければ失敗", () => {
    expect(
      parseServiceAccountKey({ client_email: "a@b", private_key: "k", token_uri: "https://t" }),
    ).toEqual({ clientEmail: "a@b", privateKey: "k", tokenUri: "https://t" });
    expect(parseServiceAccountKey({ client_email: "a@b", private_key: "k" }).tokenUri).toBe(
      "https://oauth2.googleapis.com/token",
    );
    expect(() => parseServiceAccountKey({ client_email: "a@b" })).toThrow(GoogleAuthError);
  });

  test("RS256で署名したJWTに、発行者・スコープ・宛先・期限を入れる", async () => {
    const { key, publicKey } = await testKey();
    const jwt = await signAssertion(key, "scope-x", 1_700_000_000_500);
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    expect(decodePart(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodePart(claims)).toEqual({
      iss: key.clientEmail,
      scope: "scope-x",
      aud: key.tokenUri,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(ok).toBe(true);
  });

  test("トークンと交換し、期限の少し前まで使い回す", async () => {
    const { key } = await testKey();
    let now = 1_700_000_000_000;
    const bodies: string[] = [];
    const auth = new GoogleAccessToken({
      loadKey: async () => key,
      now: () => now,
      fetch: async (url, init) => {
        expect(url).toBe(key.tokenUri);
        bodies.push(String(init?.body));
        return Response.json({ access_token: `tok${bodies.length}`, expires_in: 3600 });
      },
    });
    expect(await auth.get()).toBe("tok1");
    const params = new URLSearchParams(bodies[0]);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(params.get("assertion")?.split(".")).toHaveLength(3);
    now += 3_000_000;
    expect(await auth.get()).toBe("tok1");
    now += 560_000;
    expect(await auth.get()).toBe("tok2");
    auth.invalidate();
    expect(await auth.get()).toBe("tok3");
  });

  test("交換を断られたらGoogleAuthError", async () => {
    const { key } = await testKey();
    const auth = new GoogleAccessToken({
      loadKey: async () => key,
      fetch: async () => new Response("denied", { status: 400 }),
    });
    await expect(auth.get()).rejects.toBeInstanceOf(GoogleAuthError);
  });
});
