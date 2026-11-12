// バックエンドの起動。`--stub`を付けると、LLMとVOICEVOXなしで動く（imple 10節）。
//   bun apps/backend/src/index.ts [--stub]

import { CONFIG_DIR, loadBackendConfig, loadPersona, REPO_ROOT } from "./config.ts";
import { InputDeviceRegistry } from "./devices.ts";
import { buildSystemPrompt, type DialogueEngine } from "./dialogue/engine.ts";
import { LlamaDialogueEngine } from "./dialogue/llama.ts";
import { StubDialogueEngine } from "./dialogue/stub.ts";
import { HealthMonitor, httpProbe } from "./health.ts";
import { Server } from "./server.ts";
import { ConversationSession } from "./session.ts";
import type { TtsEngine } from "./tts/engine.ts";
import { StubTtsEngine } from "./tts/stub.ts";
import { VoicevoxTtsEngine } from "./tts/voicevox.ts";

const stub = process.argv.includes("--stub");
const log = (line: string) => console.log(`[backend] ${line}`);

const config = await loadBackendConfig();

let dialogue: DialogueEngine;
let tts: TtsEngine;
let health: HealthMonitor;
if (stub) {
  dialogue = new StubDialogueEngine();
  tts = new StubTtsEngine();
  health = new HealthMonitor(
    { llm: async () => true, tts: async () => true },
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

const devices = new InputDeviceRegistry(config.devices.list, config.devices.active);
const server = new Server({
  port: config.port,
  staticDir: `${REPO_ROOT}apps/console/dist`,
  settings: config.console,
  health,
  log,
});
const session = new ConversationSession({
  dialogue,
  tts,
  devices,
  health,
  emit: (message) => server.broadcast(message),
  sendToRobot: (message) => server.sendToRobot(message),
  displayTurns: config.historyDisplayTurns,
  speakingGraceMs: config.speakingGraceMs,
  log,
});
server.attach(session);

health.onChange((h) => {
  log(`health llm=${h.llm} tts=${h.tts} robot=${h.robot}`);
  session.broadcastStatus();
});
devices.onChange((active) => {
  log(`active device: ${active}`);
  session.broadcastStatus();
});

server.start();
await health.start();
log(`${stub ? "stub mode, " : ""}listening on http://localhost:${server.port}/`);
log(`llm ${stub ? "stub" : `${config.llm.baseUrl} (${config.llm.model})`}`);
log(`tts ${stub ? "stub" : `${config.tts.baseUrl} (speaker ${config.tts.speaker})`}`);
log(`devices: ${devices.list().join(", ")} (active: ${devices.active()})`);
