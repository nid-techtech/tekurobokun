// InputSourceRegistry：入力元の一覧、有効な入力元1つ、マイクの一時停止（imple 3節）。
// 入力元は`robot`（機体のマイク）と、設定のconsoleの名前（`tablet`・`phone`）。一覧の先頭は常に`robot`。
// 切り替えは、管理用API（ランチャー・管理CLI）と、ターミナルのOperatorConsoleから行う。

import { ROBOT_SOURCE } from "@tekurobokun/protocol";

/** 変わったもの。`source`は有効な入力元、`mic`はマイクの一時停止。 */
export type InputSourceChange =
  | { kind: "source"; source: string }
  | { kind: "mic"; paused: boolean };

export class InputSourceRegistry {
  private readonly sources: readonly string[];
  private current: string;
  private paused = false;
  private readonly listeners = new Set<(change: InputSourceChange) => void>();

  /** activeが一覧になければ`robot`を有効にする。 */
  constructor(consoles: readonly string[], active: string) {
    this.sources = [ROBOT_SOURCE, ...consoles.filter((c) => c !== ROBOT_SOURCE)];
    this.current = this.sources.includes(active) ? active : ROBOT_SOURCE;
  }

  /** 入力元の一覧（`robot`、続けてconsoleの順）。 */
  list(): readonly string[] {
    return this.sources;
  }

  active(): string {
    return this.current;
  }

  isActive(source: string): boolean {
    return source === this.current;
  }

  micPaused(): boolean {
    return this.paused;
  }

  /** 一覧にある入力元を有効にする。一覧になければ何もせずfalseを返す。 */
  setActive(source: string): boolean {
    if (!this.sources.includes(source)) return false;
    if (source !== this.current) {
      this.current = source;
      this.notify({ kind: "source", source });
    }
    return true;
  }

  /** 一覧の順の番号（1始まり。1が`robot`）で有効にする。ターミナルの数字キー`1`〜`9`に使う。 */
  setActiveByNumber(n: number): boolean {
    const source = Number.isInteger(n) && n >= 1 ? this.sources[n - 1] : undefined;
    return source === undefined ? false : this.setActive(source);
  }

  /** マイクを一時停止する（true）・再開する（false）。 */
  setMicPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.notify({ kind: "mic", paused });
  }

  /** 有効な入力元かマイクの一時停止が変わったときに呼ばれる処理を登録する。戻り値で登録を外す。 */
  onChange(listener: (change: InputSourceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: InputSourceChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
