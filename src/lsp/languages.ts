import type { LspConfig } from "@/ipc/types";

/// Find the first *enabled* LSP config that declares this Monaco language
/// ID in its `filetypes`. Returns `null` if none is opt-in.
///
/// Collision policy (per design doc): first match wins. Users who want a
/// different server for a filetype must disable the clashing entry in
/// their `languages.toml`.
export function findConfigForLanguage(
  configs: LspConfig[],
  monacoLanguageId: string,
): LspConfig | null {
  for (const c of configs) {
    if (!c.enabled) continue;
    if (c.filetypes.includes(monacoLanguageId)) return c;
  }
  return null;
}
