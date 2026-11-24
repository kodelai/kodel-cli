/** @jsxImportSource preact */
/**
 * The part of Markdown an agent writes in a report (headings, lists, code, emphasis, links), turned
 * straight into elements. No HTML is ever parsed or inserted: the text cannot add markup to the page.
 */
import type { ComponentChildren, JSX } from "preact";

/** A block, with the lines of the text it was made of (`from` to `to`, both counted from 0). */
export type Block = (
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
) & { from: number; to: number };

type Shape = Block extends infer B ? (B extends Block ? Omit<B, "from" | "to"> : never) : never;

const LIST = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

export function blocksOf(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let start = 0;
  const push = (b: Shape) =>
    blocks.push({
      ...b,
      from: start,
      to: Math.min(lines.length - 1, Math.max(start, i - 1)),
    } as Block);
  while (i < lines.length) {
    start = i;
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++;
      push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      i++;
      push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      i++;
      push({ kind: "rule" });
      continue;
    }
    const item = LIST.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i] ?? "");
        if (m && (m[2] !== undefined) === ordered) {
          items.push(m[3] ?? "");
        } else if ((lines[i] ?? "").startsWith("  ") && items.length > 0) {
          items[items.length - 1] += ` ${(lines[i] ?? "").trim()}`;
        } else {
          break;
        }
        i++;
      }
      push({ kind: "list", ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const body: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6})\s|^\s*```|^\s*>/.test(lines[i] ?? "") &&
      !LIST.exec(lines[i] ?? "")
    ) {
      body.push((lines[i] ?? "").trim());
      i++;
    }
    push({ kind: "para", text: body.join(" ") });
  }
  return blocks;
}

/** `code`, **bold**, *italic* and [links](https://...) inside a line. */
export function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const pattern =
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) out.push(<code>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined)
      out.push(<b>{inline(m[2] ?? m[3] ?? "")}</b>);
    else if (m[4] !== undefined) out.push(<i>{inline(m[4])}</i>);
    else if (m[5] !== undefined) {
      const href = m[6] ?? "";
      out.push(
        /^https?:\/\//.test(href) ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {m[5]}
          </a>
        ) : (
          m[5]
        ),
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One block as elements. */
export function BlockView(props: { b: Block }): JSX.Element {
  const { b } = props;
  switch (b.kind) {
    case "heading":
      return b.level <= 2 ? <h3>{inline(b.text)}</h3> : <h4>{inline(b.text)}</h4>;
    case "list":
      return b.ordered ? (
        <ol>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {b.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ul>
      );
    case "code":
      return <pre>{b.text}</pre>;
    case "quote":
      return <blockquote>{inline(b.text)}</blockquote>;
    case "rule":
      return <hr />;
    default:
      return <p>{inline(b.text)}</p>;
  }
}

export function Markdown(props: { text: string }) {
  return (
    <div class="md">
      {blocksOf(props.text).map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
}
