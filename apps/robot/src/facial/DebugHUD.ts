export interface DebugSnapshot {
  params: Record<string, number | string>;
  currentCaption: string | null;
}

// FacialEngineとは完全に独立したDOMオーバーレイとして実装する（imple 4.9準拠）。
// OFF時はDOM要素をhiddenにするのみで、FacialEngineの描画には一切関与しない。
export class DebugHUD {
  private readonly container: HTMLElement;
  private enabled = false;

  constructor(root: HTMLElement) {
    this.container = document.createElement("pre");
    this.container.id = "debug-hud";
    this.container.hidden = true;
    root.appendChild(this.container);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.container.hidden = !enabled;
  }

  update(snapshot: DebugSnapshot): void {
    if (!this.enabled) return;

    const lines = Object.entries(snapshot.params).map(([key, value]) => `${key}: ${value}`);
    lines.push(`caption: ${snapshot.currentCaption ?? "(なし)"}`);
    this.container.textContent = lines.join("\n");
  }
}
