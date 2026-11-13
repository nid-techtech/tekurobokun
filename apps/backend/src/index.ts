// バックエンドの起動。`--stub`を付けると、LLMとVOICEVOXなしで動く（imple 10節）。
//   bun apps/backend/src/index.ts [--stub]

import { CONFIG_DIR, loadBackendConfig, loadPersona, REPO_ROOT } from "./config.ts";
import { loadFilterConfig, WordListFilter } from "./content_filter.ts";
import { ConversationLog } from "./conversation_log.ts";
import { InputDeviceRegistry } from "./devices.ts";
import { buildSystemPrompt, type DialogueEngine } from "./dialogue/engine.ts";
import { LlamaDialogueEngine } from "./dialogue/llama.ts";
import { DEFAULT_STUB_DATA, StubDialogueEngine } from "./dialogue/stub.ts";
import { HealthMonitor, httpProbe } from "./health.ts";
import { OperatorConsole } from "./operator.ts";
import { Server } from "./server.ts";
import { ConversationSession } from "./session.ts";
import { StubAvailability } from "./stub_availability.ts";
import type { TtsEngine } from "./tts/engine.ts";
import { StubTtsEngine } from "./tts/stub.ts";
import { VoicevoxTtsEngine } from "./tts/voicevox.ts";

const stub = process.argv.includes("--stub");
const log = (line: string) => console.log(`[backend] ${line}`);

const config = await loadBackendConfig();

let dialogue: DialogueEngine;
let tts: TtsEngine;
let health: HealthMonitor;
/** スタブでLLM・VOICEVOXの停止を再現する切り替え（スタブのときだけ） */
const availability = stub ? new StubAvailability() : null;
if (availability) {
  const av = availability;
  dialogue = new StubDialogueEngine(undefined, () => av.isUp("llm"));
  tts = new StubTtsEngine({ isUp: () => av.isUp("tts") });
  health = new HealthMonitor(
    { llm: av.probe("llm"), tts: av.probe("tts") },
    config.healthIntervalMs,
  );
} else {
  const persona = await loadPersona();
  if (persona === null) log(`warning: ${CONFIG_DIR}persona.md not found; using reply format only`);
  dialogue = new LlamaDialogueEngine(config.llm, await buildSystemPrompt(persona));
  tts = new VoicevoxTtsEngine(config.tts);
  health = new HealthMonitor(
    {
      llm: httpProbe(`${config.llm.baseUrl}/health`),
      tts: httpProbe(`${config.tts.baseUrl}/version`),
    },
    config.healthIntervalMs,
  );
}

// 禁止語リストと定型の返事。スタブのときは、差し替えを確かめるためのスタブの禁止語を足す。
const filterConfig = await loadFilterConfig();
if (stub) filterConfig.words.push(...DEFAULT_STUB_DATA.filterWords);
const filter = new WordListFilter(filterConfig);

const devices = new InputDeviceRegistry(config.devices.list, config.devices.active);
const server = new Server({
  port: config.port,
  staticDir: `${REPO_ROOT}apps/console/dist`,
  settings: config.console,
  health,
  log,
});
// スタブのときは、試しの会話が本番の会話ログ（学習データ）に混ざらないよう、別のディレクトリに書く。
const logDir = `${REPO_ROOT}logs/${stub ? "stub/" : ""}`;
const conversationLog = new ConversationLog({ dir: logDir, log });

const session = new ConversationSession({
  filter,
  dialogue,
  tts,
  devices,
  health,
  emit: (message) => server.broadcast(message),
  sendToRobot: (message) => server.sendToRobot(message),
  displayTurns: config.historyDisplayTurns,
  speakingGraceMs: config.speakingGraceMs,
  record: (entry) => void conversationLog.append(entry),
  log,
});
// 当日の会話ログの末尾を、表示用の履歴として戻す（LLMに渡す往復は空から始める）。
session.restoreHistory(await conversationLog.loadRecent(config.historyDisplayTurns));
server.attach(session);

const operator = new OperatorConsole({
  devices,
  status: () => session.status(),
  stub: availability ? { availability, recheck: () => health.checkNow() } : undefined,
  write: (line) => console.log(line),
  quit: () => {
    log("quit");
    health.stop();
    server.stop();
    process.exit(0);
  },
});

// 接続・応答の有無と有効な端末が変わったら、全員にstatusを送り、ターミナルに状態を出す。
health.onChange(() => {
  session.broadcastStatus();
  operator.showStatus();
});
devices.onChange(() => {
  session.broadcastStatus();
  operator.showStatus();
});

server.start();
await health.start();
log(`${stub ? "stub mode, " : ""}listening on http://localhost:${server.port}/`);
log(`llm ${stub ? "stub" : `${config.llm.baseUrl} (${config.llm.model})`}`);
log(`tts ${stub ? "stub" : `${config.tts.baseUrl} (speaker ${config.tts.speaker})`}`);
log(`filter: ${filterConfig.words.length} words, ${filterConfig.replies.length} replies`);
log(`conversation log: ${logDir} (restored ${session.history().length} turns)`);
if (operator.attach(process.stdin)) {
  for (const line of operator.helpLines()) console.log(line);
} else {
  log("warning: stdin is not a terminal; device switching keys are disabled");
}
operator.showStatus();
