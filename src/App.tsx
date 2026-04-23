import { useEffect } from "react";
import { useWorkspaceStore } from "./stores/workspace";
import { useSettingsStore } from "./stores/settings";
import { useCommentsStore } from "./stores/comments";
import { Home } from "./routes/Home";
import { Workspace } from "./routes/Workspace";
import { Toaster } from "./components/Toaster";

export function App() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadComments = useCommentsStore((s) => s.load);

  useEffect(() => {
    void loadSettings();
    void loadComments();
  }, [loadSettings, loadComments]);

  return (
    <div className="h-full w-full bg-neutral-950 text-neutral-100">
      {workspace ? <Workspace /> : <Home />}
      <Toaster />
    </div>
  );
}
