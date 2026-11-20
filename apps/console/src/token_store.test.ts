import { describe, expect, test } from "bun:test";
import { type StorageLike, TokenStore } from "./token_store.ts";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("TokenStore", () => {
  test("端末名ごとに保存し、読み戻し、消せる", () => {
    const storage = memoryStorage();
    const tablet = new TokenStore("tablet", storage);
    const phone = new TokenStore("phone", storage);
    expect(tablet.get()).toBeNull();
    tablet.set("t-token");
    phone.set("p-token");
    expect(new TokenStore("tablet", storage).get()).toBe("t-token");
    expect(storage.data.get("tekurobokun.token.phone")).toBe("p-token");
    tablet.clear();
    expect(tablet.get()).toBeNull();
    expect(phone.get()).toBe("p-token");
  });

  test("localStorageが使えなくても、開いている間はメモリに持つ", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const store = new TokenStore("tablet", broken);
    store.set("t");
    expect(store.get()).toBe("t");
    store.clear();
    expect(store.get()).toBeNull();
    const none = new TokenStore("tablet", null);
    none.set("x");
    expect(none.get()).toBe("x");
  });
});
