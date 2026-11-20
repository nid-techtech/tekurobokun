// 質問のループを防ぐ判定（imple 4節）。
// LLMに渡す履歴の直近の返事が、続けてthreshold回以上、質問（末尾が全角・半角の疑問符）で終わっていたら、
// 今回の問い合わせに「質問で終わらず、自分の好みや意見を言う」指示を足す。比較スクリプトも同じ判定を使う。

// 全角の文字は、日本語の直書きの検査に当たらないよう文字コードで書く
// （正規表現のリテラルにすると、Biomeがエスケープを文字に戻すため）。
/** 末尾の閉じかっこ・引用符（全角の」』）】”’と、半角の)"'） */
const CLOSERS = String.fromCharCode(0x300d, 0x300f, 0xff09, 0x3011, 0x201d, 0x2019);
const TRAILING_CLOSERS = new RegExp(`[\\s${CLOSERS})"']+$`, "u");
/** 疑問符（全角・半角） */
const QUESTION_MARK = new RegExp(`[?${String.fromCharCode(0xff1f)}]$`, "u");

/** 返事が質問で終わっているか（末尾の空白・閉じかっこは見ない）。 */
export function endsWithQuestion(say: string): boolean {
  return QUESTION_MARK.test(say.trim().replace(TRAILING_CLOSERS, ""));
}

/** 末尾から数えて、続けて質問で終わっている返事の数。 */
export function trailingQuestions(replies: readonly string[]): number {
  let count = 0;
  for (let i = replies.length - 1; i >= 0; i--) {
    if (!endsWithQuestion(replies[i] ?? "")) break;
    count++;
  }
  return count;
}

/** 指示を足すか。thresholdが0なら足さない。 */
export function shouldAntiLoop(replies: readonly string[], threshold: number): boolean {
  return threshold > 0 && trailingQuestions(replies) >= threshold;
}
