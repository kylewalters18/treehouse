/// LSP ↔ Monaco type converters. LSP positions are 0-indexed with UTF-16
/// code units as the character unit (matches Monaco's Position.column-1 /
/// lineNumber-1 after conversion). Monaco is 1-indexed for both line and
/// column.

import { Uri } from "monaco-editor";
import type * as monaco from "monaco-editor";
import type {
  CodeAction as LspCodeAction,
  Command as LspCommand,
  CompletionItem,
  CompletionItemKind as LspCompletionItemKind,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";

export function monacoPositionToLsp(p: monaco.Position): Position {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function lspRangeToMonaco(r: Range): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

export function lspSeverityToMarker(
  sev: DiagnosticSeverity | undefined,
): monaco.MarkerSeverity {
  // 1=Error, 2=Warning, 3=Information, 4=Hint → Monaco's 8/4/2/2.
  // Monaco renders MarkerSeverity.Hint (1) as a fixed `...` SVG pinned
  // at the marker's start (`no-repeat bottom left`), regardless of
  // range width. clangd publishes most clang-tidy modernize-/readability-
  // checks at LSP Hint with full-token ranges, and the `...` rendering
  // hides that range — fold Hint into Info so we get the standard
  // wavy underline across the full source range.
  switch (sev) {
    case 1:
      return 8 as monaco.MarkerSeverity;
    case 2:
      return 4 as monaco.MarkerSeverity;
    case 3:
      return 2 as monaco.MarkerSeverity;
    case 4:
      return 2 as monaco.MarkerSeverity;
    default:
      return 8 as monaco.MarkerSeverity;
  }
}

export function diagnosticToMarker(d: Diagnostic): monaco.editor.IMarkerData {
  return {
    severity: lspSeverityToMarker(d.severity),
    message: d.message,
    source: d.source,
    code: d.code !== undefined ? String(d.code) : undefined,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  };
}

function markupToMarkdown(
  content: MarkupContent | MarkedString | MarkedString[],
): monaco.IMarkdownString[] {
  if (Array.isArray(content)) {
    return content.flatMap(markupToMarkdown);
  }
  if (typeof content === "string") {
    return [{ value: content }];
  }
  if ("kind" in content) {
    return [{ value: content.value }];
  }
  if ("language" in content) {
    return [{ value: "```" + content.language + "\n" + content.value + "\n```" }];
  }
  return [];
}

export function hoverToMonaco(h: Hover): monaco.languages.Hover {
  return {
    contents: markupToMarkdown(h.contents),
    range: h.range ? lspRangeToMonaco(h.range) : undefined,
  };
}

export function lspLocationToMonaco(
  loc: Location | LocationLink,
): monaco.languages.Location {
  if ("targetUri" in loc) {
    return {
      uri: monacoUri(loc.targetUri),
      range: lspRangeToMonaco(loc.targetSelectionRange ?? loc.targetRange),
    };
  }
  return {
    uri: monacoUri(loc.uri),
    range: lspRangeToMonaco(loc.range),
  };
}

function monacoUri(u: string): monaco.Uri {
  return Uri.parse(u);
}

const COMPLETION_KIND_MAP: Record<number, monaco.languages.CompletionItemKind> = {
  1: 17 as monaco.languages.CompletionItemKind, // Text
  2: 0 as monaco.languages.CompletionItemKind, // Method
  3: 1 as monaco.languages.CompletionItemKind, // Function
  4: 2 as monaco.languages.CompletionItemKind, // Constructor
  5: 3 as monaco.languages.CompletionItemKind, // Field
  6: 4 as monaco.languages.CompletionItemKind, // Variable
  7: 5 as monaco.languages.CompletionItemKind, // Class
  8: 7 as monaco.languages.CompletionItemKind, // Interface
  9: 8 as monaco.languages.CompletionItemKind, // Module
  10: 9 as monaco.languages.CompletionItemKind, // Property
  11: 12 as monaco.languages.CompletionItemKind, // Unit → Value
  12: 12 as monaco.languages.CompletionItemKind, // Value
  13: 15 as monaco.languages.CompletionItemKind, // Enum
  14: 17 as monaco.languages.CompletionItemKind, // Keyword
  15: 27 as monaco.languages.CompletionItemKind, // Snippet
  16: 19 as monaco.languages.CompletionItemKind, // Color
  17: 20 as monaco.languages.CompletionItemKind, // File
  18: 21 as monaco.languages.CompletionItemKind, // Reference
  19: 23 as monaco.languages.CompletionItemKind, // Folder
  20: 16 as monaco.languages.CompletionItemKind, // EnumMember
  21: 14 as monaco.languages.CompletionItemKind, // Constant
  22: 6 as monaco.languages.CompletionItemKind, // Struct
  23: 10 as monaco.languages.CompletionItemKind, // Event
  24: 11 as monaco.languages.CompletionItemKind, // Operator
  25: 24 as monaco.languages.CompletionItemKind, // TypeParameter
};

/// Round-trip a Monaco `IMarkerData` (built earlier from a published LSP
/// diagnostic) back to an LSP `Diagnostic`. Needed when calling
/// `textDocument/codeAction`: clangd uses `context.diagnostics` to filter
/// to the fixes attached to the diagnostics under the cursor, so we must
/// pass them through with stable ranges/codes/sources.
export function markerToLspDiagnostic(
  m: monaco.editor.IMarkerData,
): Diagnostic {
  // Monaco severity 8/4/2/1 → LSP 1/2/3/4. The reverse mapping isn't
  // perfect because we collapse Hint → Info on the way in (see
  // `lspSeverityToMarker`); for code-action context this is fine since
  // clangd only matches by range + source + code, not severity.
  const sev: DiagnosticSeverity =
    m.severity === 8 ? 1 : m.severity === 4 ? 2 : m.severity === 2 ? 3 : 4;
  // Monaco's marker `code` can be either a bare string/number or
  // `{ value, target }` (the linked-code form). LSP only takes the
  // primitive form, so unwrap if needed.
  const code: string | number | undefined =
    typeof m.code === "object" && m.code !== null ? m.code.value : m.code;
  return {
    range: {
      start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
      end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
    },
    severity: sev,
    message: m.message,
    source: m.source,
    code,
  };
}

/// Translate an LSP `WorkspaceEdit` to Monaco's `WorkspaceEdit` shape.
/// `monacoFromLsp` resolves an LSP file URI back to the Monaco URI the
/// model is registered under (the LSP sees absolute `file://` paths;
/// Monaco may know the file under a worktree-relative model URI).
/// Edits whose target file we don't have a Monaco URI for are dropped —
/// Monaco's bulk-edit can't address them anyway. Non-edit document
/// operations (create/rename/delete) are also skipped; we don't preview
/// or apply those.
export function workspaceEditLspToMonaco(
  edit: WorkspaceEdit,
  monacoFromLsp: (lspUri: string) => monaco.Uri | null,
): monaco.languages.WorkspaceEdit | null {
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  if (edit.changes) {
    for (const [lspUri, textEdits] of Object.entries(edit.changes)) {
      const muri = monacoFromLsp(lspUri);
      if (!muri) continue;
      for (const e of textEdits) {
        edits.push({
          resource: muri,
          versionId: undefined,
          textEdit: { range: lspRangeToMonaco(e.range), text: e.newText },
        });
      }
    }
  }
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if (!("textDocument" in dc) || !Array.isArray(dc.edits)) continue;
      const muri = monacoFromLsp(dc.textDocument.uri);
      if (!muri) continue;
      for (const e of dc.edits) {
        if (!("newText" in e) || !("range" in e)) continue;
        const te = e as TextEdit;
        edits.push({
          resource: muri,
          versionId: undefined,
          textEdit: { range: lspRangeToMonaco(te.range), text: te.newText },
        });
      }
    }
  }
  if (edits.length === 0) return null;
  return { edits };
}

/// Convert an LSP `CodeAction` (or bare `Command`) into a Monaco
/// `CodeAction`. We pass the converted `WorkspaceEdit` through unchanged
/// so Monaco's lightbulb menu shows its built-in diff peek when the user
/// arrows through actions. The editor is mounted read-only (write-back
/// is post-MVP), so pressing Enter on an action will mutate the
/// in-memory model but not the file on disk; reopening the file
/// discards the in-memory edit.
export function codeActionToMonaco(
  action: LspCodeAction | LspCommand,
  monacoFromLsp: (lspUri: string) => monaco.Uri | null,
): monaco.languages.CodeAction {
  // A bare LSP `Command` (legacy path) has `command: string`; a
  // `CodeAction` has `command?: Command` plus a `title`. Tell them apart
  // by whether `command` is a string.
  if ("command" in action && typeof action.command === "string") {
    return { title: action.title };
  }
  const ca = action as LspCodeAction;
  const monacoEdit = ca.edit
    ? (workspaceEditLspToMonaco(ca.edit, monacoFromLsp) ?? undefined)
    : undefined;
  return {
    title: ca.title,
    kind: ca.kind,
    isPreferred: ca.isPreferred,
    edit: monacoEdit,
  };
}

export function completionItemToMonaco(
  item: CompletionItem,
  fallbackRange: monaco.IRange,
): monaco.languages.CompletionItem {
  const kind =
    COMPLETION_KIND_MAP[item.kind as LspCompletionItemKind] ??
    (17 as monaco.languages.CompletionItemKind);
  return {
    label: item.label,
    kind,
    detail: item.detail,
    documentation:
      item.documentation === undefined
        ? undefined
        : typeof item.documentation === "string"
          ? item.documentation
          : { value: item.documentation.value },
    insertText: item.insertText ?? item.label,
    range: fallbackRange,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
  };
}
