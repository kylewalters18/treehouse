import type { LspConfig } from "@/ipc/types";

/// Find the first *enabled* LSP config that declares this Monaco language
/// ID in its `filetypes`. Returns `null` if none is opt-in.
///
/// Collision policy (per design doc): first match wins. Users who want a
/// different server for a filetype must disable the clashing entry in
/// the cog menu's Languages list.
export function findConfigForLanguage(
  configs: LspConfig[],
  enabledIds: ReadonlySet<string>,
  monacoLanguageId: string,
): LspConfig | null {
  for (const c of configs) {
    if (!enabledIds.has(c.id)) continue;
    if (c.filetypes.includes(monacoLanguageId)) return c;
  }
  return null;
}
