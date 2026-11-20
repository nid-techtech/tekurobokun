import { describe, expect, test } from "bun:test";
import { findKeyPaths, modelsForLanguage } from "./lib/stt_locations.ts";

const location = {
  name: "projects/p/locations/asia-northeast1",
  locationId: "asia-northeast1",
  metadata: {
    "@type": "type.googleapis.com/google.cloud.speech.v2.LocationsMetadata",
    languages: {
      models: {
        "ja-JP": {
          modelFeatures: {
            chirp_3: {
              modelFeature: [
                { feature: "recognizer", releaseState: "GA" },
                { feature: "automatic_punctuation", releaseState: "GA" },
              ],
            },
            short: { modelFeature: [{ feature: "recognizer" }] },
          },
        },
      },
    },
  },
};

describe("stt_locations", () => {
  test("言語のモデルと機能を取り出す", () => {
    expect(modelsForLanguage(location, "ja-JP")).toEqual({
      location: "asia-northeast1",
      models: {
        chirp_3: [
          { feature: "recognizer", releaseState: "GA" },
          { feature: "automatic_punctuation", releaseState: "GA" },
        ],
        short: [{ feature: "recognizer", releaseState: "?" }],
      },
    });
  });

  test("言語がなければnull。形が違っても止まらず、キーの場所を探せる", () => {
    expect(modelsForLanguage(location, "en-US")).toBeNull();
    expect(
      modelsForLanguage({ locationId: "x", metadata: { other: { "ja-JP": 1 } } }, "ja-JP"),
    ).toBeNull();
    expect(findKeyPaths({ metadata: { other: [{ "ja-JP": 1 }] } }, "ja-JP")).toEqual([
      "metadata.other[0].ja-JP",
    ]);
  });
});
