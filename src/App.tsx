import { useWorkspaceStore } from "./stores/workspace";
import { Home } from "./routes/Home";
import { Workspace } from "./routes/Workspace";
import { Toaster } from "./components/Toaster";

export function App() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  return (
    <div className="h-full w-full bg-neutral-950 text-neutral-100">
      {workspace ? <Workspace /> : <Home />}
      <Toaster />
    </div>
  );
}
