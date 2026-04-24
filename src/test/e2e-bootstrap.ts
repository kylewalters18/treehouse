/// Runs when `VITE_E2E=true` is set (Playwright webServer). Installs a
/// stub for `@tauri-apps/api/core`'s `invoke` and `@tauri-apps/api/event`'s
/// `listen`, all gated on a flag the test can toggle via `window.__e2e`.
/// Default behaviour for any unmocked command is to return `null` and log
/// a warning so tests fail loudly if they drive a path they didn't prepare
/// for.
///
/// This file is only imported from `main.tsx` when the env flag is set,
/// so production bundles never ship it.

type InvokeFn = (cmd: string, args?: unknown) => unknown | Promise<unknown>;
type InvokeHandler = (args?: unknown) => unknown | Promise<unknown>;

export interface E2EApi {
  /// Register a handler for a Tauri command. Replaces any previous handler.
  mock: (command: string, handler: InvokeHandler) => void;
  /// Fire a fake listen() event to all subscribers of `eventName`.
  emit: (eventName: string, payload: unknown) => void;
  /// Reset all registered handlers and listener sets.
  reset: () => void;
}

export function installE2EMocks(): void {
  // Seed sensible defaults for commands fired during app bootstrap so a
  // "do nothing" test still reaches a usable Home screen. Tests override
  // these via `window.__e2e.mock(...)` as needed.
  const handlers: Record<string, InvokeHandler> = {
    list_recent_workspaces: async () => [],
    get_settings: async () => ({
      syncStrategy: "rebase",
      mergeBackStrategy: "rebaseFf",
      initSubmodules: false,
      defaultAgentBackend: "claudeCode",
    }),
    list_comments: async () => [],
    lsp_list_configs: async () => [],
    lsp_resolve_command: async () => null,
  };
  const listeners: Record<string, Set<(ev: { payload: unknown }) => void>> = {};

  const invoke: InvokeFn = async (cmd, args) => {
    // Tauri's event plugin routes through invoke("plugin:event|listen", ...)
    // — intercept so tests can `emit` on the same event name.
    if (cmd === "plugin:event|listen") {
      const { event, handler } = args as {
        event: string;
        handler: (ev: { payload: unknown }) => void;
      };
      const set = listeners[event] ?? (listeners[event] = new Set());
      set.add(handler);
      return 1; // opaque listener id
    }
    if (cmd === "plugin:event|unlisten") {
      // We don't track id→event mapping; tests don't depend on unlisten
      // firing precisely, and per-page state resets between tests anyway.
      return undefined;
    }

    const handler = handlers[cmd];
    if (!handler) {
      console.warn("[e2e] no mock for invoke", cmd, args);
      return null;
    }
    return await handler(args);
  };

  (
    window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: InvokeFn;
        postMessage: () => void;
        metadata: unknown;
      };
    }
  ).__TAURI_INTERNALS__ = {
    invoke,
    postMessage: () => {},
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
      windows: [],
      webviews: [],
    },
  };

  const api: E2EApi = {
    mock(command, handler) {
      handlers[command] = handler;
    },
    emit(eventName, payload) {
      const set = listeners[eventName];
      if (!set) return;
      for (const h of set) h({ payload });
    },
    reset() {
      for (const key of Object.keys(handlers)) delete handlers[key];
      for (const key of Object.keys(listeners)) delete listeners[key];
    },
  };

  (window as unknown as { __e2e: E2EApi }).__e2e = api;
}
