// DeviceAuth：登録コードの発行と検証、トークンの発行・保存・無効化、失敗の制限（imple 3節・7節）。
//
// - 登録コード：`XXXX-XXXX`の8文字。読み違えやすい文字を除いた31文字から乱数で作る。
//   有効はcodeTtlMs（既定60秒）・1回限り。同時に有効なコードは1つ（新しく発行すると古いものは失効）
// - トークン：32バイトの乱数（base64url）。保存するのはSHA-256だけ（data/devices.json）
// - 失敗の制限：接続元ごとに、failureWindowMsの間にmaxFailures回失敗したら、lockMsの間受け付けない
//
// 時計と乱数は差し替えられる（テスト）。ファイルの読み書きはDeviceStoreに分ける。

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Device,
  type DeviceRole,
  isDeviceRole,
  normalizePairingCode,
  PAIRING_ALPHABET,
  type PairFailedReason,
} from "@tekurobokun/protocol";
import type { PairingConfig } from "./config.ts";
import { toJstIso } from "./time.ts";

/** data/devices.json の1行。無効化した行も残す。 */
export type DeviceRecord = {
  id: string;
  role: DeviceRole;
  name: string;
  /** トークンのSHA-256（16進） */
  tokenHash: string;
  /** ISO 8601（+09:00） */
  registeredAt: string;
  revokedAt: string | null;
};

export interface DeviceStore {
  load(): Promise<DeviceRecord[]>;
  save(records: readonly DeviceRecord[]): Promise<void>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function toRecord(v: unknown): DeviceRecord | null {
  if (!isObj(v)) return null;
  const { id, role, name, tokenHash, registeredAt, revokedAt } = v;
  if (typeof id !== "string" || !isDeviceRole(role) || typeof name !== "string") return null;
  if (typeof tokenHash !== "string" || typeof registeredAt !== "string") return null;
  if (!(revokedAt === null || typeof revokedAt === "string")) return null;
  return { id, role, name, tokenHash, registeredAt, revokedAt };
}

/** JSONファイルに保存する。書くときは一時ファイルに書いてから置き換える。 */
export class FileDeviceStore implements DeviceStore {
  /** 書き込みを順に行うための列 */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<DeviceRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) throw new Error(`${this.path}: must be an array`);
    return raw.map((item, i) => {
      const record = toRecord(item);
      if (!record) throw new Error(`${this.path}: item ${i} is malformed`);
      return record;
    });
  }

  save(records: readonly DeviceRecord[]): Promise<void> {
    const text = `${JSON.stringify(records, null, 2)}\n`;
    const run = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, this.path);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}

/** メモリだけに持つ（テスト・開発用）。 */
export class MemoryDeviceStore implements DeviceStore {
  records: DeviceRecord[] = [];
  async load(): Promise<DeviceRecord[]> {
    return structuredClone(this.records);
  }
  async save(records: readonly DeviceRecord[]): Promise<void> {
    this.records = structuredClone([...records]);
  }
}

export type IssuedCode = { code: string; expiresAt: Date };

export type PairRequest = {
  role: DeviceRole;
  /** consoleの名前（robotなら使わない） */
  device?: string;
  code: string;
  /** 接続元（CF-Connecting-IP、なければ接続のアドレス） */
  origin: string;
};

export type PairResult =
  | { ok: true; token: string; device: DeviceRecord }
  | { ok: false; reason: PairFailedReason };

export type VerifyResult =
  | { ok: true; device: DeviceRecord }
  | { ok: false; reason: "missing" | "invalid" | "revoked" };

export type DeviceAuthOptions = {
  store: DeviceStore;
  pairing: PairingConfig;
  /** 登録できるconsoleの名前（設定のinputSources.consoles） */
  consoles: readonly string[];
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  log?: (line: string) => void;
};

/** 機体の端末名（一覧の表示用） */
export const ROBOT_DEVICE_NAME = "robot";
const TOKEN_BYTES = 32;
/** 失効した・使ったコードを覚えておく数（「古いコード」と「間違い」を見分けるため） */
const PAST_CODES = 16;

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** 偏りなく、alphabetからn文字を選ぶ（受け付けない値を捨てる）。 */
export function randomCode(randomBytes: (n: number) => Uint8Array): string {
  const size = PAIRING_ALPHABET.length;
  const limit = 256 - (256 % size);
  let chars = "";
  while (chars.length < 8) {
    for (const b of randomBytes(16)) {
      if (b >= limit) continue;
      chars += PAIRING_ALPHABET[b % size];
      if (chars.length === 8) break;
    }
  }
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

type Failures = { times: number[]; lockedUntil: number };

export class DeviceAuth {
  private records: DeviceRecord[] = [];
  private current: { code: string; expiresAt: number } | null = null;
  /** 失効したコードと使ったコード（古い順。PAST_CODES件まで） */
  private readonly past = new Map<string, "expired" | "used">();
  private readonly failures = new Map<string, Failures>();
  private readonly now: () => number;
  private readonly randomBytes: (n: number) => Uint8Array;
  private readonly log: (line: string) => void;

  constructor(private readonly options: DeviceAuthOptions) {
    this.now = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
    this.log = options.log ?? (() => {});
  }

  /** 保存済みの端末を読み込む（起動時）。 */
  async load(): Promise<void> {
    this.records = await this.options.store.load();
  }

  /** 登録コードを発行する。前のコードは失効する。 */
  issueCode(): IssuedCode {
    if (this.current) this.remember(this.current.code, "expired");
    let code = randomCode(this.randomBytes);
    // 覚えているコードと同じ値が出たら引き直す（同じコードが「古い」とも「有効」ともならないよう）
    while (this.past.has(code)) code = randomCode(this.randomBytes);
    const expiresAt = this.now() + this.options.pairing.codeTtlMs;
    this.current = { code, expiresAt };
    return { code, expiresAt: new Date(expiresAt) };
  }

  /** いま有効な登録コード。なければnull。 */
  currentCode(): IssuedCode | null {
    const cur = this.current;
    if (!cur || this.now() >= cur.expiresAt) return null;
    return { code: cur.code, expiresAt: new Date(cur.expiresAt) };
  }

  /** 接続元が、失敗の制限で受け付けない状態か。 */
  isLocked(origin: string): boolean {
    const f = this.failures.get(origin);
    return f !== undefined && this.now() < f.lockedUntil;
  }

  /** 登録コードをトークンと交換する。成功したら端末を保存する。 */
  async pair(req: PairRequest): Promise<PairResult> {
    if (this.isLocked(req.origin)) return { ok: false, reason: "rate_limited" };

    const name = req.role === "robot" ? ROBOT_DEVICE_NAME : (req.device ?? "");
    if (req.role === "console" && !this.options.consoles.includes(name)) {
      // コードを推測する手がかりにならないため、失敗には数えない。
      return { ok: false, reason: "unknown_device" };
    }

    const code = normalizePairingCode(req.code);
    const cur = this.current;
    if (code === null || cur === null || code !== cur.code) {
      // 失効したコードは「古い」と知らせる。使用済み・間違いは区別せずinvalid（imple 7節）。
      const reason = code !== null && this.past.get(code) === "expired" ? "expired" : "invalid";
      return this.fail(req.origin, reason);
    }
    if (this.now() >= cur.expiresAt) {
      this.remember(cur.code, "expired");
      this.current = null;
      return this.fail(req.origin, "expired");
    }

    // 1回限り：使ったらすぐ失効させる（保存の間に同じコードが届いても通さない）。
    this.remember(cur.code, "used");
    this.current = null;
    const token = base64url(this.randomBytes(TOKEN_BYTES));
    const device: DeviceRecord = {
      id: hex(this.randomBytes(8)),
      role: req.role,
      name,
      tokenHash: hashToken(token),
      registeredAt: toJstIso(new Date(this.now())),
      revokedAt: null,
    };
    this.records.push(device);
    this.failures.delete(req.origin);
    await this.options.store.save(this.records);
    this.log(`paired ${device.role} "${device.name}" (${device.id})`);
    return { ok: true, token, device: structuredClone(device) };
  }

  /** トークンを確かめる。 */
  verify(token: string | null): VerifyResult {
    if (token === null || token === "") return { ok: false, reason: "missing" };
    const hash = hashToken(token);
    const record = this.records.find((r) => r.tokenHash === hash);
    if (!record) return { ok: false, reason: "invalid" };
    if (record.revokedAt !== null) return { ok: false, reason: "revoked" };
    return { ok: true, device: structuredClone(record) };
  }

  /** 端末を無効にする。なければ・すでに無効ならfalse。 */
  async revoke(id: string): Promise<boolean> {
    const record = this.records.find((r) => r.id === id && r.revokedAt === null);
    if (!record) return false;
    record.revokedAt = toJstIso(new Date(this.now()));
    await this.options.store.save(this.records);
    this.log(`revoked ${record.role} "${record.name}" (${record.id})`);
    return true;
  }

  /** 有効な（無効化していない）端末。connectedは呼び出し側で決める。 */
  devices(isConnected: (id: string) => boolean = () => false): Device[] {
    return this.records
      .filter((r) => r.revokedAt === null)
      .map((r) => ({
        id: r.id,
        role: r.role,
        name: r.name,
        registeredAt: r.registeredAt,
        connected: isConnected(r.id),
      }));
  }

  private remember(code: string, kind: "expired" | "used"): void {
    this.past.delete(code);
    this.past.set(code, kind);
    for (const old of this.past.keys()) {
      if (this.past.size <= PAST_CODES) break;
      this.past.delete(old);
    }
  }

  private fail(origin: string, reason: PairFailedReason): PairResult {
    const { maxFailures, failureWindowMs, lockMs } = this.options.pairing;
    const now = this.now();
    const f = this.failures.get(origin) ?? { times: [], lockedUntil: 0 };
    f.times = [...f.times.filter((t) => now - t < failureWindowMs), now];
    if (maxFailures > 0 && f.times.length >= maxFailures) {
      f.lockedUntil = now + lockMs;
      f.times = [];
      this.log(`pairing locked for ${origin} (${lockMs} ms)`);
    }
    this.failures.set(origin, f);
    // 制限のかかっていない古い記録が溜まらないよう、ときどき掃除する。
    if (this.failures.size > 1000) this.sweep(now);
    return { ok: false, reason };
  }

  private sweep(now: number): void {
    const { failureWindowMs } = this.options.pairing;
    for (const [origin, f] of this.failures) {
      if (now >= f.lockedUntil && f.times.every((t) => now - t >= failureWindowMs)) {
        this.failures.delete(origin);
      }
    }
  }
}
