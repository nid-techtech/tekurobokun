import { beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { pairingQrText } from "@tekurobokun/protocol";
import { prepareZXingModule as prepareWriter, writeBarcode } from "zxing-wasm/writer";
import { prepareQrReader, readPairingQr } from "./qrReader";

// 生成したQRの画像を読む（imple 3節。登録のQRの中身が読み戻せること）。
// WASMは node_modules のファイルを渡す（CDNに取りに行かない）。

const require = createRequire(import.meta.url);
const wasm = async (path: string) => Bun.file(require.resolve(path)).arrayBuffer();

beforeAll(async () => {
  prepareQrReader({ wasmBinary: await wasm("zxing-wasm/reader/zxing_reader.wasm") });
  prepareWriter({
    overrides: { wasmBinary: await wasm("zxing-wasm/writer/zxing_writer.wasm") },
    fireImmediately: false,
  });
});

async function qrImage(text: string): Promise<Blob> {
  const { image, error } = await writeBarcode(text, { format: "QRCode", scale: 4 });
  if (!image || error) throw new Error(`cannot write QR: ${error}`);
  return image;
}

describe("readPairingQr", () => {
  test("ランチャーが出す登録のQRから、公開URLとコードを読み取る", async () => {
    const text = pairingQrText("https://tekurobo.example.test", "ABCD-EFGH");
    expect(await readPairingQr(await qrImage(text))).toEqual({
      publicUrl: "https://tekurobo.example.test",
      code: "ABCD-EFGH",
    });
  });

  test("開発機のLANのURLも読める", async () => {
    const text = pairingQrText("http://192.168.0.10:8787", "WXYZ-2345");
    expect(await readPairingQr(await qrImage(text))).toEqual({
      publicUrl: "http://192.168.0.10:8787",
      code: "WXYZ-2345",
    });
  });

  test("登録のQRでなければnull", async () => {
    expect(await readPairingQr(await qrImage("https://example.test/"))).toBeNull();
  });
});
