/// LSP ↔ Monaco type converters. LSP positions are 0-indexed with UTF-16
/// code units as the character unit (matches Monaco's Position.column-1 /
/// lineNumber-1 after conversion). Monaco is 1-indexed for both line and
/// column.

import { Uri } from "monaco-editor";
import type * as monaco from "monaco-editor";
import type {
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
  // 1=Error, 2=Warning, 3=Information, 4=Hint — map to Monaco's 8/4/2/1.
  switch (sev) {
    case 1:
      return 8 as monaco.MarkerSeverity;
    case 2:
      return 4 as monaco.MarkerSeverity;
    case 3:
      return 2 as monaco.MarkerSeverity;
    case 4:
      return 1 as monaco.MarkerSeverity;
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
