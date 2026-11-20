// 開発用の管理CLI（imple 4節）。バックエンドの管理用API（127.0.0.1）を呼ぶ。
//   bun run admin status                  状態を出す
//   bun run admin pair [--out FILE]       登録コードを発行し、文字で出してQRをSVGに書き出す（既定 data/pairing_qr.svg）
//   bun run admin exchange [--role robot|console] [--device NAME] [CODE]
//                                         コードをトークンに交換して出す（CODEを省くと発行してから交換する）。
//                                         機体の config.local.json の backend.token に書く（カメラのない開発機で登録するため）
//   bun run admin devices                 登録済みの端末を出す
//   bun run admin revoke ID               端末の登録を解除する
//   bun run admin source NAME             入力元を切り替える（robot か、設定のconsoleの名前）
//   bun run admin mic pause|resume        機体のマイクを一時停止・再開する
//   bun run admin reset                   LLMに渡す会話の履歴を消す（区切りの行を出す）
//   bun run admin model main|sub          LLMのモデルの別名を伝える（ランチャーの正→副の切り替えと同じ）

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ADMIN_PATHS,
  type AdminStatus,
  type DeviceRole,
  isDeviceRole,
  isLlmAlias,
  type PairingCode,
  parseAdminStatus,
  parsePairingCode,
  parseServerMessage,
  wsUrlFor,
} from "@tekurobokun/protocol";
import { loadBackendConfig, REPO_ROOT } from "../apps/backend/src/config.ts";
import { qrSvg } from "./lib/qr_svg.ts";

const USAGE = [
  "usage: bun run admin <command>",
  "  status",
  "  pair [--out FILE]",
  "  exchange [--role robot|console] [--device NAME] [CODE]",
  "  devices",
  "  revoke ID",
  "  source NAME",
  "  mic pause|resume",
  "  reset",
  "  model main|sub",
].join("\n");

class CliError extends Error {}

const config = await loadBackendConfig();
const adminBase = `http://127.0.0.1:${config.admin.port}`;

async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${adminBase}${path}`, init);
  } catch {
    throw new CliError(`cannot reach the admin api at ${adminBase}. Is the backend running?`);
  }
  if (!res.ok && res.status !== 204) {
    throw new CliError(`${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  }
  return res;
}

async function getStatus(): Promise<AdminStatus> {
  const status = parseAdminStatus(await (await call(ADMIN_PATHS.status)).json());
  if (!status) throw new CliError("unexpected response from /admin/status");
  return status;
}

async function issueCode(): Promise<PairingCode> {
  const res = await call(ADMIN_PATHS.pairingCodes, { method: "POST" });
  const code = parsePairingCode(await res.json());
  if (!code) throw new CliError("unexpected response from /admin/pairing-codes");
  return code;
}

/** 公開用ポートのWebSocket。待ち受け先が特定のアドレスならそこへ、そうでなければ127.0.0.1へつなぐ。 */
function publicWsUrl(): string {
  const wildcard = ["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(config.host);
  const host = wildcard
    ? "127.0.0.1"
    : config.host.includes(":")
      ? `[${config.host}]`
      : config.host;
  return `ws://${host}:${config.port}/ws`;
}

/** 公開用ポートにpairを送り、トークンを受け取る。 */
function exchange(role: DeviceRole, device: string | undefined, code: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(publicWsUrl());
    const timer = setTimeout(() => {
      ws.close();
      reject(new CliError("no answer from the backend within 10 s"));
    }, 10_000);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      ws.close();
      fn();
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "pair", role, ...(device ? { device } : {}), code }));
    };
    ws.onmessage = (e) => {
      const message = parseServerMessage(String(e.data));
      if (message?.type === "paired") finish(() => resolvePromise(message.token));
      if (message?.type === "pair_failed") {
        finish(() => reject(new CliError(`pairing failed: ${message.reason}`)));
      }
    };
    ws.onerror = () => finish(() => reject(new CliError(`cannot connect to ${publicWsUrl()}`)));
  });
}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "status": {
      const s = await getStatus();
      const up = (v: boolean) => (v ? "up" : "DOWN");
      console.log(
        `session=${s.session} input=${s.inputSource} mic=${s.micPaused ? "paused" : "on"}`,
      );
      console.log(
        `llm=${up(s.health.llm)} (${s.llmModel}) tts=${up(s.health.tts)} stt=${up(s.health.stt)} robot=${s.health.robot ? "connected" : "disconnected"}`,
      );
      console.log(`search=${s.searchCount.count} (${s.searchCount.month}) public=${s.publicUrl}`);
      console.log(`devices=${s.devices.length}`);
      return;
    }
    case "pair": {
      const out = resolve(takeOption(args, "--out") ?? `${REPO_ROOT}data/pairing_qr.svg`);
      const issued = await issueCode();
      await mkdir(dirname(out), { recursive: true });
      await Bun.write(out, await qrSvg(issued.qr));
      console.log(`code    ${issued.code}`);
      console.log(`expires ${issued.expiresAt}`);
      console.log(`qr      ${issued.qr}`);
      console.log(`svg     ${out}`);
      return;
    }
    case "exchange": {
      const role = takeOption(args, "--role") ?? "robot";
      if (!isDeviceRole(role)) throw new CliError(`--role must be robot or console`);
      const device = takeOption(args, "--device");
      if (role === "console" && !device) throw new CliError("--device is required for a console");
      const code = args[0] ?? (await issueCode()).code;
      const token = await exchange(role, device, code);
      console.log(`token ${token}`);
      if (role === "robot") {
        console.log("write to apps/robot/src/config/config.local.json:");
        console.log(
          JSON.stringify({ backend: { url: wsUrlFor(config.publicUrl), token } }, null, 2),
        );
      }
      return;
    }
    case "devices": {
      const { devices } = await getStatus();
      if (devices.length === 0) console.log("(no devices)");
      for (const d of devices) {
        console.log(
          `${d.id}  ${d.role.padEnd(7)} ${d.name.padEnd(8)} ${d.registeredAt}  ${d.connected ? "connected" : "-"}`,
        );
      }
      return;
    }
    case "revoke": {
      const id = args[0];
      if (!id) throw new CliError("usage: bun run admin revoke ID");
      await call(`${ADMIN_PATHS.devices}/${encodeURIComponent(id)}`, { method: "DELETE" });
      console.log(`revoked ${id}`);
      return;
    }
    case "source": {
      const source = args[0];
      if (!source) throw new CliError("usage: bun run admin source NAME");
      await call(ADMIN_PATHS.inputSource, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      });
      console.log(`input source ${source}`);
      return;
    }
    case "mic": {
      const action = args[0];
      if (action !== "pause" && action !== "resume") {
        throw new CliError("usage: bun run admin mic pause|resume");
      }
      await call(ADMIN_PATHS.mic, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: action === "pause" }),
      });
      console.log(`mic ${action === "pause" ? "paused" : "resumed"}`);
      return;
    }
    case "reset": {
      await call(ADMIN_PATHS.reset, { method: "POST" });
      console.log("history cleared");
      return;
    }
    case "model": {
      const alias = args[0];
      if (!isLlmAlias(alias)) throw new CliError("usage: bun run admin model main|sub");
      await call(ADMIN_PATHS.llmModel, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias }),
      });
      console.log(`llm model ${alias}`);
      return;
    }
    default:
      throw new CliError(USAGE);
  }
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError)) throw e;
  console.error(e.message);
  process.exit(1);
}
