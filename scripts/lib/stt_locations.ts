// Speech-to-Text V2のLocations APIの応答から、ある言語で使えるモデルと機能を取り出す（scripts/stt_locations.ts）。
// メタデータは「言語 → モデル → 機能」の階層（LocationsMetadata.languages.models[言語].modelFeatures[モデル].modelFeature[]）。
// 形が想定と違っても止まらないよう、読めない部分は飛ばし、言語のキーが見つかった場所を生のまま返す。

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type ModelFeature = { feature: string; releaseState: string };
export type LocationModels = {
  location: string;
  /** モデル名 → 機能 */
  models: Record<string, ModelFeature[]>;
};

/** 1つのリージョンの情報（Locations APIのlistの1件）から、言語のモデルと機能を取り出す。なければnull。 */
export function modelsForLanguage(location: unknown, language: string): LocationModels | null {
  if (!isObj(location)) return null;
  const id =
    typeof location.locationId === "string"
      ? location.locationId
      : typeof location.name === "string"
        ? (location.name.split("/").at(-1) ?? location.name)
        : "?";
  const metadata = location.metadata;
  const languages = isObj(metadata) ? metadata.languages : undefined;
  const byLanguage = isObj(languages) ? languages.models : undefined;
  const entry = isObj(byLanguage) ? byLanguage[language] : undefined;
  const modelFeatures = isObj(entry) ? entry.modelFeatures : undefined;
  if (!isObj(modelFeatures)) return null;

  const models: Record<string, ModelFeature[]> = {};
  for (const [model, value] of Object.entries(modelFeatures)) {
    const list = isObj(value) && Array.isArray(value.modelFeature) ? value.modelFeature : [];
    models[model] = list.filter(isObj).map((f) => ({
      feature: typeof f.feature === "string" ? f.feature : "?",
      releaseState: typeof f.releaseState === "string" ? f.releaseState : "?",
    }));
  }
  return { location: id, models };
}

/** 形が想定と違ったときの手がかり：言語のキーが出てくる場所のパス（例：metadata.languages.models.ja-JP）。 */
export function findKeyPaths(value: unknown, key: string, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findKeyPaths(v, key, `${path}[${i}]`));
  }
  if (!isObj(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const p = path === "" ? k : `${path}.${k}`;
    return [...(k === key ? [p] : []), ...findKeyPaths(v, key, p)];
  });
}
