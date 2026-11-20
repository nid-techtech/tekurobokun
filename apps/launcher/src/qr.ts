// 登録コードのQR（zxing-wasm/writer）。WASMはアプリに同梱する（既定ではCDNから取りに行くため、読み込み先を差し替える）。
// 書き出したSVGは大きさが固定なので、viewBoxを付けて枠いっぱいに伸ばす。色はCSS（白地に黒、テーマに関係なし）で塗る。

import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";
import wasmUrl from "zxing-wasm/writer/zxing_writer.wasm?url";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
  fireImmediately: false,
});

/** 文字列をQRのSVG要素にする。失敗したら例外を投げる。 */
export async function qrElement(text: string): Promise<SVGSVGElement> {
  const result = await writeBarcode(text, { format: "QRCode", scale: 1 });
  if (result.error) throw new Error(`QR: ${result.error}`);
  const doc = new DOMParser().parseFromString(result.svg, "image/svg+xml");
  const svg = doc.documentElement as unknown as SVGSVGElement;
  if (svg.nodeName !== "svg") throw new Error("QR: not an svg");
  const width = svg.getAttribute("width") ?? "0";
  const height = svg.getAttribute("height") ?? "0";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  for (const desc of svg.querySelectorAll("desc")) desc.remove();
  return document.importNode(svg, true);
}
