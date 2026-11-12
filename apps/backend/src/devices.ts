// InputDeviceRegistry：端末の一覧と、入力を受け付ける有効な端末1台（imple 3節）。
// 切り替えは、バックエンドPCのターミナルでのキー入力（OperatorConsole、Phase 4）からだけ行う。

export class InputDeviceRegistry {
  private current: string;
  private readonly listeners = new Set<(active: string) => void>();

  /** activeが一覧になければ、一覧の先頭を有効にする（一覧が空なら、どの端末も有効にしない）。 */
  constructor(
    private readonly devices: readonly string[],
    active: string,
  ) {
    this.current = devices.includes(active) ? active : (devices[0] ?? "");
  }

  list(): readonly string[] {
    return this.devices;
  }

  active(): string {
    return this.current;
  }

  isActive(device: string): boolean {
    return this.current !== "" && device === this.current;
  }

  /** 一覧にある端末を有効にする。一覧になければ何もせずfalseを返す。 */
  setActive(device: string): boolean {
    if (!this.devices.includes(device)) return false;
    if (device !== this.current) {
      this.current = device;
      for (const listener of this.listeners) listener(device);
    }
    return true;
  }

  /** 一覧の順の番号（1始まり）で有効にする。ターミナルの数字キー`1`〜`9`に使う。 */
  setActiveByNumber(n: number): boolean {
    const device = Number.isInteger(n) && n >= 1 ? this.devices[n - 1] : undefined;
    return device === undefined ? false : this.setActive(device);
  }

  /** 有効な端末が変わったときに呼ばれる処理を登録する。戻り値で登録を外す。 */
  onChange(listener: (active: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
