import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLocale } from "@tekurobokun/i18n";
import type { StatusMessage } from "@tekurobokun/protocol";
import { AudioPlayer } from "./audio/AudioPlayer";
import { config } from "./config/config";
import { DebugHUD, type DebugSnapshot } from "./facial/DebugHUD";
import { displayStateFor } from "./facial/displayState";
import { FaceState } from "./facial/FaceState";
import { FacialEngine } from "./facial/FacialEngine";
import { seededRandom } from "./facial/IdleAnimator";
import { InputRouter } from "./input/InputRouter";
import { BarcodeKeyboardSource } from "./input/InputSource";
import { RobotLink } from "./link/RobotLink";

// 機体アプリ：バックエンドから届くstatus・speechだけで顔と音声を決める（表示と音声再生だけの薄いクライアント）。
// 走行（DriveStateMachine・シリアル通信）と音声スロット（数字キーでの再生）は、この版では配線しない。
// コードは今後の版のために残す。

initLocale({ dev: import.meta.env.DEV });

const inputSource = new BarcodeKeyboardSource();
const router = new InputRouter(inputSource);

const audio = new AudioPlayer();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const face = new FaceState(
  {
    lipSync: config.lipSync,
    idle: config.idle,
    render: config.render,
    random: seededRandom(config.idle.seed ?? Date.now()),
    reducedMotion: () => reducedMotion.matches,
  },
  performance.now(),
);

const facialContainer = document.querySelector<HTMLDivElement>("#facial-container");
if (facialContainer) {
  new FacialEngine(facialContainer, face, {
    facial: config.facial,
    render: config.render,
    lookOffsetX: config.idle.lookOffsetX,
    level: () => audio.level(),
  });
}

const state: { connected: boolean; status: StatusMessage | null } = {
  connected: false,
  status: null,
};

function updateFace(): void {
  face.setState(displayStateFor(state.connected, state.status), performance.now());
}

const link = new RobotLink(config.backend.url, {
  onOpen: () => {
    state.connected = true;
    updateFace();
  },
  onClose: () => {
    state.connected = false;
    state.status = null;
    audio.stop();
    updateFace();
  },
  onMessage: (message) => {
    switch (message.type) {
      case "status":
        state.status = message;
        // 話し中でなくなったら（タイムアウト・合成の失敗など）、残りの音声は捨てる。
        if (message.session !== "speaking") audio.stop();
        updateFace();
        return;
      case "speech":
        if (state.status?.session !== "speaking") return;
        face.setEmotion(message.emotion);
        audio.enqueue(message);
        return;
      default:
        // welcome・turn_started・turn_repliedは、字幕（Phase 5）で使う。
        return;
    }
  },
});

let currentCaption: string | null = null;
audio.onSentenceStart((item) => {
  currentCaption = item.text;
});
audio.onSentenceEnd((item) => {
  currentCaption = null;
  link.send({ type: "playback_done", turnId: item.turnId, index: item.index });
});

updateFace();
link.connect();

// `/`キーでON/OFFをトグルする。全可変パラメータ+発話キャプションをオーバーレイ表示。
const debugHUD = new DebugHUD(document.body);
let debugHUDEnabled = false;
router.onDebugToggle(() => {
  debugHUDEnabled = !debugHUDEnabled;
  debugHUD.setEnabled(debugHUDEnabled);
});

function buildDebugSnapshot(): DebugSnapshot {
  return {
    params: {
      backend: config.backend.url,
      connected: String(state.connected),
      session: state.status?.session ?? "-",
      display: face.displayState,
      emotion: face.currentEmotion,
      "audio.level": audio.level().toFixed(3),
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
  if (debugHUDEnabled) debugHUD.update(buildDebugSnapshot());
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
