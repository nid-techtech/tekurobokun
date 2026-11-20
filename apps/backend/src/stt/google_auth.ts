// Googleのサービスアカウントの鍵から、アクセストークンを得る（imple 3節）。
// 鍵（JSON）の秘密鍵でJWT（RS256）に署名し、token_uriでアクセストークンと交換する（OAuth 2.0のJWT bearer）。
// 依存を増やさないため、署名はWebCryptoで行う。トークンは期限の少し前まで使い回す。

export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** JWTの有効時間（Googleの上限は1時間） */
const ASSERTION_TTL_S = 3600;
/** 期限のこれだけ前に取り直す */
const REFRESH_MARGIN_MS = 60_000;

export type ServiceAccountKey = { clientEmail: string; privateKey: string; tokenUri: string };

/** 認証の失敗（鍵が読めない、交換を断られた、通信の失敗）。 */
export class GoogleAuthError extends Error {}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 鍵のJSONを読む。必要な項目がなければ例外。 */
export function parseServiceAccountKey(raw: unknown): ServiceAccountKey {
  const v = raw as Record<string, unknown> | null;
  if (
    typeof v !== "object" ||
    v === null ||
    typeof v.client_email !== "string" ||
    typeof v.private_key !== "string"
  ) {
    throw new GoogleAuthError("the key file must have client_email and private_key");
  }
  return {
    clientEmail: v.client_email,
    privateKey: v.private_key,
    tokenUri: typeof v.token_uri === "string" ? v.token_uri : DEFAULT_TOKEN_URI,
  };
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const encodeJson = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));

/** PEM（PKCS#8）の秘密鍵を、RS256の署名用に取り込む。 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(body, "base64"),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (e) {
    throw new GoogleAuthError(`cannot read private_key: ${e instanceof Error ? e.message : e}`);
  }
}

/** 署名したJWT（トークンと交換するためのassertion）。 */
export async function signAssertion(
  key: ServiceAccountKey,
  scope: string,
  nowMs: number,
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const claims = encodeJson({
    iss: key.clientEmail,
    scope,
    aud: key.tokenUri,
    iat,
    exp: iat + ASSERTION_TTL_S,
  });
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importPrivateKey(key.privateKey),
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

export type GoogleAuthOptions = {
  /** 鍵を読む（既定はファイルから） */
  loadKey: () => Promise<ServiceAccountKey>;
  scope?: string;
  timeoutMs?: number;
  fetch?: Fetch;
  now?: () => number;
};

/** サービスアカウントの鍵ファイルを読む。 */
export function keyFileLoader(path: string): () => Promise<ServiceAccountKey> {
  return async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new GoogleAuthError(`key file not found: ${path}`);
    try {
      return parseServiceAccountKey(await file.json());
    } catch (e) {
      if (e instanceof GoogleAuthError) throw e;
      throw new GoogleAuthError(`cannot read the key file: ${path}`);
    }
  };
}

export class GoogleAccessToken {
  private cached: { token: string; expiresAtMs: number } | null = null;
  private key: ServiceAccountKey | null = null;
  private readonly fetch: Fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleAuthOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  /** 使えるアクセストークン。期限が近ければ取り直す。 */
  async get(): Promise<string> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAtMs - REFRESH_MARGIN_MS) return this.cached.token;
    this.key ??= await this.options.loadKey();
    const assertion = await signAssertion(
      this.key,
      this.options.scope ?? CLOUD_PLATFORM_SCOPE,
      now,
    );
    let res: Response;
    try {
      res = await this.fetch(this.key.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: JWT_GRANT, assertion }).toString(),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new GoogleAuthError(`token request failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) {
      throw new GoogleAuthError(`token request: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") {
      throw new GoogleAuthError("token response has no access_token");
    }
    const ttlS = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.cached = { token: body.access_token, expiresAtMs: now + ttlS * 1000 };
    return body.access_token;
  }

  /** 次はかならず取り直す（401を受けたとき）。 */
  invalidate(): void {
    this.cached = null;
  }
}
