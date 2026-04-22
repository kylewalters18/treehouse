import { useEffect } from "react";
import { useWorkspaceStore } from "./stores/workspace";
import { useSettingsStore, ZOOM_STEP } from "./stores/settings";
import { useCommentsStore } from "./stores/comments";
import { Home } from "./routes/Home";
import { Workspace } from "./routes/Workspace";
import { Toaster } from "./components/Toaster";

export function App() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadComments = useCommentsStore((s) => s.load);
  const zoom = useSettingsStore((s) => s.settings.zoom);
  const adjustZoom = useSettingsStore((s) => s.adjustZoom);
  const resetZoom = useSettingsStore((s) => s.resetZoom);

  useEffect(() => {
    void loadSettings();
    void loadComments();
  }, [loadSettings, loadComments]);

  // Apply zoom to the root element. `zoom` is a non-standard CSS property but
  // is supported by WebKit (Tauri's webview) and is the only way to scale both
  // the React/Tailwind UI AND the pixel-sized fonts inside Monaco + xterm in
  // one go. Everything scales proportionally, including hit targets.
  useEffect(() => {
    document.documentElement.style.setProperty("zoom", String(zoom));
  }, [zoom]);

  // ⌘+ / ⌘- / ⌘0 — zoom in / zoom out / reset. Both `=` and `+` are accepted
  // because on macOS the shift state changes which key `event.key` reports.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        void adjustZoom(ZOOM_STEP);
      } else if (e.key === "-") {
        e.preventDefault();
        void adjustZoom(-ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        void resetZoom();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adjustZoom, resetZoom]);

  return (
    <div className="h-full w-full bg-neutral-950 text-neutral-100">
      {workspace ? <Workspace /> : <Home />}
      <Toaster />
    </div>
  );
}
