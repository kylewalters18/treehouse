/// Runs when `VITE_E2E=true` is set (Playwright webServer). Installs a
/// stub for `@tauri-apps/api/core`'s `invoke` and `@tauri-apps/api/event`'s
/// `listen`, all gated on a flag the test can toggle via `window.__e2e`.
/// Default behaviour for any unmocked command is to return `null` and log
/// a warning so tests fail loudly if they drive a path they didn't prepare
/// for.
///
/// This file is only imported from `main.tsx` when the env flag is set,
/// so production bundles never ship it.

import { DEFAULT_SETTINGS } from "@/stores/settings";

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
    list_workspaces: async () => [],
    open_external_url: async () => null,
    get_settings: async () => structuredClone(DEFAULT_SETTINGS),
    list_comments: async () => [],
    list_pinned_worktrees: async () => [],
    list_branches: async () => [],
    lsp_list_configs: async () => [],
    lsp_resolve_command: async () => null,
  };
  const listeners: Record<string, Set<(ev: { payload: unknown }) => void>> = {};
  // `@tauri-apps/api` registers every JS callback (Channel handlers,
  // `listen` handlers) through `transformCallback` and passes the id.
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextCallbackId = 1;
  const listenerFns = new Map<number, (ev: { payload: unknown }) => void>();
  let nextListenerId = 1;

  const invoke: InvokeFn = async (cmd, args) => {
    // Tauri's event plugin routes through invoke("plugin:event|listen", ...)
    // — intercept so tests can `emit` on the same event name.
    if (cmd === "plugin:event|listen") {
      const { event, handler } = args as {
        event: string;
        handler: number | ((ev: { payload: unknown }) => void);
      };
      const fn =
        typeof handler === "number" ? callbacks.get(handler) : handler;
      if (!fn) return 0;
      const set = listeners[event] ?? (listeners[event] = new Set());
      set.add(fn);
      const id = nextListenerId++;
      listenerFns.set(id, fn);
      return id;
    }
    if (cmd === "plugin:event|unlisten") {
      // The handler was already dropped in `unregisterListener` below.
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
        transformCallback: (cb?: (payload: unknown) => void, once?: boolean) => number;
        unregisterCallback: (id: number) => void;
        postMessage: () => void;
        metadata: unknown;
      };
    }
  ).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(cb, once) {
      const id = nextCallbackId++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        cb?.(payload);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    postMessage: () => {},
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
      windows: [],
      webviews: [],
    },
  };

  // `unlisten()` drops the handler here before invoking the plugin.
  (
    window as unknown as {
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string, id: number) => void;
      };
    }
  ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      const fn = listenerFns.get(id);
      if (fn) listeners[event]?.delete(fn);
      listenerFns.delete(id);
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
