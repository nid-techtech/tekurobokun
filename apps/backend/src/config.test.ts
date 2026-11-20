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
    expect(config.stt.provider).toBe("whisper");
    expect(config.stt.whisper.url).toBe("http://127.0.0.1:8081");
    expect(config.stt.whisper.language).toBe("ja");
    expect(config.stt.whisper.hallucinations.length).toBeGreaterThan(0);
    expect(config.stt.bench.models.map((m) => m.name)).toContain("large-v3-turbo-q5_0");
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
    const stt = raw.stt as Record<string, unknown>;
    const whisper = stt.whisper as Record<string, unknown>;
    const withWhisper = (w: Record<string, unknown>) => ({
      ...raw,
      stt: { ...stt, whisper: { ...whisper, ...w } },
    });
    expect(() => parseBackendConfig({ ...raw, stt: { ...stt, provider: "google" } })).toThrow(
      "stt.provider",
    );
    expect(() => parseBackendConfig(withWhisper({ url: "127.0.0.1:8081" }))).toThrow(
      "stt.whisper.url",
    );
    expect(() => parseBackendConfig(withWhisper({ language: "" }))).toThrow("stt.whisper.language");
    expect(() => parseBackendConfig(withWhisper({ hallucinations: ["a", ""] }))).toThrow(
      "stt.whisper.hallucinations",
    );
    expect(() => parseBackendConfig(withWhisper({ logprobThreshold: 0.1 }))).toThrow(
      "stt.whisper.logprobThreshold",
    );
    expect(() => parseBackendConfig(withWhisper({ logprobThreshold: "-0.3" }))).toThrow(
      "stt.whisper.logprobThreshold",
    );
    expect(
      parseBackendConfig(withWhisper({ logprobThreshold: -1 })).stt.whisper.logprobThreshold,
    ).toBe(-1);
    const bench = stt.bench as Record<string, unknown>;
    const withBench = (b: Record<string, unknown>) => ({
      ...raw,
      stt: { ...stt, bench: { ...bench, ...b } },
    });
    expect(() => parseBackendConfig(withBench({ executable: 1 }))).toThrow("stt.bench.executable");
    expect(() => parseBackendConfig(withBench({ extraArgs: [1] }))).toThrow("stt.bench.extraArgs");
    expect(() => parseBackendConfig(withBench({ vadModel: null }))).toThrow("stt.bench.vadModel");
    expect(() => parseBackendConfig(withBench({ models: [{ name: "a", file: "" }] }))).toThrow(
      "stt.bench.models",
    );
    expect(() =>
      parseBackendConfig(
        withBench({
          models: [
            { name: "a", file: "x.bin" },
            { name: "a", file: "y.bin" },
          ],
        }),
      ),
    ).toThrow("stt.bench.models");
  });
});
