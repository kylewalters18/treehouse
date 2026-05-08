/// Per-(worktree, language) LSP session. Owns the JSON-RPC connection,
/// server capabilities, and the set of files currently opened against
/// the server. Monaco providers (hover, goto, completion, signature help)
/// are registered globally once per Monaco language — see `manager.ts`.

import {
  CompletionRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  SignatureHelpRequest,
  WorkDoneProgressCreateRequest,
  type ClientCapabilities,
  type InitializeResult,
  type ProgressToken,
  type PublishDiagnosticsParams,
  type ServerCapabilities,
  type TextDocumentContentChangeEvent,
  type WorkDoneProgressBegin,
  type WorkDoneProgressCreateParams,
  type WorkDoneProgressEnd,
  type WorkDoneProgressReport,
} from "vscode-languageserver-protocol";
import { editor as MonacoEditor, Uri } from "monaco-editor";
import type { LspServerId, PathMapping, WorktreeId } from "@/ipc/types";
import { diagnosticToMarker } from "./convert";

export type SessionKey = string; // `${worktreeId}::${languageId}`

export function sessionKey(
  worktreeId: WorktreeId,
  languageId: string,
): SessionKey {
  return `${worktreeId}::${languageId}`;
}

export interface LspSession {
  key: SessionKey;
  worktreeId: WorktreeId;
  languageId: string;
  serverId: LspServerId;
  rootUri: string;
  capabilities: ServerCapabilities;
  /// LSP URIs (absolute `file://...`) currently open against this server.
  /// Used by providers to filter whose request they should handle.
  openedUris: Set<string>;
  /// Monaco model URI string → LSP URI. Providers receive a Monaco model
  /// whose URI may not match the LSP URI (Monaco builds URIs from its
  /// `path` prop, which in our editor is worktree-relative). This map
  /// lets us translate at request time.
  monacoToLspUri: Map<string, string>;
  /// Document version per Monaco URI, bumped on every `didChange`.
  /// LSP requires monotonically increasing versions so the server can
  /// reject stale requests; tracked here so reopens of the same doc
  /// don't reuse a stale counter.
  documentVersions: Map<string, number>;
  /// Disposers for the `onDidChangeContent` subscriptions installed by
  /// `openDocument`. Keyed by Monaco URI; called from `closeDocument`
  /// so we don't leak listeners (or send `didChange` for closed files).
  documentChangeDisposers: Map<string, () => void>;
  /// Resolved host↔remote path translation, if any. Mirrored from the
  /// Rust-returned `LspServerSession.path_mapping` so debug surfaces
  /// (and any future per-session UI) can confirm the URI middleware
  /// is actually installed.
  pathMapping: PathMapping | null;
  /// Per-session connection. Keyed objects on this only — disposal kills
  /// the connection cleanly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any;
  dispose: () => Promise<void>;
}

const CLIENT_CAPABILITIES: ClientCapabilities = {
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: false,
    },
    hover: {
      dynamicRegistration: false,
      contentFormat: ["markdown", "plaintext"],
    },
    definition: { dynamicRegistration: false, linkSupport: true },
    completion: {
      dynamicRegistration: false,
      completionItem: {
        snippetSupport: false,
        documentationFormat: ["markdown", "plaintext"],
      },
    },
    signatureHelp: {
      dynamicRegistration: false,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
      },
    },
    publishDiagnostics: { relatedInformation: true },
    codeAction: {
      dynamicRegistration: false,
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "",
            "quickfix",
            "refactor",
            "refactor.extract",
            "refactor.inline",
            "refactor.rewrite",
            "source",
            "source.organizeImports",
          ],
        },
      },
      isPreferredSupport: true,
      disabledSupport: true,
    },
  },
  workspace: {
    workspaceFolders: true,
    configuration: false,
  },
  // Opt into server-initiated progress reporting. Servers (notably
  // rust-analyzer and pyright) use this to announce indexing / cargo
  // check / etc.; without advertising support, they stay silent and
  // the UI has no cue that work is in-flight.
  window: { workDoneProgress: true },
};

/// Progress state surfaced to the store for a single session. `null`
/// means no active progress; a non-null value means the server is
/// doing something (typically indexing) and the UI should indicate it.
export type SessionProgress = {
  title: string;
  message?: string;
  percentage?: number;
};

/// Boot an already-spawned LSP server. The connection is fully initialized
/// (initialize request + `initialized` notification), publishDiagnostics
/// is wired to Monaco markers, and the session is returned ready for
/// `openDocument` calls.
export async function initializeSession(opts: {
  key: SessionKey;
  worktreeId: WorktreeId;
  languageId: string;
  serverId: LspServerId;
  rootUri: string;
  pathMapping: PathMapping | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any;
  /// Called whenever the session's aggregate progress state changes.
  /// `null` means no active progress; a value is the most recent
  /// begin/report across all of the server's tokens. Keeping only one
  /// summary is fine for the simple "indexing…" indicator we show.
  onProgress?: (progress: SessionProgress | null) => void;
}): Promise<LspSession> {
  const { connection } = opts;

  // Per-token progress state — servers can run multiple concurrent
  // operations, each with its own token. We summarize by showing the
  // most recent begin/report. Cleared when the matching token ends.
  const progressTokens = new Map<string, SessionProgress>();

  const emitProgress = () => {
    if (!opts.onProgress) return;
    // Pick an arbitrary active token's state; most servers only run
    // one at a time anyway. If we later want stacked progress, this
    // is the place to extend.
    const first = progressTokens.values().next();
    opts.onProgress(first.done ? null : first.value);
  };

  // Respond success to `window/workDoneProgress/create` so the server
  // knows we accept its tokens. We have to register the handler before
  // `listen()` — otherwise early progress requests get rejected with
  // "method not found" and the server silently skips progress reporting.
  connection.onRequest(
    WorkDoneProgressCreateRequest.type,
    (_: WorkDoneProgressCreateParams) => {
      // Empty response = success per the spec.
      return null;
    },
  );

  // `$/progress` is a bare notification with `{ token, value }`, where
  // `value` is one of begin/report/end. vscode-jsonrpc doesn't ship a
  // typed request for this — register by string.
  connection.onNotification(
    "$/progress",
    (params: {
      token: ProgressToken;
      value:
        | WorkDoneProgressBegin
        | WorkDoneProgressReport
        | WorkDoneProgressEnd;
    }) => {
      const key = String(params.token);
      const v = params.value;
      if (v.kind === "begin") {
        progressTokens.set(key, {
          title: v.title,
          message: v.message,
          percentage: v.percentage,
        });
      } else if (v.kind === "report") {
        const prev = progressTokens.get(key);
        if (!prev) return;
        progressTokens.set(key, {
          title: prev.title,
          message: v.message ?? prev.message,
          percentage: v.percentage ?? prev.percentage,
        });
      } else if (v.kind === "end") {
        progressTokens.delete(key);
      }
      emitProgress();
    },
  );

  connection.listen();

  const result = (await connection.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: opts.rootUri,
    capabilities: CLIENT_CAPABILITIES,
    workspaceFolders: [{ uri: opts.rootUri, name: "worktree" }],
  })) as InitializeResult;

  await connection.sendNotification(InitializedNotification.type, {});

  const session: LspSession = {
    key: opts.key,
    worktreeId: opts.worktreeId,
    languageId: opts.languageId,
    serverId: opts.serverId,
    rootUri: opts.rootUri,
    capabilities: result.capabilities,
    openedUris: new Set(),
    monacoToLspUri: new Map(),
    documentVersions: new Map(),
    documentChangeDisposers: new Map(),
    pathMapping: opts.pathMapping,
    connection,
    dispose: async () => {
      // Deliberately skip the LSP `Shutdown` + `Exit` handshake.
      // `Shutdown` puts the server into a state where stdin-EOF
      // doesn't always trigger a clean exit (clangd in particular
      // sits waiting for the `Exit` notification — and our `Exit`
      // is fire-and-forget bytes that can get dropped between
      // `sendNotification` and `connection.dispose()`). The Rust-
      // side kill that follows this dispose drops stdin and
      // SIGKILLs the host child anyway, and servers handle a
      // bare stdin-EOF cleanly when they HAVEN'T been put into
      // shutdown state. Mirrors the Settings-toggle path which
      // hard-kills directly via `kill_for_language` and works
      // reliably for docker-wrapped LSPs where the polite path
      // leaves orphaned in-container processes.
      connection.dispose();
      // Surface a cleared progress state on disposal so the UI
      // doesn't leave "indexing…" hanging after the server exits.
      opts.onProgress?.(null);
    },
  };

  connection.onNotification(
    PublishDiagnosticsNotification.type,
    (params: PublishDiagnosticsParams) => {
      applyDiagnostics(session, params);
    },
  );

  return session;
}

function applyDiagnostics(
  session: LspSession,
  params: PublishDiagnosticsParams,
): void {
  // Find the Monaco model whose translated LSP URI equals `params.uri`.
  let monacoUriString: string | undefined;
  for (const [muri, luri] of session.monacoToLspUri.entries()) {
    if (luri === params.uri) {
      monacoUriString = muri;
      break;
    }
  }
  if (!monacoUriString) return;
  const uri = Uri.parse(monacoUriString);
  const model = MonacoEditor.getModel(uri);
  if (!model) return;
  // Rewrite `relatedInformation.resource` from the LSP URI namespace
  // (absolute `file://` paths Monaco doesn't have models for) back
  // into whatever URI the model was registered under, so clicking the
  // note actually navigates. URIs we don't recognize (system headers,
  // container-only paths) pass through unchanged — the text stays
  // readable, the click just won't resolve.
  const lspToMonaco = new Map<string, string>();
  for (const [muri, luri] of session.monacoToLspUri.entries()) {
    lspToMonaco.set(luri, muri);
  }
  const markers = params.diagnostics.map((d) => {
    const m = diagnosticToMarker(d);
    if (m.relatedInformation) {
      m.relatedInformation = m.relatedInformation.map((r) => {
        const muri = lspToMonaco.get(r.resource.toString());
        return muri ? { ...r, resource: Uri.parse(muri) } : r;
      });
    }
    return m;
  });
  MonacoEditor.setModelMarkers(model, markerOwner(session), markers);
}

export function markerOwner(session: LspSession): string {
  return `treehouse-lsp:${session.languageId}:${session.serverId}`;
}

/// Notify the server that the model is now open. `lspUri` is the server-
/// facing absolute `file://` URI; `model.uri.toString()` is what Monaco
/// knows it by. Both are recorded so providers + diagnostics can translate.
export async function openDocument(
  session: LspSession,
  model: MonacoEditor.ITextModel,
  lspUri: string,
): Promise<void> {
  if (session.openedUris.has(lspUri)) return;
  const monacoUriString = model.uri.toString();
  session.openedUris.add(lspUri);
  session.monacoToLspUri.set(monacoUriString, lspUri);
  session.documentVersions.set(monacoUriString, 1);

  // Forward Monaco edits as LSP `didChange` so the server's view of the
  // file stays in sync as the user types or applies code-action edits.
  // Without this, diagnostics freeze at open-time positions and drift
  // away from the live content. Subscribe BEFORE awaiting `didOpen` so
  // we don't miss a same-tick edit (rare but possible).
  const sub = model.onDidChangeContent((e) => {
    const next = (session.documentVersions.get(monacoUriString) ?? 1) + 1;
    session.documentVersions.set(monacoUriString, next);
    const contentChanges: TextDocumentContentChangeEvent[] = e.changes.map(
      (c) => ({
        range: {
          start: {
            line: c.range.startLineNumber - 1,
            character: c.range.startColumn - 1,
          },
          end: {
            line: c.range.endLineNumber - 1,
            character: c.range.endColumn - 1,
          },
        },
        text: c.text,
      }),
    );
    void session.connection.sendNotification(
      DidChangeTextDocumentNotification.type,
      {
        textDocument: { uri: lspUri, version: next },
        contentChanges,
      },
    );
  });
  session.documentChangeDisposers.set(monacoUriString, () => sub.dispose());

  await session.connection.sendNotification(
    DidOpenTextDocumentNotification.type,
    {
      textDocument: {
        uri: lspUri,
        languageId: session.languageId,
        version: 1,
        text: model.getValue(),
      },
    },
  );
}

export async function closeDocument(
  session: LspSession,
  monacoUriString: string,
): Promise<void> {
  const lspUri = session.monacoToLspUri.get(monacoUriString);
  if (!lspUri) return;
  session.openedUris.delete(lspUri);
  session.monacoToLspUri.delete(monacoUriString);
  session.documentVersions.delete(monacoUriString);
  const disposer = session.documentChangeDisposers.get(monacoUriString);
  if (disposer) {
    disposer();
    session.documentChangeDisposers.delete(monacoUriString);
  }

  await session.connection.sendNotification(
    DidCloseTextDocumentNotification.type,
    { textDocument: { uri: lspUri } },
  );
}

export const LSP_REQUEST = {
  hover: HoverRequest.type,
  definition: DefinitionRequest.type,
  completion: CompletionRequest.type,
  signatureHelp: SignatureHelpRequest.type,
};
