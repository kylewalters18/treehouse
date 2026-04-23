import React from "react";
import ReactDOM from "react-dom/client";
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { App } from "./App";
import "./styles.css";

// E2E harness: stub the Tauri IPC layer before any app code imports it,
// gated on a Vite env flag so production bundles never ship the hook.
if (import.meta.env.VITE_E2E) {
  const { installE2EMocks } = await import("./test/e2e-bootstrap");
  installE2EMocks();
}

// Pin `@monaco-editor/react` to the Monaco instance we bundle ourselves.
// Without this, the React wrapper fetches Monaco from a CDN via its AMD
// loader — that instance is separate from the one `monaco-editor` imports
// resolve to, so any provider registered through a direct `monaco-editor`
// import lands on a ghost instance the editor never queries. This is why
// our LSP hover/definition/completion providers would register cleanly
// but the editor never called them.
loader.config({ monaco });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
