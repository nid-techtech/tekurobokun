// Google Cloud Speech-to-Text V2で、ja-JPに使えるモデルとリージョンを一覧にする（imple 3節・T7-6）。
// Locations APIのlistを呼び、リージョンごとに、その言語のモデルと機能（`recognizer`の公開状態など）を出す。
// 認証は`config/backend.local.json`の`stt.google.keyFile`（サービスアカウントの鍵）。課金されない呼び出しだけを使う。
//   bun scripts/stt_locations.ts [--project ID] [--language ja-JP] [--json]
//     --project   プロジェクトID（省くと stt.google.projectId）
//     --language  言語（既定 ja-JP）
//     --json      リージョンごとの応答をそのまま出す（形が想定と違うときの確認用）

import { loadBackendConfig } from "../apps/backend/src/config.ts";
import { STT_LANGUAGE } from "../apps/backend/src/stt/google.ts";
import { GoogleAccessToken, keyFileLoader } from "../apps/backend/src/stt/google_auth.ts";
import { findKeyPaths, modelsForLanguage } from "./lib/stt_locations.ts";

class CliError extends Error {}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

async function main(args: string[]): Promise<void> {
  const config = await loadBackendConfig();
  const project = takeOption(args, "--project") ?? config.stt.google.projectId;
  const language = takeOption(args, "--language") ?? STT_LANGUAGE;
  const raw = args.includes("--json");
  const { keyFile } = config.stt.google;
  if (project === "") throw new CliError("set stt.google.projectId or pass --project");
  if (keyFile === "") throw new CliError("set stt.google.keyFile in config/backend.local.json");

  const token = new GoogleAccessToken({ loadKey: keyFileLoader(keyFile) });
  const locations: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://speech.googleapis.com/v2/projects/${project}/locations`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${await token.get()}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new CliError(`GET ${url.pathname}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { locations?: unknown[]; nextPageToken?: string };
    locations.push(...(body.locations ?? []));
    pageToken = body.nextPageToken || undefined;
  } while (pageToken);

  if (raw) {
    console.log(JSON.stringify(locations, null, 2));
    return;
  }
  console.log(`project ${project}, language ${language}, ${locations.length} locations`);
  let found = 0;
  for (const location of locations) {
    const result = modelsForLanguage(location, language);
    if (!result) {
      const paths = findKeyPaths(location, language);
      if (paths.length > 0) {
        console.log(
          `? ${JSON.stringify((location as { locationId?: string }).locationId)}: ${language} at ${paths.join(", ")} (unexpected shape; rerun with --json)`,
        );
      }
      continue;
    }
    found++;
    console.log(`\n${result.location}`);
    for (const [model, features] of Object.entries(result.models)) {
      const list = features.map((f) => `${f.feature}:${f.releaseState}`).join(" ");
      console.log(`  ${model.padEnd(20)} ${list}`);
    }
  }
  if (found === 0) console.log(`no location lists models for ${language}`);
  console.log(
    "\nRecognize needs a model whose features include recognizer. Put the location and model in stt.google.",
  );
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof CliError) && !(e instanceof Error && e.name === "GoogleAuthError")) throw e;
  console.error(e.message);
  process.exit(1);
}
