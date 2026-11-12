// DOMを組み立てる小さな関数。文字列はtextContentで入れ、HTMLとして解釈しない。

type Props = { class?: string; text?: string; attrs?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) el.setAttribute(key, value);
  el.append(...children);
  return el;
}

const MARK = "\u0000";

/**
 * 名前を含む文言を、名前だけ太字（<b>）にしたノードの列にする。
 * 文言は辞書から、名前を目印に置き換えて受け取る（文字列を連結して文を組み立てない）。
 */
export function withBoldName(render: (name: string) => string, name: string): Node[] {
  const nodes: Node[] = [];
  render(MARK)
    .split(MARK)
    .forEach((part, i) => {
      if (i > 0) nodes.push(h("b", { text: name }));
      if (part !== "") nodes.push(document.createTextNode(part));
    });
  return nodes;
}

/** 動きを減らす設定。 */
export const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
