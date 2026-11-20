// QRコードのSVGを作る（zxing-wasm/writer）。WASMは node_modules から読み、CDNには取りに行かない。

import { createRequire } from "node:module";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";

const require = createRequire(import.meta.url);
let ready: Promise<unknown> | null = null;

function prepare(): Promise<unknown> {
  ready ??= (async () => {
    const path = require.resolve("zxing-wasm/writer/zxing_writer.wasm");
    const wasmBinary = await Bun.file(path).arrayBuffer();
    return prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
  })();
  return ready;
}

/** 文字列をQRコードのSVGにする。失敗したら例外を投げる。 */
export async function qrSvg(text: string): Promise<string> {
  await prepare();
  const result = await writeBarcode(text, { format: "QRCode", scale: 8 });
  if (result.error) throw new Error(`QR: ${result.error}`);
  return result.svg;
}
