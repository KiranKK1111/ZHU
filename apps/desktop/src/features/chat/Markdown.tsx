import "katex/dist/katex.min.css";
import "@/styles/chat.css";
import { Check, Copy } from "lucide-react";
import { memo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { toast } from "@/app/state/ui";
import { copyText, openExternal } from "@/services/shell";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/format";
import { prepareMarkdown } from "./chatText";

type HastNode = NonNullable<ExtraProps["node"]>;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/**
 * Models write <br> for a line break inside table cells and lists, where Markdown has no other
 * way to break a line. It is the one piece of HTML that is honoured; everything else stays text.
 */
function remarkLineBreaks() {
  const walk = (node: MdNode): void => {
    node.children?.forEach((child, i) => {
      if (child.type === "html" && /^<br\s*\/?>$/i.test((child.value ?? "").trim())) node.children![i] = { type: "break" };
      else walk(child);
    });
  };
  return (tree: MdNode) => walk(tree);
}

/** The text of a syntax tree node, for copying a code block as it was written. */
function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(nodeText).join("");
}

function codeLanguage(node: HastNode | undefined): string {
  const code = node?.children.find((c) => c.type === "element" && c.tagName === "code");
  const classes = code && code.type === "element" ? code.properties?.className : null;
  const lang = (Array.isArray(classes) ? classes : []).map(String).find((c) => c.startsWith("language-"));
  return lang ? lang.slice(9) : "";
}

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = codeLanguage(node);
  const copy = () => {
    void copyText(nodeText(node).replace(/\n$/, ""))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch((e) => toast.error("Copy failed", errorMessage(e)));
  };
  return (
    <div className="zhu-md-code">
      <div className="zhu-md-code-bar">
        <span>{language || "code"}</span>
        <button type="button" onClick={copy} aria-label="Copy code">
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const COMPONENTS: Components = {
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  // Links leave the app: they open in the user's browser, never inside ZHU's window.
  a: ({ href, children }: ComponentPropsWithoutRef<"a">) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void openExternal(href).catch((err) => toast.error("Could not open the link", errorMessage(err)));
      }}
    >
      {children}
    </a>
  ),
  // Remote images are not loaded (they would tell a third party that the answer was read).
  img: ({ alt, src }: ComponentPropsWithoutRef<"img">) => <span className="text-fg-3">[image{alt ? `: ${alt}` : ""}{src ? ` — ${src}` : ""}]</span>,
  table: ({ children }) => (
    <div className="zhu-md-table">
      <table>{children}</table>
    </div>
  ),
};

/**
 * A chat answer rendered as Markdown: tables and task lists (GFM), highlighted code with a copy
 * button, and LaTeX mathematics. Raw HTML in the text is shown as text, never interpreted.
 */
export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={cn("zhu-md selectable", streaming && "is-streaming", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkLineBreaks]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: false }]]} components={COMPONENTS}>
        {prepareMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
});
