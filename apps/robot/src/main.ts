import { getCurrentWindow } from "@tauri-apps/api/window";
import { config } from "./config/config";
import { BarcodeKeyboardSource } from "./input/InputSource";
import { InputRouter } from "./input/InputRouter";
import { FacialEngine } from "./facial/FacialEngine";
import { AudioPlayer } from "./audio/AudioPlayer";
import { DebugHUD, type DebugSnapshot } from "./facial/DebugHUD";

// 走行（DriveStateMachine・シリアル通信）と音声スロット（数字キーでの再生）は、この版では配線しない。
// コードは今後の版のために残す。

const inputSource = new BarcodeKeyboardSource();
const router = new InputRouter(inputSource);

const facialContainer = document.querySelector<HTMLDivElement>("#facial-container");
if (facialContainer) {
  new FacialEngine(facialContainer, config.facial);
}

const audioPlayer = new AudioPlayer(config.audio.errorSound);

let currentCaption: string | null = null;
audioPlayer.onPlaybackStart((caption) => {
  currentCaption = caption;
});
audioPlayer.play(config.audio.startupGreeting);

// B7: `/`キーでON/OFFをトグルする。全可変パラメータ+発話キャプションをオーバーレイ表示。
const debugHUD = new DebugHUD(document.body);
let debugHUDEnabled = false;
router.onDebugToggle(() => {
  debugHUDEnabled = !debugHUDEnabled;
  debugHUD.setEnabled(debugHUDEnabled);
});

function buildDebugSnapshot(): DebugSnapshot {
  return {
    params: {
      "eyes.offsetX": config.facial.eyes.offsetX,
      "eyes.y": config.facial.eyes.y,
      "eyes.outerRadius": config.facial.eyes.outerRadius,
      "eyes.innerRadius": config.facial.eyes.innerRadius,
      "eyes.strokeWeight": config.facial.eyes.strokeWeight,
      "mouth.y": config.facial.mouth.y,
      "mouth.width": config.facial.mouth.width,
      "mouth.height": config.facial.mouth.height,
      "mouth.segments": config.facial.mouth.segments,
      "mouth.strokeWeight": config.facial.mouth.strokeWeight,
    },
    currentCaption,
  };
}

function tickDebugHUD(): void {
  debugHUD.update(buildDebugSnapshot());
  requestAnimationFrame(tickDebugHUD);
}
requestAnimationFrame(tickDebugHUD);

// `f`キーでウィンドウのフルスクリーン表示をトグルする。
const appWindow = getCurrentWindow();
window.addEventListener("keydown", (event) => {
  if (event.key !== "f") return;
  appWindow
    .isFullscreen()
    .then((isFullscreen) => appWindow.setFullscreen(!isFullscreen))
    .catch((e) => console.error("[window] fullscreen toggle failed:", e));
});
