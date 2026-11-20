import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAIRING_CODE_PATTERN } from "@tekurobokun/protocol";
import {
  DeviceAuth,
  FileDeviceStore,
  hashToken,
  MemoryDeviceStore,
  randomCode,
} from "./device_auth.ts";

const pairing = { codeTtlMs: 60_000, maxFailures: 5, failureWindowMs: 60_000, lockMs: 300_000 };

/** 呼ぶたびに続きの値を返す乱数（同じ値が続かない） */
function counterBytes() {
  let n = 0;
  return (size: number) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = (n++ * 7) % 248;
    return out;
  };
}

function setup(over: { consoles?: string[] } = {}) {
  let t = Date.parse("2026-11-20T01:00:00Z");
  const store = new MemoryDeviceStore();
  const auth = new DeviceAuth({
    store,
    pairing,
    consoles: over.consoles ?? ["tablet", "phone"],
    now: () => t,
    randomBytes: counterBytes(),
  });
  return {
    auth,
    store,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("randomCode", () => {
  test("XXXX-XXXXの形で、使わない文字を含まない", () => {
    const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    for (let i = 0; i < 200; i++) expect(randomCode(bytes)).toMatch(PAIRING_CODE_PATTERN);
  });

  test("偏りを避けるため、248以上の値は捨てる", () => {
    let call = 0;
    // 1回目はすべて捨てる値、2回目は0（A）だけ
    const bytes = (n: number) => new Uint8Array(n).fill(call++ === 0 ? 250 : 0);
    expect(randomCode(bytes)).toBe("AAAA-AAAA");
  });
});

describe("DeviceAuth", () => {
  test("コードで登録し、トークンで確かめられる。保存するのはハッシュだけ", async () => {
    const { auth, store } = setup();
    const { code, expiresAt } = auth.issueCode();
    expect(code).toMatch(PAIRING_CODE_PATTERN);
    expect(expiresAt.toISOString()).toBe("2026-11-20T01:01:00.000Z");

    const result = await auth.pair({ role: "console", device: "phone", code, origin: "a" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.device).toMatchObject({ role: "console", name: "phone", revokedAt: null });
    expect(result.device.registeredAt).toBe("2026-11-20T10:00:00.000+09:00");

    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.tokenHash).toBe(hashToken(result.token));
    expect(JSON.stringify(store.records)).not.toContain(result.token);

    expect(auth.verify(result.token)).toMatchObject({ ok: true, device: { name: "phone" } });
    expect(auth.devices()).toEqual([
      {
        id: result.device.id,
        role: "console",
        name: "phone",
        registeredAt: result.device.registeredAt,
        connected: false,
      },
    ]);
  });

  test("機体は名前なしで登録し、名前はrobotになる", async () => {
    const { auth } = setup();
    const { code } = auth.issueCode();
    const result = await auth.pair({ role: "robot", code: code.toLowerCase(), origin: "a" });
    expect(result).toMatchObject({ ok: true, device: { role: "robot", name: "robot" } });
  });

  test("コードは60秒で失効する", async () => {
    const { auth, advance } = setup();
    const { code } = auth.issueCode();
    advance(59_999);
    expect(auth.currentCode()?.code).toBe(code);
    advance(1);
    expect(auth.currentCode()).toBeNull();
    expect(await auth.pair({ role: "robot", code, origin: "a" })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("コードは1回限り。2回目はinvalid", async () => {
    const { auth } = setup();
    const { code } = auth.issueCode();
    expect((await auth.pair({ role: "robot", code, origin: "a" })).ok).toBe(true);
    expect(await auth.pair({ role: "robot", code, origin: "b" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("新しいコードを発行すると、古いコードは失効する", async () => {
    const { auth } = setup();
    const first = auth.issueCode().code;
    const second = auth.issueCode().code;
    expect(second).not.toBe(first);
    expect(await auth.pair({ role: "robot", code: first, origin: "a" })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect((await auth.pair({ role: "robot", code: second, origin: "a" })).ok).toBe(true);
  });

  test("間違ったコード・形の崩れたコード・発行前はinvalid", async () => {
    const { auth } = setup();
    expect(await auth.pair({ role: "robot", code: "ABCD-EFGH", origin: "a" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    auth.issueCode();
    expect(await auth.pair({ role: "robot", code: "nope", origin: "a" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("設定にないconsoleの名前はunknown_deviceで、コードを使わない", async () => {
    const { auth } = setup();
    const { code } = auth.issueCode();
    expect(await auth.pair({ role: "console", device: "laptop", code, origin: "a" })).toEqual({
      ok: false,
      reason: "unknown_device",
    });
    expect(await auth.pair({ role: "console", code, origin: "a" })).toEqual({
      ok: false,
      reason: "unknown_device",
    });
    expect(auth.currentCode()?.code).toBe(code);
  });

  test("1分に5回失敗したら、その接続元は5分間受け付けない（正しいコードでも）", async () => {
    const { auth, advance } = setup();
    const { code } = auth.issueCode();
    for (let i = 0; i < 4; i++) {
      expect((await auth.pair({ role: "robot", code: "AAAA-AAAA", origin: "x" })).ok).toBe(false);
    }
    expect(auth.isLocked("x")).toBe(false);
    await auth.pair({ role: "robot", code: "AAAA-AAAA", origin: "x" });
    expect(auth.isLocked("x")).toBe(true);
    expect(await auth.pair({ role: "robot", code, origin: "x" })).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    // 別の接続元は受け付ける
    expect(auth.isLocked("y")).toBe(false);

    advance(299_999);
    expect(auth.isLocked("x")).toBe(true);
    advance(1);
    expect(auth.isLocked("x")).toBe(false);
    const fresh = auth.issueCode().code;
    expect((await auth.pair({ role: "robot", code: fresh, origin: "x" })).ok).toBe(true);
  });

  test("1分より前の失敗は数えない", async () => {
    const { auth, advance } = setup();
    auth.issueCode();
    for (let i = 0; i < 4; i++) await auth.pair({ role: "robot", code: "x", origin: "x" });
    advance(60_000);
    await auth.pair({ role: "robot", code: "x", origin: "x" });
    expect(auth.isLocked("x")).toBe(false);
  });

  test("無効にしたトークンはrevoked、知らないトークンはinvalid、ないものはmissing", async () => {
    const { auth, store } = setup();
    const { code } = auth.issueCode();
    const result = await auth.pair({ role: "robot", code, origin: "a" });
    if (!result.ok) throw new Error(result.reason);

    expect(await auth.revoke(result.device.id)).toBe(true);
    expect(await auth.revoke(result.device.id)).toBe(false);
    expect(await auth.revoke("unknown")).toBe(false);
    expect(auth.verify(result.token)).toEqual({ ok: false, reason: "revoked" });
    expect(auth.verify("something")).toEqual({ ok: false, reason: "invalid" });
    expect(auth.verify(null)).toEqual({ ok: false, reason: "missing" });
    expect(auth.verify("")).toEqual({ ok: false, reason: "missing" });

    // 無効化した行は残し、一覧には出さない
    expect(store.records[0]?.revokedAt).toBe("2026-11-20T10:00:00.000+09:00");
    expect(auth.devices()).toEqual([]);
  });

  test("保存した端末を読み込める", async () => {
    const first = setup();
    const { code } = first.auth.issueCode();
    const result = await first.auth.pair({ role: "robot", code, origin: "a" });
    if (!result.ok) throw new Error(result.reason);

    const auth = new DeviceAuth({ store: first.store, pairing, consoles: [] });
    await auth.load();
    expect(auth.verify(result.token).ok).toBe(true);
  });
});

describe("FileDeviceStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("ファイルがなければ空。書いたものを読み戻せる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tekurobo-devices-"));
    dirs.push(dir);
    const path = join(dir, "data", "devices.json");
    const store = new FileDeviceStore(path);
    expect(await store.load()).toEqual([]);

    const record = {
      id: "d1",
      role: "robot" as const,
      name: "robot",
      tokenHash: "ab",
      registeredAt: "2026-11-20T10:00:00.000+09:00",
      revokedAt: null,
    };
    await Promise.all([store.save([record]), store.save([record, { ...record, id: "d2" }])]);
    expect((await store.load()).map((r) => r.id)).toEqual(["d1", "d2"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(2);
  });

  test("崩れたファイルは読み込みで失敗する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tekurobo-devices-"));
    dirs.push(dir);
    const path = join(dir, "devices.json");
    await Bun.write(path, JSON.stringify([{ id: 1 }]));
    await expect(new FileDeviceStore(path).load()).rejects.toThrow("item 0");
  });
});
