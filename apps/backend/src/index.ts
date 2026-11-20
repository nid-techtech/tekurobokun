// バックエンドの起動。`--stub`を付けると、LLMとVOICEVOXなしで動く（imple 10節）。
//   bun apps/backend/src/index.ts [--stub]

import { type AdminStatus, pairingQrText } from "@tekurobokun/protocol";
import { AdminApi } from "./admin_api.ts";
import { CONFIG_DIR, loadBackendConfig, loadPersona, REPO_ROOT } from "./config.ts";
import { loadFilterConfig, WordListFilter } from "./content_filter.ts";
import { ConversationLog } from "./conversation_log.ts";
import { DeviceAuth, FileDeviceStore } from "./device_auth.ts";
import { buildSystemPrompt, type DialogueEngine } from "./dialogue/engine.ts";
import { LlamaDialogueEngine } from "./dialogue/llama.ts";
import { DEFAULT_STUB_DATA, StubDialogueEngine } from "./dialogue/stub.ts";
import { HealthMonitor, httpProbe } from "./health.ts";
import { InputSourceRegistry } from "./input_sources.ts";
import { OperatorConsole } from "./operator.ts";
import { Server } from "./server.ts";
import { ConversationSession } from "./session.ts";
import type { SpeechRecognizer } from "./stt/engine.ts";
import { StubSpeechRecognizer } from "./stt/stub.ts";
import { WhisperSpeechRecognizer } from "./stt/whisper.ts";
import { StubAvailability } from "./stub_availability.ts";
import { toJstIso } from "./time.ts";
import type { TtsEngine } from "./tts/engine.ts";
import { StubTtsEngine } from "./tts/stub.ts";
import { VoicevoxTtsEngine } from "./tts/voicevox.ts";

const stub = process.argv.includes("--stub");
const log = (line: string) => console.log(`[backend] ${line}`);

const config = await loadBackendConfig();

/** 設定のSTT（whisper-serverかスタブ）。 */
function createSpeechRecognizer(): SpeechRecognizer {
  if (config.stt.provider === "stub") return new StubSpeechRecognizer();
  return new WhisperSpeechRecognizer({
    whisper: config.stt.whisper,
    timeoutMs: config.stt.timeoutMs,
    log,
  });
}

let dialogue: DialogueEngine;
let tts: TtsEngine;
let stt: SpeechRecognizer;
let health: HealthMonitor;
/** スタブでLLM・VOICEVOX・STTの停止を再現する切り替え（スタブのときだけ） */
const availability = stub ? new StubAvailability() : null;
if (availability) {
  const av = availability;
  dialogue = new StubDialogueEngine(undefined, () => av.isUp("llm"));
  tts = new StubTtsEngine({ isUp: () => av.isUp("tts") });
  stt = new StubSpeechRecognizer({ isUp: () => av.isUp("stt") });
  health = new HealthMonitor(
    { llm: av.probe("llm"), tts: av.probe("tts"), stt: av.probe("stt") },
    config.healthIntervalMs,
  );
} else {
  const persona = await loadPersona();
  if (persona === null) log(`warning: ${CONFIG_DIR}persona.md not found; using reply format only`);
  dialogue = new LlamaDialogueEngine(config.llm, await buildSystemPrompt(persona));
  tts = new VoicevoxTtsEngine(config.tts);
  stt = createSpeechRecognizer();
  health = new HealthMonitor(
    {
      llm: httpProbe(`${config.llm.baseUrl}/health`),
      tts: httpProbe(`${config.tts.baseUrl}/version`),
      stt: () => stt.probe(),
    },
    config.healthIntervalMs,
  );
}

// 禁止語リストと定型の返事。スタブのときは、差し替えを確かめるためのスタブの禁止語を足す。
const filterConfig = await loadFilterConfig();
if (stub) filterConfig.words.push(...DEFAULT_STUB_DATA.filterWords);
const filter = new WordListFilter(filterConfig);

// 入力元は、機体のマイク（robot）と設定のconsole。数字キーの1がrobot。
const sources = new InputSourceRegistry(config.inputSources.consoles, config.inputSources.active);
// 登録済みの端末（data/devices.json）。スタブでも同じファイルを使う（切り替えのたびに登録し直さないため）。
const devicesFile = `${REPO_ROOT}data/devices.json`;
const auth = new DeviceAuth({
  store: new FileDeviceStore(devicesFile),
  pairing: config.pairing,
  consoles: config.inputSources.consoles,
  log,
});
await auth.load();

const server = new Server({
  host: config.host,
  port: config.port,
  staticDir: `${REPO_ROOT}apps/console/dist`,
  settings: config.console,
  health,
  auth,
  onPaired: (device) => {
    admin.event("paired", `${device.role} ${device.name} ${device.id}`);
    admin.publishStatus();
  },
  onConnectionsChanged: () => admin.publishStatus(),
  log,
});
// スタブのときは、試しの会話が本番の会話ログ（学習データ）に混ざらないよう、別のディレクトリに書く。
const logDir = `${REPO_ROOT}logs/${stub ? "stub/" : ""}`;
const conversationLog = new ConversationLog({ dir: logDir, log });

const session = new ConversationSession({
  filter,
  dialogue,
  tts,
  stt,
  sources,
  health,
  emit: (message) => {
    server.broadcast(message);
    // 会話の状態が変わったら、管理用APIの購読者（ランチャー）にも流す。
    if (message.type === "status") admin.publishStatus();
  },
  sendToRobot: (message) => server.sendToRobot(message),
  displayTurns: config.historyDisplayTurns,
  speakingGraceMs: config.speakingGraceMs,
  record: (entry) => void conversationLog.append(entry),
  log,
});
// 当日の会話ログの末尾を、表示用の履歴として戻す（LLMに渡す往復は空から始める）。
session.restoreHistory(await conversationLog.loadRecent(config.historyDisplayTurns));
server.attach(session);

function adminStatus(): AdminStatus {
  const { session: state, inputSource, micPaused, health: h } = session.status();
  const now = toJstIso(new Date());
  return {
    session: state,
    inputSource,
    micPaused,
    health: h,
    llmModel: config.llm.activeAlias,
    // 検索の回数はPhase 8（WebSearcher）で数える。
    searchCount: { month: now.slice(0, 7), count: 0 },
    devices: auth.devices((id) => server.isConnected(id)),
    publicUrl: config.publicUrl,
  };
}

const admin = new AdminApi({
  port: config.admin.port,
  auth,
  publicUrl: config.publicUrl,
  status: adminStatus,
  onRevoked: (id) => server.disconnectDevice(id),
  sources,
  log,
});

const operator = new OperatorConsole({
  sources,
  status: () => session.status(),
  issuePairingCode: () => {
    const issued = auth.issueCode();
    return { ...issued, qr: pairingQrText(config.publicUrl, issued.code) };
  },
  stub: availability ? { availability, recheck: () => health.checkNow() } : undefined,
  write: (line) => console.log(line),
  quit: () => {
    log("quit");
    health.stop();
    server.stop();
    admin.stop();
    process.exit(0);
  },
});

// 接続・応答の有無と入力元・マイクが変わったら、全員にstatusを送り、ターミナルに状態を出す。
health.onChange(() => {
  session.inputConditionsChanged();
  session.broadcastStatus();
  admin.publishStatus();
  operator.showStatus();
});
sources.onChange((change) => {
  if (change.kind === "source") admin.event("input_source", change.source);
  else admin.event("mic", change.paused ? "paused" : "resumed");
  session.inputConditionsChanged();
  session.broadcastStatus();
  admin.publishStatus();
  operator.showStatus();
});

server.start();
admin.start();
await health.start();
log(`${stub ? "stub mode, " : ""}listening on http://${config.host}:${server.port}/`);
log(
  `llm ${stub ? "stub" : `${config.llm.baseUrl} (${config.llm.activeAlias}: ${config.llm.model})`}`,
);
log(`tts ${stub ? "stub" : `${config.tts.baseUrl} (speaker ${config.tts.speaker})`}`);
log(
  `stt ${
    stub || config.stt.provider === "stub"
      ? "stub"
      : `whisper ${config.stt.whisper.url} (${config.stt.whisper.language}, no speech > ${config.stt.whisper.noSpeechThreshold}, ${config.stt.whisper.hallucinations.length} hallucinations)`
  }`,
);
log(`filter: ${filterConfig.words.length} words, ${filterConfig.replies.length} replies`);
log(`conversation log: ${logDir} (restored ${session.history().length} turns)`);
log(`admin api: http://127.0.0.1:${admin.port}/admin/status (public url ${config.publicUrl})`);
log(`devices: ${devicesFile} (${auth.devices().length} registered)`);
if (operator.attach(process.stdin)) {
  for (const line of operator.helpLines()) console.log(line);
} else {
  log("warning: stdin is not a terminal; input source and mic keys are disabled");
}
operator.showStatus();
