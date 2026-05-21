import { useEffect } from "react";
import { useWorkspaceStore } from "./stores/workspace";
import { useSettingsStore } from "./stores/settings";
import { useCommentsStore } from "./stores/comments";
import { Home } from "./routes/Home";
import { Workspace } from "./routes/Workspace";
import { Toaster } from "./components/Toaster";
import { onWorkspacesRestored } from "./ipc/client";

export function App() {
  // `workspaces.length` is the multi-repo gate: any open repo → Workspace
  // shell; none → Home. The boot-time Rust restore appends entries
  // asynchronously and fires `app://workspaces-restored` when done, so
  // we hydrate twice: once on mount (covers fast-restore + already-open
  // sessions on Cmd+R reload) and again when the event fires.
  const workspaceCount = useWorkspaceStore((s) => s.workspaces.length);
  const hydrate = useWorkspaceStore((s) => s.hydrate);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadComments = useCommentsStore((s) => s.load);

  useEffect(() => {
    void loadSettings();
    void loadComments();
    void hydrate();
    const off = onWorkspacesRestored(() => {
      void hydrate();
    });
    return () => {
      void off.then((fn) => fn()).catch(() => {});
    };
  }, [hydrate, loadSettings, loadComments]);

  return (
    <div className="h-full w-full bg-neutral-950 text-neutral-100">
      {workspaceCount > 0 ? <Workspace /> : <Home />}
      <Toaster />
    </div>
  );
}
