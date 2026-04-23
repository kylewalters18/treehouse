/// Per-(worktree, language) LSP session. Owns the JSON-RPC connection,
/// server capabilities, and the set of files currently opened against
/// the server. Monaco providers (hover, goto, completion, signature help)
/// are registered globally once per Monaco language — see `manager.ts`.

import {
  CompletionRequest,
  DefinitionRequest,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  SignatureHelpRequest,
  type ClientCapabilities,
  type InitializeResult,
  type PublishDiagnosticsParams,
  type ServerCapabilities,
} from "vscode-languageserver-protocol";
import { editor as MonacoEditor, Uri } from "monaco-editor";
import type { LspServerId, WorktreeId } from "@/ipc/types";
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
  },
  workspace: {
    workspaceFolders: true,
    configuration: false,
  },
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any;
}): Promise<LspSession> {
  const { connection } = opts;
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
    connection,
    dispose: async () => {
      try {
        await connection.sendRequest(ShutdownRequest.type);
        await connection.sendNotification(ExitNotification.type);
      } catch {
        // Server may already be dead — best-effort.
      }
      connection.dispose();
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
  MonacoEditor.setModelMarkers(
    model,
    markerOwner(session),
    params.diagnostics.map(diagnosticToMarker),
  );
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
  session.openedUris.add(lspUri);
  session.monacoToLspUri.set(model.uri.toString(), lspUri);

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
