// 音声認識の比較（scripts/bench_stt.ts）の計算。文字の誤り率と、モデルごとの集計。

import { type DiscardReason, phraseKey } from "../../apps/backend/src/stt/whisper.ts";

/** 誤り率を数えるために揃える（NFKCにして、空白・句読点・記号を除く）。 */
export function normalizeForCer(text: string): string {
  return phraseKey(text);
}

/** 文字（コードポイント）単位の編集距離（挿入・削除・置換を各1）。 */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[y.length] ?? 0;
}

/** 1つの録音の誤り。refLengthは正解の文字数（正規化後）。 */
export function characterErrors(
  reference: string,
  hypothesis: string,
): { distance: number; refLength: number } {
  const ref = normalizeForCer(reference);
  const hyp = normalizeForCer(hypothesis);
  return { distance: editDistance(ref, hyp), refLength: Array.from(ref).length };
}

/** 誤り率（0以上。挿入が多いと1を超える）。正解が空なら定義できないためnull。 */
export function characterErrorRate(reference: string, hypothesis: string): number | null {
  const { distance, refLength } = characterErrors(reference, hypothesis);
  return refLength === 0 ? null : distance / refLength;
}

export type DiscardReasonName = DiscardReason;

/** 1つの録音をモデルに流した結果 */
export type SampleResult = {
  file: string;
  /** 正解の文（正規化前）。空なら、無音・雑音だけの録音（何も出さないのが正しい） */
  reference: string;
  /** whisper-serverが返した文そのまま */
  raw: string;
  /** 捨てなかった文。捨てたときは空 */
  text: string;
  discarded: DiscardReasonName | null;
  /** 区切りごとのavg_logprob（区切りがなければ空） */
  logprobs: number[];
  ms: number;
};

/** 録音のavg_logprobの最小と最大。区切りがなければnull。
 * `low_logprob`は「すべての区切りがしきい値を下回る」ため、捨てるかどうかは最大で決まる。 */
export function logprobRange(logprobs: readonly number[]): { min: number; max: number } | null {
  if (logprobs.length === 0) return null;
  return { min: Math.min(...logprobs), max: Math.max(...logprobs) };
}

export type ModelSummary = {
  /** 正解のある録音の数 */
  speechCount: number;
  /** 正解のある録音の、全体の文字の誤り率（誤りの合計 ÷ 正解の文字数の合計）。正解のある録音がなければnull */
  cer: number | null;
  /** 無音・雑音だけの録音の数 */
  silentCount: number;
  /** 無音・雑音の録音で、文が出てしまった（捨てられなかった）数 */
  silentRecognized: number;
  /** 正解のある録音で、捨てられてしまった数 */
  speechDiscarded: number;
  discards: Record<DiscardReasonName, number>;
  /** 発話の録音のavg_logprob（録音ごとの最大）のうち、いちばん低いもの。これ以下のしきい値なら、確からしさで発話を捨てない */
  speechLogprobFloor: number | null;
  /** 無音・雑音の録音で文が出たもの（VADを通り抜けたもの）のavg_logprob（録音ごとの最大）のうち、いちばん高いもの。
   * これより大きいしきい値なら、確からしさでそれらを捨てられる（決まり文句で捨てるものも含む） */
  silentLogprobCeiling: number | null;
  medianMs: number | null;
  meanMs: number | null;
  maxMs: number | null;
};

export function summarize(results: readonly SampleResult[]): ModelSummary {
  const speech = results.filter((r) => normalizeForCer(r.reference) !== "");
  const silent = results.filter((r) => normalizeForCer(r.reference) === "");
  let distance = 0;
  let refLength = 0;
  for (const r of speech) {
    const e = characterErrors(r.reference, r.text);
    distance += e.distance;
    refLength += e.refLength;
  }
  const discards: Record<DiscardReasonName, number> = {
    empty: 0,
    low_logprob: 0,
    hallucination: 0,
  };
  for (const r of results) if (r.discarded !== null) discards[r.discarded] += 1;
  const maxes = (rs: readonly SampleResult[]) =>
    rs.flatMap((r) => {
      const range = logprobRange(r.logprobs);
      return range === null || r.raw.trim() === "" ? [] : [range.max];
    });
  const speechMaxes = maxes(speech);
  const silentMaxes = maxes(silent);
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  return {
    speechCount: speech.length,
    cer: refLength === 0 ? null : distance / refLength,
    silentCount: silent.length,
    silentRecognized: silent.filter((r) => r.discarded === null && r.text !== "").length,
    speechDiscarded: speech.filter((r) => r.discarded !== null).length,
    discards,
    speechLogprobFloor: speechMaxes.length === 0 ? null : Math.min(...speechMaxes),
    silentLogprobCeiling: silentMaxes.length === 0 ? null : Math.max(...silentMaxes),
    medianMs: times.length === 0 ? null : (times[Math.floor((times.length - 1) / 2)] ?? null),
    meanMs: times.length === 0 ? null : Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    maxMs: times.at(-1) ?? null,
  };
}
