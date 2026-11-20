import { describe, expect, test } from "bun:test";
import {
  normalizePairingCode,
  PAIRING_ALPHABET,
  PAIRING_CODE_PATTERN,
  pairingQrText,
  parsePairingQr,
  wsUrlFor,
} from "./pairing.ts";

describe("登録コード", () => {
  test("読み違えやすい文字を含まない", () => {
    for (const c of "0O1IL") expect(PAIRING_ALPHABET).not.toContain(c);
    expect(new Set(PAIRING_ALPHABET).size).toBe(PAIRING_ALPHABET.length);
  });

  test("入力の揺れをそろえる", () => {
    expect(normalizePairingCode("ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(normalizePairingCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(normalizePairingCode(" abcd efgh ")).toBe("ABCD-EFGH");
    expect(normalizePairingCode("AB-CD-EF-GH")).toBe("ABCD-EFGH");
  });

  test("長さ・使わない文字は受け付けない", () => {
    expect(normalizePairingCode("ABCD-EFG")).toBeNull();
    expect(normalizePairingCode("ABCD-EFGHJ")).toBeNull();
    expect(normalizePairingCode("ABCD-EF0H")).toBeNull();
    expect(normalizePairingCode("ABCD-EFIH")).toBeNull();
    expect(normalizePairingCode("")).toBeNull();
  });

  test("正規の形はパターンに合う", () => {
    expect(PAIRING_CODE_PATTERN.test("ABCD-2345")).toBe(true);
    expect(PAIRING_CODE_PATTERN.test("abcd-2345")).toBe(false);
  });
});

describe("QRの中身", () => {
  test("作って読み戻せる", () => {
    const text = pairingQrText("https://tekurobo.example.test/", "ABCD-EFGH");
    expect(text).toBe("https://tekurobo.example.test/pair#ABCD-EFGH");
    expect(parsePairingQr(text)).toEqual({
      publicUrl: "https://tekurobo.example.test",
      code: "ABCD-EFGH",
    });
  });

  test("LANのURLとポート", () => {
    expect(parsePairingQr("http://192.168.0.10:8787/pair#abcd-efgh")).toEqual({
      publicUrl: "http://192.168.0.10:8787",
      code: "ABCD-EFGH",
    });
  });

  test("形が違えばnull", () => {
    expect(parsePairingQr("https://example.test/pair")).toBeNull();
    expect(parsePairingQr("https://example.test/other#ABCD-EFGH")).toBeNull();
    expect(parsePairingQr("https://example.test/pair#XYZ")).toBeNull();
    expect(parsePairingQr("ftp://example.test/pair#ABCD-EFGH")).toBeNull();
    expect(parsePairingQr("/pair#ABCD-EFGH")).toBeNull();
    expect(parsePairingQr("hello")).toBeNull();
  });

  test("WebSocketの接続先", () => {
    expect(wsUrlFor("https://example.test")).toBe("wss://example.test/ws");
    expect(wsUrlFor("http://192.168.0.10:8787/")).toBe("ws://192.168.0.10:8787/ws");
  });
});
