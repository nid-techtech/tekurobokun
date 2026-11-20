// DOMを組み立てる小さな関数（apps/consoleと同じ）。文字列はtextContentで入れ、HTMLとして解釈しない。

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
