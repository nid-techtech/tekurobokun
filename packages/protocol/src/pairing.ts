// 登録コードとQRの中身（imple 3節）。backend・console・robot・launcherで同じ規則を使う。
// 登録コードは`XXXX-XXXX`の8文字。読み違えやすい文字（0・O・1・I・L）を除いた英大文字と数字。
// QRの中身は`{公開URL}/pair#XXXX-XXXX`。

/** 登録コードに使う文字（31文字） */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_PATTERN =
  /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
export const PAIR_PATH = "/pair";

/**
 * 入力された登録コードを正規の形（`XXXX-XXXX`）にそろえる。
 * 小文字・空白・ハイフンの有無の違いは許す。8文字にならない、使わない文字を含むならnull。
 */
export function normalizePairingCode(input: string): string | null {
  const chars = input.toUpperCase().replace(/[\s-]/g, "");
  if (chars.length !== 8) return null;
  for (const c of chars) if (!PAIRING_ALPHABET.includes(c)) return null;
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** QRに入れる文字列。publicUrlの末尾の`/`は除く。 */
export function pairingQrText(publicUrl: string, code: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${PAIR_PATH}#${code}`;
}

/**
 * QRの中身から、バックエンドの公開URL（http(s)://host[:port]、末尾の`/`なし）と登録コードを取り出す。
 * 形が違えばnull。
 */
export function parsePairingQr(text: string): { publicUrl: string; code: string } | null {
  const hash = text.indexOf("#");
  if (hash < 0) return null;
  const base = text.slice(0, hash);
  const code = normalizePairingCode(text.slice(hash + 1));
  if (!code || !base.endsWith(PAIR_PATH)) return null;
  const publicUrl = base.slice(0, -PAIR_PATH.length).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { publicUrl, code };
}

/** 公開URL（http(s)）から、WebSocketの接続先（ws(s)://…/ws）を作る。 */
export function wsUrlFor(publicUrl: string): string {
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.hash = "";
  url.search = "";
  return url.toString();
}
