import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLocale, m } from "@tekurobokun/i18n";
import type { StatusMessage } from "@tekurobokun/protocol";
import { AudioPlayer } from "./audio/AudioPlayer";
import { CaptionOverlay } from "./caption/CaptionOverlay";
import { captionFor } from "./caption/caption";
import { config } from "./config/config";
import { DebugHUD, type DebugSnapshot } from "./facial/DebugHUD";
import { displayStateFor } from "./facial/displayState";
import { FaceState } from "./facial/FaceState";
import { FacialEngine } from "./facial/FacialEngine";
import { seededRandom } from "./facial/IdleAnimator";
import { InputRouter } from "./input/InputRouter";
import { BarcodeKeyboardSource } from "./input/InputSource";
import { browserStorage, RobotCredentials } from "./link/credentials";
import { RobotLink } from "./link/RobotLink";
import { PairingScanner } from "./pairing/PairingScanner";
import { LevelDetector } from "./voice/LevelDetector";
import { SileroDetector } from "./voice/SileroDetector";
import { VoiceCapture } from "./voice/VoiceCapture";

// 機体アプリ：バックエンドから届くstatus・speechだけで顔と音声を決める（表示と音声再生だけの薄いクライアント）。
// 未登録（接続先かトークンがない・断られた）なら、登録の画面（S02g）でQRを読む。
// 入力元が機体のマイクのときは、VoiceCaptureで聞き、1発話をWAVで送る（文字にするのはバックエンド）。
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

const state: {
  connected: boolean;
  status: StatusMessage | null;
  /** 登録の画面の案内：QRを見せてもらう・古いコードだった */
  pairMessage: "show" | "expired";
  /** 登録できたときの「つながりました」をこの時刻まで出す */
  pairedUntil: number;
} = {
  connected: false,
  status: null,
  pairMessage: "show",
  pairedUntil: 0,
};

// 字幕：考え中は来場者の発言、話し中は読み上げている文。
const captionOverlay = new CaptionOverlay(document.body, config.caption);
let userText: string | null = null;
let currentCaption: string | null = null;

function updateCaption(): void {
  if (!link.paired) {
    captionOverlay.setText(
      state.pairMessage === "expired" ? m["pair.robot_expired"]() : m["pair.robot_show_qr"](),
    );
    return;
  }
  if (performance.now() < state.pairedUntil) {
    captionOverlay.setText(m["pair.robot_ok"]());
    return;
  }
  captionOverlay.set(
    captionFor({
      session: state.status?.session ?? null,
      userText,
      sentence: currentCaption,
    }),
  );
}

function updateFace(): void {
  // 未登録の間は、カメラの映像を全面に出す（顔は映像の下で待機のまま）。
  const paired = link.paired;
  if (paired) scanner.stop();
  else scanner.start();
  voice.setLink({ paired, connected: state.connected, status: state.status });
  face.setState(
    paired ? displayStateFor(state.connected, state.status) : "IDLE",
    performance.now(),
  );
  updateCaption();
}

/** 再生中の音声を捨てる（再生していないことをVoiceCaptureに伝える）。 */
function stopAudio(): void {
  audio.stop();
  voice.setPlaying(false);
}

// 機体のマイク。聞く条件（入力元・状態・マイクの一時停止・再生中）はVoiceCaptureが決める。
const voice = new VoiceCapture({
  createDetector: (events) =>
    config.voice.detector === "level"
      ? new LevelDetector(config.voice, events)
      : new SileroDetector(config.voice, events),
  send: (message) => link.send(message),
  maxUtteranceMs: config.voice.maxUtteranceMs,
  halfDuplexGraceMs: config.voice.halfDuplexGraceMs,
});

// 接続先とトークン。開発用に、config.local.jsonのbackend.url・backend.tokenがあればそれを使う。
const credentials = new RobotCredentials(browserStorage(), {
  url: config.backend.url,
  token: config.backend.token,
});

const link = new RobotLink(credentials, {
  onOpen: () => {
    state.connected = true;
    updateFace();
  },
  onClose: () => {
    state.connected = false;
    state.status = null;
    userText = null;
    currentCaption = null;
    stopAudio();
    updateFace();
  },
  onMessage: (message) => {
    switch (message.type) {
      case "auth_required":
        // 未登録・無効なトークン（RobotLinkがトークンを消す）。登録の画面へ。
        state.status = null;
        stopAudio();
        updateFace();
        return;
      case "pair_failed":
        state.pairMessage = "expired";
        updateCaption();
        return;
      case "paired": {
        // 笑った顔と「つながりました」を出してから、待機（S02a）へ。
        const now = performance.now();
        state.pairMessage = "show";
        state.pairedUntil = now + config.pairing.okHoldMs;
        face.flashEmotion("happy", now, config.pairing.okHoldMs);
        setTimeout(updateCaption, config.pairing.okHoldMs);
        updateFace();
        return;
      }
      case "status":
        state.status = message;
        // 話し中でなくなったら（タイムアウト・合成の失敗など）、残りの音声は捨てる。
        if (message.session !== "speaking") {
          stopAudio();
          currentCaption = null;
        }
        updateFace();
        return;
      case "turn_started":
        userText = message.turn.text;
        updateCaption();
        return;
      case "speech":
        if (state.status?.session !== "speaking") return;
        face.setEmotion(message.emotion);
        audio.enqueue(message);
        return;
      default:
        // welcome・turn_repliedは、機体では使わない。
        return;
    }
  },
});

audio.onSentenceStart((item) => {
  voice.setPlaying(true);
  currentCaption = item.text;
  updateCaption();
});
audio.onSentenceEnd((item) => {
  voice.setPlaying(false);
  currentCaption = null;
  updateCaption();
  link.send({ type: "playback_done", turnId: item.turnId, index: item.index });
});

const scanner = new PairingScanner(document.body, {
  intervalMs: config.pairing.scanIntervalMs,
  onCode: ({ publicUrl, code }) => link.pair(publicUrl, code),
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
      backend: link.url ?? "-",
      paired: String(link.paired),
      connected: String(state.connected),
      session: state.status?.session ?? "-",
      input: state.status
        ? `${state.status.inputSource}${state.status.micPaused ? " (mic paused)" : ""}`
        : "-",
      "voice.detector": config.voice.detector,
      "voice.active": String(voice.active),
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
