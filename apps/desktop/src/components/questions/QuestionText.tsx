import { memo, useEffect, useMemo, useState } from "react";
import { cn } from "@/utils/cn";
import { parseInlineCode } from "@/utils/text";

/** Question text with selectable inline code (SQL and code fragments arrive in backticks). */
export const QuestionText = memo(function QuestionText({ text, className, clamp }: { text: string; className?: string; clamp?: number }) {
  const parts = useMemo(() => parseInlineCode(text), [text]);
  return (
    <p className={cn("selectable whitespace-pre-wrap break-words", className)} style={clamp ? { display: "-webkit-box", WebkitLineClamp: clamp, WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}>
      {parts.map((p, i) =>
        p.kind === "code" ? (
          <code key={i} className="zhu-code">
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
});

/**
 * KaTeX rendering of question.math_latex. KaTeX is loaded on demand, so windows
 * that never show math (for example the sidecar) never download it. Falls back to
 * the LaTeX source if it cannot be parsed.
 */
export const MathBlock = memo(function MathBlock({ latex }: { latex: string }) {
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([import("katex"), import("katex/dist/katex.min.css")])
      .then(([k]) => {
        if (cancelled) return;
        try {
          setHtml(k.default.renderToString(latex, { throwOnError: true, displayMode: false, output: "html", strict: "ignore", trust: false }));
        } catch {
          setHtml(null);
        }
      })
      .catch(() => !cancelled && setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [latex]);
  if (!html) return <code className="zhu-code">{latex}</code>;
  return <span className="selectable text-fg" aria-label={`Math: ${latex}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
