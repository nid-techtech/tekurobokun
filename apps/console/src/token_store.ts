// TokenStore：登録で受け取ったトークンをlocalStorageに保存する（imple 3節）。
// 端末名（?device=）ごとに分けて保存する（同じブラウザで別の端末名を開いて試すとき、取り違えないため）。
// localStorageが使えない（プライベートブラウズなど）ときは、ページを開いている間だけメモリに持つ。

/** localStorageのうち、使う部分（テストで差し替える）。 */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY_PREFIX = "tekurobokun.token.";

export class TokenStore {
  private memory: string | null = null;

  constructor(
    private readonly device: string,
    private readonly storage: StorageLike | null,
  ) {}

  private get key(): string {
    return `${KEY_PREFIX}${this.device}`;
  }

  get(): string | null {
    try {
      return this.storage?.getItem(this.key) ?? this.memory;
    } catch {
      return this.memory;
    }
  }

  set(token: string): void {
    this.memory = token;
    try {
      this.storage?.setItem(this.key, token);
    } catch {
      // 保存できなくても、開いている間はメモリの値で接続する。
    }
  }

  clear(): void {
    this.memory = null;
    try {
      this.storage?.removeItem(this.key);
    } catch {
      // 消せなくても、次のhelloでauth_requiredになるだけ。
    }
  }
}

/** ブラウザのlocalStorage。使えなければnull。 */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
