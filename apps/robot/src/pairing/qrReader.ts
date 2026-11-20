// 登録のQRを読む（zxing-wasm/reader）。PairingScannerのカメラの画像と、単体テストの画像の両方に使う。
// WASMはアプリに同梱する（既定ではCDNから取りに行くため、読み込み先を差し替える）。

import { parsePairingQr } from "@tekurobokun/protocol";
import { prepareZXingModule, readBarcodes, type ZXingModuleOverrides } from "zxing-wasm/reader";

/** WASMの読み込み先を決める（アプリではViteが同梱したURL、テストではファイルの中身）。 */
export function prepareQrReader(overrides: ZXingModuleOverrides): void {
  prepareZXingModule({ overrides, fireImmediately: false });
}

/** 画像からQRを探し、登録のQR（`{公開URL}/pair#XXXX-XXXX`）なら、URLとコードを返す。 */
export async function readPairingQr(
  image: Blob | ImageData,
): Promise<{ publicUrl: string; code: string } | null> {
  const results = await readBarcodes(image, {
    formats: ["QRCode"],
    maxNumberOfSymbols: 1,
    tryHarder: true,
  });
  for (const result of results) {
    if (!result.isValid) continue;
    const parsed = parsePairingQr(result.text);
    if (parsed) return parsed;
  }
  return null;
}
