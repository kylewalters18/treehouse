/// Mermaid renderer for ` ```mermaid ` fences in the markdown preview.
/// Parallel to `markdown-shiki.ts`: a module-scope lazy import so the
/// ~1MB mermaid bundle is fetched once, and only when a file actually
/// contains a mermaid fence — never on app boot.
///
/// `mermaid.render` is the stateless entry point (no DOM mutation of
/// our nodes); it returns an SVG string we inject. We theme it `dark`
/// with a transparent background so diagrams blend into the preview
/// surface rather than punching out their own panel.

import type { MermaidConfig } from "mermaid";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

/// Monotonic id source. Mermaid requires a unique, CSS-selector-safe id
/// per render call; collisions corrupt previously rendered diagrams.
let renderSeq = 0;

function getMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
    const config: MermaidConfig = {
      startOnLoad: false,
      theme: "dark",
      darkMode: true,
      // Diagrams sit inside `prose` on the neutral-950 page; a
      // transparent canvas lets that background show through.
      themeVariables: { background: "transparent" },
      // Local markdown is trusted, but `strict` still blocks script
      // injection via diagram text at no cost to the diagram types we
      // care about (flow / sequence / class / state / ER / gantt).
      securityLevel: "strict",
    };
    mermaid.initialize(config);
    return mermaid;
  });
  return mermaidPromise;
}

export type MermaidResult =
  | { svg: string; error: null }
  | { svg: null; error: string };

/// Render one mermaid source block to an SVG string. Parse/syntax
/// errors are caught and returned rather than thrown so a malformed
/// diagram surfaces as a readable message instead of blanking the
/// whole preview.
export async function renderMermaid(code: string): Promise<MermaidResult> {
  try {
    const mermaid = await getMermaid();
    const id = `mermaid-${renderSeq++}`;
    const { svg } = await mermaid.render(id, code);
    return { svg, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { svg: null, error: message };
  }
}
