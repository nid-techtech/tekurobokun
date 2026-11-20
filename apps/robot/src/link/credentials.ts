// RobotCredentials：バックエンドの接続先とトークン（imple 3節）。
// 登録（QRの読み取り）で得たものはlocalStorageに保存する。
// 開発用に、config.local.jsonのbackend.url・backend.tokenがあれば、そちらを使う（カメラのない開発機で登録するため）。

/** localStorageのうち、使う部分（テストで差し替える）。 */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const URL_KEY = "tekurobokun.robot.backendUrl";
const TOKEN_KEY = "tekurobokun.robot.token";

export class RobotCredentials {
  /** 保存できないときのための、メモリの写し */
  private memory: { url: string | null; token: string | null } = { url: null, token: null };
  /** 開発用のトークンがバックエンドに断られた */
  private devTokenRejected = false;

  constructor(
    private readonly storage: StorageLike | null,
    private dev: { url: string | null; token: string | null } = { url: null, token: null },
  ) {
    this.memory = { url: this.read(URL_KEY), token: this.read(TOKEN_KEY) };
  }

  /** 開発用の設定で接続しているか（devのurlとtokenの両方があるとき） */
  get usingDevConfig(): boolean {
    return this.dev.url !== null && this.dev.token !== null;
  }

  /** WebSocketの接続先。なければnull（まだ登録していない） */
  url(): string | null {
    if (this.usingDevConfig) return this.dev.url;
    return this.memory.url ?? this.dev.url;
  }

  token(): string | null {
    if (this.usingDevConfig) return this.devTokenRejected ? null : this.dev.token;
    return this.memory.token;
  }

  /** 登録できた。接続先とトークンを保存する。 */
  save(url: string, token: string): void {
    // 開発用の設定で動いていても、QRで登録し直したら、そちらを使う。
    this.dev = { url: null, token: null };
    this.memory = { url, token };
    this.write(URL_KEY, url);
    this.write(TOKEN_KEY, token);
  }

  /** トークンが断られた（無効・無効化済み）。接続先は残す。 */
  clearToken(): void {
    if (this.usingDevConfig) {
      this.devTokenRejected = true;
      return;
    }
    this.memory.token = null;
    try {
      this.storage?.removeItem(TOKEN_KEY);
    } catch {
      // 消せなくても、次のhelloで断られるだけ。
    }
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // 保存できなくても、起動している間はメモリの値で接続する。
    }
  }
}

/** ブラウザ（WebView）のlocalStorage。使えなければnull。 */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
