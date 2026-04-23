/// Global LSP session registry + Monaco provider wiring.
///
/// - `ensureSession(worktreeId, languageId, lspUri)` spawns or reattaches
///   to a Rust-side server and returns a ready `LspSession`.
/// - `openInSession` / `closeInSession` send didOpen/didClose for a Monaco
///   model and record the Monaco→LSP URI mapping.
/// - `ensureLanguageProviders` registers Monaco hover/definition/completion/
///   signatureHelp providers for a Monaco language on first use, and leaves
///   them registered for the lifetime of the app (providers dispatch to
///   whichever session claims the model — no churn on file switch).

import {
  languages as MonacoLanguages,
  editor as MonacoEditor,
  Uri,
} from "monaco-editor";
import type * as monaco from "monaco-editor";
import { lspEnsure, lspKill } from "@/ipc/client";
import type { LspConfig, WorktreeId } from "@/ipc/types";
import {
  ChannelMessageReader,
  ChannelMessageWriter,
  createConnection,
  onLspEvent,
} from "./transport";
import {
  closeDocument,
  initializeSession,
  markerOwner,
  openDocument,
  sessionKey,
  type LspSession,
  type SessionKey,
} from "./session";
import {
  completionItemToMonaco,
  hoverToMonaco,
  lspLocationToMonaco,
  monacoPositionToLsp,
} from "./convert";
import type {
  CompletionItem,
  CompletionList,
  Hover,
  Location,
  LocationLink,
  SignatureHelp,
} from "vscode-languageserver-protocol";

const sessions = new Map<SessionKey, LspSession>();

// Dev-only debug hook — lets us inspect session state from the devtools
// console without exporting internals. Safe to leave in; the field is
// cheap and useful when something isn't working.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__lspDebug = {
    sessions: () =>
      Array.from(sessions.values()).map((s) => ({
        key: s.key,
        worktreeId: s.worktreeId,
        languageId: s.languageId,
        serverId: s.serverId,
        rootUri: s.rootUri,
        capabilities: {
          hover: !!s.capabilities.hoverProvider,
          definition: !!s.capabilities.definitionProvider,
          completion: !!s.capabilities.completionProvider,
          signatureHelp: !!s.capabilities.signatureHelpProvider,
        },
        openedUris: Array.from(s.openedUris),
        monacoToLsp: Object.fromEntries(s.monacoToLspUri),
      })),
    /// Fire a raw hover request against the first session for a language.
    /// `line` and `character` are 0-indexed (LSP convention).
    hoverAt: async (languageId: string, line: number, character: number) => {
      return rawRequest(languageId, "textDocument/hover", line, character);
    },
    defAt: async (languageId: string, line: number, character: number) => {
      return rawRequest(languageId, "textDocument/definition", line, character);
    },
    providers: () => Array.from(providersRegisteredFor),
  };

  async function rawRequest(
    languageId: string,
    method: string,
    line: number,
    character: number,
  ) {
    for (const s of sessions.values()) {
      if (s.languageId !== languageId) continue;
      const uri = Array.from(s.openedUris)[0];
      if (!uri) return { error: "no open docs" };
      try {
        const result = await s.connection.sendRequest(method, {
          textDocument: { uri },
          position: { line, character },
        });
        return { uri, result };
      } catch (e) {
        return { error: String(e) };
      }
    }
    return { error: `no session for ${languageId}` };
  }
}

/// Inflight session spawns — prevents a double-spawn when two files in the
/// same worktree/language open in quick succession before the first ensure
/// resolves.
const inflight = new Map<SessionKey, Promise<LspSession>>();
const providersRegisteredFor = new Set<string>();

export async function ensureSession(
  worktreeId: WorktreeId,
  languageId: string,
  lspUri: string,
  _config: LspConfig,
  onStderr?: (text: string) => void,
): Promise<LspSession> {
  const key = sessionKey(worktreeId, languageId);
  const existing = sessions.get(key);
  if (existing) return existing;
  const pending = inflight.get(key);
  if (pending) return pending;

  ensureLanguageProviders(languageId);

  const promise = (async (): Promise<LspSession> => {
    const reader = new ChannelMessageReader();
    // Absolute filesystem path for workspace-root resolution on the Rust
    // side — strip the `file://` prefix.
    const filePath = lspUri.replace(/^file:\/\//, "");

    const session = await lspEnsure(
      worktreeId,
      languageId,
      filePath,
      onLspEvent({
        reader,
        onStderr,
        onStatus: (ev) => {
          // Server exited or crashed — drop our session so the next file
          // open respawns. Markers for open models in this session become
          // stale, but a fresh session will republish diagnostics.
          if (ev.status.kind === "exited" || ev.status.kind === "crashed") {
            const s = sessions.get(key);
            if (s) {
              sessions.delete(key);
              try {
                s.connection.dispose();
              } catch {
                /* ignore */
              }
            }
          }
        },
      }),
    );
    if (session.status.kind === "notFound") {
      throw new LspNotFoundError(session.status.command, session.status.hint);
    }

    const writer = new ChannelMessageWriter(session.id);
    const connection = createConnection(reader, writer);

    const ready = await initializeSession({
      key,
      worktreeId,
      languageId,
      serverId: session.id,
      rootUri: session.rootUri,
      connection,
    });
    sessions.set(key, ready);
    return ready;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

export class LspNotFoundError extends Error {
  constructor(
    public readonly command: string,
    public readonly hint: string | null,
  ) {
    super(`LSP command not found: ${command}`);
  }
}

export async function openInSession(
  session: LspSession,
  model: MonacoEditor.ITextModel,
  lspUri: string,
): Promise<void> {
  await openDocument(session, model, lspUri);
}

export async function closeInSession(
  worktreeId: WorktreeId,
  languageId: string,
  monacoUriString: string,
): Promise<void> {
  const session = sessions.get(sessionKey(worktreeId, languageId));
  if (!session) return;
  await closeDocument(session, monacoUriString);
  const model = MonacoEditor.getModel(Uri.parse(monacoUriString));
  if (model) {
    MonacoEditor.setModelMarkers(model, markerOwner(session), []);
  }
}

export async function disposeSessionsForWorktree(
  worktreeId: WorktreeId,
): Promise<void> {
  const toDispose: LspSession[] = [];
  for (const s of sessions.values()) {
    if (s.worktreeId === worktreeId) toDispose.push(s);
  }
  for (const s of toDispose) {
    sessions.delete(s.key);
    try {
      await s.dispose();
    } catch {
      /* ignore */
    }
    try {
      await lspKill(s.serverId);
    } catch {
      /* ignore */
    }
  }
}

function findSessionForModelUri(
  monacoUri: string,
  languageId: string,
): { session: LspSession; lspUri: string; monacoToLsp: Map<string, string> } | null {
  for (const s of sessions.values()) {
    if (s.languageId !== languageId) continue;
    const lspUri = s.monacoToLspUri.get(monacoUri);
    if (lspUri) {
      return { session: s, lspUri, monacoToLsp: s.monacoToLspUri };
    }
  }
  return null;
}

/// Flip an LSP-URI-bearing location to a Monaco-URI-bearing one. Returns
/// null for URIs we don't have a model for (post-MVP: open the file and
/// retry). `Location` and `LocationLink` both get their URI fields
/// rewritten in place on a shallow copy.
function rewriteLocationUri(
  loc: Location | LocationLink,
  monacoToLsp: Map<string, string>,
): Location | LocationLink | null {
  const reverse = new Map<string, string>();
  for (const [muri, luri] of monacoToLsp) reverse.set(luri, muri);

  if ("targetUri" in loc) {
    const monacoUri = reverse.get(loc.targetUri);
    if (!monacoUri) return null;
    return { ...loc, targetUri: monacoUri };
  }
  const monacoUri = reverse.get(loc.uri);
  if (!monacoUri) return null;
  return { ...loc, uri: monacoUri };
}

export type ResolvedDefinition =
  | { kind: "sameFile"; line: number; column: number }
  | { kind: "inWorktree"; relPath: string; line: number; column: number }
  | { kind: "external"; uri: string };

/// Query LSP for the definition at a position and classify the first
/// location. Called from the editor's ⌘-click handler; the caller decides
/// how to navigate based on `kind`. Returns `null` when the server has no
/// definition or the session isn't ready.
export async function resolveDefinition(opts: {
  worktreeId: WorktreeId;
  languageId: string;
  monacoModelUri: string;
  lineNumber: number;
  column: number;
}): Promise<ResolvedDefinition | null> {
  const found = findSessionForModelUri(opts.monacoModelUri, opts.languageId);
  if (!found || found.session.worktreeId !== opts.worktreeId) return null;
  if (!found.session.capabilities.definitionProvider) return null;

  const result = (await found.session.connection.sendRequest(
    "textDocument/definition",
    {
      textDocument: { uri: found.lspUri },
      position: { line: opts.lineNumber - 1, character: opts.column - 1 },
    },
  )) as Location | Location[] | LocationLink[] | null;

  if (!result) return null;
  const arr = Array.isArray(result) ? result : [result];
  if (arr.length === 0) return null;

  const first = arr[0];
  const targetUri = "targetUri" in first ? first.targetUri : first.uri;
  const targetRange =
    "targetSelectionRange" in first
      ? (first.targetSelectionRange ?? first.targetRange)
      : first.range;
  const line = targetRange.start.line + 1;
  const column = targetRange.start.character + 1;

  if (targetUri === found.lspUri) {
    return { kind: "sameFile", line, column };
  }

  const root = found.session.rootUri.endsWith("/")
    ? found.session.rootUri
    : found.session.rootUri + "/";
  if (targetUri.startsWith(root)) {
    return {
      kind: "inWorktree",
      relPath: targetUri.slice(root.length),
      line,
      column,
    };
  }
  return { kind: "external", uri: targetUri };
}

/// Register Monaco providers for a language on first use. Providers look
/// up the session at request time so they pick up new sessions without
/// needing to re-register.
export function ensureLanguageProviders(languageId: string): void {
  if (providersRegisteredFor.has(languageId)) return;
  providersRegisteredFor.add(languageId);

  MonacoLanguages.registerHoverProvider(languageId, {
    provideHover: async (model, position) => {
      const found = findSessionForModelUri(model.uri.toString(), languageId);
      if (!found || !found.session.capabilities.hoverProvider) return null;
      const result = (await found.session.connection.sendRequest(
        "textDocument/hover",
        {
          textDocument: { uri: found.lspUri },
          position: monacoPositionToLsp(position),
        },
      )) as Hover | null;
      if (!result) return null;
      return hoverToMonaco(result);
    },
  });

  MonacoLanguages.registerDefinitionProvider(languageId, {
    provideDefinition: async (model, position) => {
      const found = findSessionForModelUri(model.uri.toString(), languageId);
      if (!found || !found.session.capabilities.definitionProvider) return null;
      const result = (await found.session.connection.sendRequest(
        "textDocument/definition",
        {
          textDocument: { uri: found.lspUri },
          position: monacoPositionToLsp(position),
        },
      )) as Location | Location[] | LocationLink[] | null;
      if (!result) return null;
      const arr = Array.isArray(result) ? result : [result];
      // Peek-on-⌘-hover uses this provider too, so we only return
      // already-open locations. Cross-file goto is handled in
      // EditorPane's ⌘-click handler via `resolveDefinition`, which
      // knows how to open the target file first.
      const rewritten = arr
        .map((loc) => rewriteLocationUri(loc, found.monacoToLsp))
        .filter((loc): loc is NonNullable<typeof loc> => loc !== null);
      return rewritten.map(lspLocationToMonaco);
    },
  });

  MonacoLanguages.registerCompletionItemProvider(languageId, {
    triggerCharacters: [".", ":", "(", "<", "@", "/", "\\", "'", '"'],
    provideCompletionItems: async (model, position) => {
      const found = findSessionForModelUri(model.uri.toString(), languageId);
      if (!found || !found.session.capabilities.completionProvider) {
        return { suggestions: [] };
      }
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const result = (await found.session.connection.sendRequest(
        "textDocument/completion",
        {
          textDocument: { uri: found.lspUri },
          position: monacoPositionToLsp(position),
        },
      )) as CompletionItem[] | CompletionList | null;
      if (!result) return { suggestions: [] };
      const items = Array.isArray(result) ? result : result.items;
      return {
        suggestions: items.map((i) => completionItemToMonaco(i, range)),
        incomplete: !Array.isArray(result) && result.isIncomplete,
      };
    },
  });

  MonacoLanguages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: async (model, position) => {
      const found = findSessionForModelUri(model.uri.toString(), languageId);
      if (!found || !found.session.capabilities.signatureHelpProvider) {
        return null;
      }
      const result = (await found.session.connection.sendRequest(
        "textDocument/signatureHelp",
        {
          textDocument: { uri: found.lspUri },
          position: monacoPositionToLsp(position),
        },
      )) as SignatureHelp | null;
      if (!result) return null;
      return {
        value: {
          signatures: result.signatures.map((s) => ({
            label: s.label,
            documentation:
              s.documentation === undefined
                ? undefined
                : typeof s.documentation === "string"
                  ? s.documentation
                  : { value: s.documentation.value },
            parameters:
              s.parameters?.map((p) => ({
                label: p.label as string | [number, number],
                documentation:
                  p.documentation === undefined
                    ? undefined
                    : typeof p.documentation === "string"
                      ? p.documentation
                      : { value: p.documentation.value },
              })) ?? [],
            activeParameter: s.activeParameter,
          })),
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
        },
        dispose: () => {},
      };
    },
  });
}

