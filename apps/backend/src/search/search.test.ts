import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchError } from "./engine.ts";
import { StubWebSearcher } from "./stub.ts";
import { readResults, TavilyWebSearcher } from "./tavily.ts";
import { jstMonth, SearchUsage } from "./usage.ts";

// Tavilyの代わりに、決まった応答を返すサーバーを立てる。
let respond: (req: Request, body: Record<string, unknown>) => Response | Promise<Response> = () =>
  new Response(null);
let lastBody: Record<string, unknown> = {};
let lastAuth: string | null = null;
const fake = Bun.serve({
  port: 0,
  fetch: async (req) => {
    lastBody = (await req.json()) as Record<string, unknown>;
    lastAuth = req.headers.get("authorization");
    return respond(req, lastBody);
  },
});
afterAll(() => fake.stop(true));

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tekurobokun-usage-"));
  dirs.push(dir);
  return join(dir, "data", "usage.json");
}

const tavilyResponse = {
  query: "q",
  answer: null,
  images: [],
  response_time: 0.5,
  results: [
    { title: " A ", url: "https://a.example", content: " 抜粋A ", score: 0.9 },
    { title: "B", url: "https://b.example", content: "抜粋B", score: 0.8 },
    { title: "C", url: "https://c.example", content: "抜粋C", score: 0.7 },
    { title: "D", url: "https://d.example", content: "抜粋D", score: 0.6 },
  ],
};

function tavily(over: { apiKey?: string; timeoutMs?: number } = {}) {
  const usage = new SearchUsage({ path: null });
  const searcher = new TavilyWebSearcher({
    config: {
      apiKey: over.apiKey ?? "tvly-test",
      maxResults: 3,
      timeoutMs: over.timeoutMs ?? 2000,
    },
    usage,
    url: `http://127.0.0.1:${fake.port}/search`,
  });
  return { searcher, usage };
}

async function failure(p: Promise<unknown>): Promise<SearchError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SearchError) return e;
    throw e;
  }
  throw new Error("expected SearchError");
}

describe("TavilyWebSearcher", () => {
  beforeEach(() => {
    respond = () => Response.json(tavilyResponse);
  });

  test("basicで検索し、抜粋を件数までにして返す", async () => {
    const { searcher, usage } = tavily();
    const outcome = await searcher.search("東京タワー 高さ");
    expect(lastAuth).toBe("Bearer tvly-test");
    expect(lastBody).toEqual({
      query: "東京タワー 高さ",
      search_depth: "basic",
      max_results: 3,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    });
    expect(outcome.results).toEqual([
      { title: "A", url: "https://a.example", snippet: "抜粋A" },
      { title: "B", url: "https://b.example", snippet: "抜粋B" },
      { title: "C", url: "https://c.example", snippet: "抜粋C" },
    ]);
    expect(Number.isInteger(outcome.ms)).toBe(true);
    expect(usage.current().count).toBe(1);
  });

  test("上限の超過（432・433）はquotaで、回数に数えない", async () => {
    for (const status of [432, 433]) {
      respond = () => Response.json({ detail: { error: "limit" } }, { status });
      const { searcher, usage } = tavily();
      const e = await failure(searcher.search("q"));
      expect(e.reason).toBe("quota");
      expect(e.message).toContain("limit");
      expect(usage.current().count).toBe(0);
    }
  });

  test("401はunauthorized、429・434はrate_limited", async () => {
    const cases: [number, string][] = [
      [401, "unauthorized"],
      [429, "rate_limited"],
      [434, "rate_limited"],
    ];
    for (const [status, reason] of cases) {
      respond = () => Response.json({ detail: { error: "x" } }, { status });
      const e = await failure(tavily().searcher.search("q"));
      expect(e.reason).toBe(reason as SearchError["reason"]);
    }
  });

  test("そのほかのHTTPのエラーはhttpで、回数に数える", async () => {
    respond = () => new Response("oops", { status: 500 });
    const { searcher, usage } = tavily();
    expect((await failure(searcher.search("q"))).reason).toBe("http");
    expect(usage.current().count).toBe(1);
  });

  test("時間切れはtimeoutで、回数に数える", async () => {
    respond = async () => {
      await Bun.sleep(300);
      return Response.json(tavilyResponse);
    };
    const { searcher, usage } = tavily({ timeoutMs: 50 });
    const e = await failure(searcher.search("q"));
    expect(e.reason).toBe("timeout");
    expect(e.ms).toBeGreaterThanOrEqual(40);
    expect(usage.current().count).toBe(1);
  });

  test("APIキーがなければ送らずにno_api_key", async () => {
    lastBody = {};
    const e = await failure(tavily({ apiKey: "" }).searcher.search("q"));
    expect(e.reason).toBe("no_api_key");
    expect(lastBody).toEqual({});
  });

  test("つながらなければnetwork", async () => {
    const searcher = new TavilyWebSearcher({
      config: { apiKey: "k", maxResults: 3, timeoutMs: 2000 },
      usage: new SearchUsage({ path: null }),
      url: "http://127.0.0.1:9/search",
    });
    expect((await failure(searcher.search("q"))).reason).toBe("network");
  });

  test("応答の形が崩れていればbad_response", async () => {
    respond = () => Response.json({ answer: "x" });
    expect((await failure(tavily().searcher.search("q"))).reason).toBe("bad_response");
    respond = () => new Response("not json");
    expect((await failure(tavily().searcher.search("q"))).reason).toBe("bad_response");
  });
});

describe("readResults", () => {
  test("url・contentのない項目は飛ばす", () => {
    expect(
      readResults({ results: [{ url: "u" }, { url: "u2", content: "c", title: 1 }] }, 3),
    ).toEqual([{ title: "", url: "u2", snippet: "c" }]);
  });
});

describe("StubWebSearcher", () => {
  test("決まった抜粋を返し、回数を数える", async () => {
    const usage = new SearchUsage({ path: null });
    const searcher = new StubWebSearcher({
      usage,
      maxResults: 2,
      data: {
        delayMs: 0,
        results: [
          { title: "a", url: "u1", snippet: "s1" },
          { title: "b", url: "u2", snippet: "s2" },
          { title: "c", url: "u3", snippet: "s3" },
        ],
        failTrigger: "FAIL",
        quotaTrigger: "QUOTA",
      },
    });
    expect((await searcher.search("x")).results.map((r) => r.url)).toEqual(["u1", "u2"]);
    expect((await failure(searcher.search("x FAIL"))).reason).toBe("stub");
    expect((await failure(searcher.search("x QUOTA"))).reason).toBe("quota");
    expect(searcher.monthCount().count).toBe(2);
  });
});

describe("SearchUsage", () => {
  test("月はJSTで、data/usage.jsonに書いて読み戻す", async () => {
    const path = await tempPath();
    // 2026-11-30T15:30Z は JSTで12月1日
    let now = new Date("2026-11-30T14:59:00Z");
    const usage = new SearchUsage({ path, now: () => now });
    await usage.load();
    expect(usage.current()).toEqual({ month: "2026-11", count: 0 });
    await usage.increment();
    await usage.increment();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ month: "2026-11", searchCount: 2 });

    const again = new SearchUsage({ path, now: () => now });
    await again.load();
    expect(again.current()).toEqual({ month: "2026-11", count: 2 });

    now = new Date("2026-11-30T15:30:00Z");
    expect(again.current()).toEqual({ month: "2026-12", count: 0 });
    await again.increment();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ month: "2026-12", searchCount: 1 });
  });

  test("崩れたファイルは0から数える", async () => {
    const path = await tempPath();
    const usage0 = new SearchUsage({ path });
    await usage0.increment();
    await writeFile(path, "{broken", "utf8");
    const usage = new SearchUsage({ path });
    await usage.load();
    expect(usage.current().count).toBe(0);
  });

  test("jstMonth", () => {
    expect(jstMonth(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01");
  });
});
