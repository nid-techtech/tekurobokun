export interface InputSource {
  onKeyDown(handler: (key: string) => void): void;
}

// keyupはバーコードリーダー入力（走行キー等）の仕様上不要なため、そもそも上位に伝播させない。
export class BarcodeKeyboardSource implements InputSource {
  private readonly handlers: Array<(key: string) => void> = [];

  constructor() {
    window.addEventListener("keydown", (event) => {
      for (const handler of this.handlers) {
        handler(event.key);
      }
    });
  }

  onKeyDown(handler: (key: string) => void): void {
    this.handlers.push(handler);
  }
}
