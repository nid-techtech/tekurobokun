import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR, loadBackendConfig, mergeConfig, parseBackendConfig } from "./config.ts";

describe("mergeConfig", () => {
  test("オブジェクトは項目ごと、配列と値はまるごと上書きする", () => {
    expect(
      mergeConfig({ a: 1, b: { c: 2, d: 3 }, list: [1, 2] }, { b: { d: 4 }, list: [9], e: "x" }),
    ).toEqual({ a: 1, b: { c: 2, d: 4 }, list: [9], e: "x" });
  });
});

describe("loadBackendConfig", () => {
  test("リポジトリのdefaultが読める", async () => {
    const raw: unknown = await Bun.file(`${CONFIG_DIR}backend.default.json`).json();
    const config = parseBackendConfig(raw);
    expect(config.console.autosendMs).toBe(3000);
    expect(config.console.fontSizePx).toBe(18);
    expect(config.console.bottomInsetPx).toBe(0);
    expect(config.inputSources.active).toBe("robot");
    expect(config.inputSources.consoles).toEqual(["tablet", "phone"]);
    expect(config.host).toBe("127.0.0.1");
    expect(config.admin.port).toBe(8788);
    expect(config.pairing).toEqual({
      codeTtlMs: 60000,
      maxFailures: 5,
      failureWindowMs: 60000,
      lockMs: 300000,
    });
    // いまの別名のモデルの値で解決する
    expect(config.llm.activeAlias).toBe("main");
    expect(config.llm.model).toBe(config.llm.models.main.model);
  });

  test("local.jsonで項目ごとに上書きする", async () => {
    const dir = `${mkdtempSync(join(tmpdir(), "tekurobo-config-"))}/`;
    try {
      writeFileSync(
        `${dir}backend.default.json`,
        await Bun.file(`${CONFIG_DIR}backend.default.json`).text(),
      );
      writeFileSync(
        `${dir}backend.local.json`,
        JSON.stringify({ llm: { baseUrl: "http://192.168.0.10:8080/", activeAlias: "sub" } }),
      );
      const config = await loadBackendConfig(dir);
      expect(config.llm.baseUrl).toBe("http://192.168.0.10:8080");
      expect(config.llm.model).toBe("qwen3-4b");
      expect(config.llm.contextTurns).toBe(4);
      expect(config.llm.activeAlias).toBe("sub");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseBackendConfig", () => {
  const base = async () =>
    (await Bun.file(`${CONFIG_DIR}backend.default.json`).json()) as Record<string, unknown>;

  test("崩れた項目は、その項目を示して失敗する", async () => {
    const raw = await base();
    expect(() => parseBackendConfig({ ...raw, port: "8787" })).toThrow("port");
    expect(() =>
      parseBackendConfig({ ...raw, llm: { ...(raw.llm as object), baseUrl: "localhost" } }),
    ).toThrow("llm.baseUrl");
    expect(() =>
      parseBackendConfig({ ...raw, inputSources: { consoles: ["tablet"], active: "phone" } }),
    ).toThrow("inputSources.active");
    expect(() =>
      parseBackendConfig({ ...raw, inputSources: { consoles: ["robot"], active: "robot" } }),
    ).toThrow("inputSources.consoles");
    expect(() => parseBackendConfig({ ...raw, admin: { port: 8787 } })).toThrow("admin.port");
    expect(() =>
      parseBackendConfig({ ...raw, llm: { ...(raw.llm as object), activeAlias: "third" } }),
    ).toThrow("llm.activeAlias");
    expect(() => parseBackendConfig({ ...raw, host: "" })).toThrow("host");
    expect(() =>
      parseBackendConfig({ ...raw, stt: { ...(raw.stt as object), provider: "whisper" } }),
    ).toThrow("stt.provider");
  });
});
