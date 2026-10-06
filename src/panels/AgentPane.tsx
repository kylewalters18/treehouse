import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "xterm/css/xterm.css";

import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  deleteAgentProfile,
  forgetAgentSession,
  killAgent,
  listAgentHistory,
  listAgentProfiles,
  listAgentsForWorktree,
  saveAgentProfile,
} from "@/ipc/client";
import type {
  AgentBackendKind,
  AgentHistoryEntry,
  AgentProfile,
  AgentSessionId,
  WorktreeId,
} from "@/ipc/types";
import { toastInfo, useToastsStore } from "@/stores/toasts";
import { cn } from "@/lib/cn";
import { acceptsPositionalPrompt } from "@/lib/agent";
import { asMessage } from "@/lib/errors";
import { instanceStrip, instanceTab, instanceTabClose } from "@/lib/pane-chrome";
import { ChevronDown, Plus, X } from "lucide-react";
import {
  buildLaunchProfiles,
  commandArgv,
  getLastProfileKey,
  resolveDefaultProfile,
  setLastProfileKey,
  tabLabelBase,
  type LaunchProfile,
} from "@/lib/agent-profiles";
import { AgentLaunchMenu } from "@/components/AgentLaunchMenu";
import { BackendIcon } from "@/components/BackendIcon";
import { fitAndPin } from "./xterm-fit";
import {
  createAgentLeafState,
  disposeAgentLeafState,
  getAgentLeafStates,
  reconcileAgentLeafStates,
  rekeyAgentLeafState,
  type AgentLeafMode,
  type AgentLeafState,
} from "./agent-leaf-state";
import { AgentHistoryList, AgentHistoryMenu, HistoryIcon } from "./AgentHistory";

export function AgentPane() {
  const worktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktree = useWorktreesStore((s) =>
    s.worktrees.find((w) => w.id === worktreeId),
  );
  const workspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === worktree?.workspaceId)?.root,
  );

  if (!worktreeId || !worktree) {
    return (
      <div className="flex h-full items-center justify-center border-l border-neutral-800 text-xs text-neutral-600">
        Select a worktree to launch an agent
      </div>
    );
  }
  return (
    <AgentTabs
      key={worktreeId}
      worktreeId={worktreeId}
      worktreeName={worktree.branch}
      workspaceRoot={workspaceRoot ?? ""}
    />
  );
}

type Tab = {
  localId: string;
  mode: AgentLeafMode;
  backend: AgentBackendKind;
  label: string;
  /// Continues a saved conversation (`claude --resume`,
  /// `kiro-cli chat --resume-id`).
  resumed?: boolean;
};

/// Backends whose closed tabs land in history (see `agent::history`).
function resumable(backend: AgentBackendKind): boolean {
  return backend === "claudeCode" || backend === "kiro";
}

/// How many times closing a resumable tab explains where it went.
const CLOSE_TOAST_LIMIT = 3;
const CLOSE_TOAST_KEY = "treehouse.agentHistoryToastCount";

function takeCloseToast(): boolean {
  try {
    const n = Number(localStorage.getItem(CLOSE_TOAST_KEY) ?? 0);
    if (n >= CLOSE_TOAST_LIMIT) return false;
    localStorage.setItem(CLOSE_TOAST_KEY, String(n + 1));
  } catch {}
  return true;
}

function AgentTabs({
  worktreeId,
  worktreeName,
  workspaceRoot,
}: {
  worktreeId: WorktreeId;
  worktreeName: string;
  /// Repo root — scopes launch profiles and the last-used profile.
  workspaceRoot: string;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [history, setHistory] = useState<AgentHistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refreshHistory = useCallback(async () => {
    try {
      const h = (await listAgentHistory(worktreeId)) ?? [];
      if (mounted.current) setHistory(h);
      return h;
    } catch {
      return null;
    }
  }, [worktreeId]);
  // Records appear once a conversation's first prompt lands, which
  // happens inside the agent's TTY — nothing on this side sees it, so
  // poll. The call is in-memory on the Rust side.
  useEffect(() => {
    void refreshHistory();
    const t = window.setInterval(() => void refreshHistory(), 15_000);
    return () => window.clearInterval(t);
  }, [refreshHistory]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /// xterm + host elements survive AgentTabs unmount/remount so scroll
  /// position, scrollback, selection, and search state aren't lost on
  /// worktree switch. Mirrors TerminalPane's `leafStatesByWorktree`.
  const leafStates = useMemo(() => getAgentLeafStates(worktreeId), [worktreeId]);
  const defaultBackend = useSettingsStore((s) => s.settings.defaultAgentBackend);
  const agentCommands = useSettingsStore((s) => s.settings.agentCommands);
  // `[[agent.profile]]` entries visible from this repo, re-read whenever
  // the launch menu opens so hand edits to treehouse.toml show up.
  const [configuredProfiles, setConfiguredProfiles] = useState<AgentProfile[]>([]);
  const profiles = useMemo(
    () => buildLaunchProfiles(configuredProfiles, agentCommands),
    [configuredProfiles, agentCommands],
  );
  // Read by async paths (adoption, the ⌘⇧A nonce) that can run before
  // the state above commits. Adoption writes it directly for that reason.
  const profilesRef = useRef<LaunchProfile[]>(profiles);
  profilesRef.current = profiles;
  const [lastProfileKey, setLastKey] = useState(() =>
    getLastProfileKey(workspaceRoot),
  );
  const defaultProfile = resolveDefaultProfile(profiles, lastProfileKey, defaultBackend);
  const [launchMenuOpen, setLaunchMenuOpen] = useState(false);
  const refreshProfiles = useCallback(async () => {
    const list = await listAgentProfiles(workspaceRoot).catch(() => null);
    if (list && mounted.current) setConfiguredProfiles(list);
    return list;
  }, [workspaceRoot]);
  const [initLoading, setInitLoading] = useState(true);
  const sessionIds = useRef<Map<string, AgentSessionId>>(new Map());
  const setActiveAgent = useUiStore((s) => s.setActiveAgent);
  const setAgentLabel = useUiStore((s) => s.setAgentLabel);
  const clearAgentLabel = useUiStore((s) => s.clearAgentLabel);
  const setAgentTabOrder = useUiStore((s) => s.setAgentTabOrder);
  // Cmd+Shift+A global shortcut → launch a new agent. The shortcut bumps
  // this nonce; we react by running `onLaunch` (same as the "+" button).
  const agentLaunchNonce = useUiStore((s) => s.agentLaunchNonce);
  // Capture the persisted state at first render — refs ensure later
  // effects (in particular the mirror-active-agent effect, which writes
  // `null` to the store on initial mount) can't clobber the values
  // before the adoption effect reads them. `useRef`'s initializer is
  // evaluated each render but only the first one is committed, so this
  // pulls a snapshot once per worktree-mount.
  const initialPersisted = useRef<{
    active: AgentSessionId | null;
    order: AgentSessionId[];
  }>({
    active:
      useUiStore.getState().activeAgentByWorktree[worktreeId] ?? null,
    order: useUiStore.getState().agentTabOrderByWorktree[worktreeId] ?? [],
  });
  // Drag-and-drop state. `dragLocalId` is the tab being held; `dragOverLocalId`
  // is the tab the cursor currently hovers, used to paint the drop indicator.
  // We ALSO mirror the dragged id into a ref so synchronous handlers
  // (`onDrop`) can read it without depending on React state having
  // committed since `onDragStart`.
  const [dragLocalId, setDragLocalId] = useState<string | null>(null);
  const [dragOverLocalId, setDragOverLocalId] = useState<string | null>(null);
  const dragLocalIdRef = useRef<string | null>(null);
  // Re-publishing the tab order to the store before adoption finishes
  // would clobber the user's saved order with `[]`. Gate writes on this
  // flag, set true once the adoption useEffect has committed its result.
  const adoptionDone = useRef(false);
  // Mirror `tabs` into a ref so callbacks (notably `onSession`, which
  // fires asynchronously from `launchAgent`) can read the current
  // array without grabbing a stale closure. Refs are mutated during
  // render, which is fine — we're only writing, not subscribing.
  const tabsRef = useRef<Tab[]>([]);

  // Mirror the active tab's session id into the UI store so other parts of
  // the app (notably the inline-comment send button) know which agent
  // receives messages for this worktree.
  useEffect(() => {
    const id = activeId ? sessionIds.current.get(activeId) ?? null : null;
    setActiveAgent(worktreeId, id);
  }, [activeId, worktreeId, setActiveAgent]);
  // Per-label-base tab counters ("Claude 2", "Reviewer 1").
  const counters = useRef<Record<string, number>>({});
  function nextLabel(base: string): string {
    counters.current[base] = (counters.current[base] ?? 0) + 1;
    return `${base} ${counters.current[base]}`;
  }

  // On worktree switch: discover already-running agents and adopt them as
  // attach-mode tabs so the user doesn't lose live sessions. Tabs are
  // sorted to the user's last-set order (per-worktree, persisted in the
  // UI store), and the active tab is restored from the stored
  // active-agent for this worktree — both fall back gracefully when the
  // stored state is empty or stale.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Read the persisted state from `initialPersisted` — captured
        // at first render, before any other effect could overwrite it.
        const storedOrder = initialPersisted.current.order;
        const storedActive = initialPersisted.current.active;

        const [existing, configured] = await Promise.all([
          listAgentsForWorktree(worktreeId),
          refreshProfiles(),
        ]);
        if (cancelled) return;
        // Labels below (and a pending default launch) need the profile
        // list now, not after the state update commits.
        profilesRef.current = buildLaunchProfiles(
          configured ?? [],
          useSettingsStore.getState().settings.agentCommands,
        );
        // Drop pool entries whose agent died while we were elsewhere,
        // plus any pre-session orphans from an in-flight launch whose
        // AgentTabs got unmounted before onSession could rekey.
        reconcileAgentLeafStates(
          worktreeId,
          new Set(existing.map((s) => s.id)),
        );
        // Phase 1: assign labels in `started_at` order so an agent's
        // number reflects its identity, not its current display
        // position. Without this split, dragging "Claude 3" to the
        // front and bouncing through another worktree would relabel
        // the moved tab to "Claude 1" — labels must follow the agent.
        const labelBySession = new Map<string, string>();
        for (const s of existing) {
          const label = nextLabel(
            tabLabelBase(s.backend, s.argv, profilesRef.current),
          );
          labelBySession.set(s.id, label);
          setAgentLabel(s.id, label);
        }
        // Phase 2: stable sort to user-preferred display order;
        // sessions absent from storedOrder land at the end in their
        // original `started_at` order.
        const orderIndex = new Map(storedOrder.map((id, i) => [id, i]));
        const sorted = [...existing].sort((a, b) => {
          const ia = orderIndex.has(a.id)
            ? (orderIndex.get(a.id) as number)
            : Number.MAX_SAFE_INTEGER;
          const ib = orderIndex.has(b.id)
            ? (orderIndex.get(b.id) as number)
            : Number.MAX_SAFE_INTEGER;
          return ia - ib;
        });
        const adopted: Tab[] = sorted.map((s) => {
          const localId = crypto.randomUUID();
          sessionIds.current.set(localId, s.id);
          return {
            localId,
            mode: { kind: "attach", agentId: s.id },
            backend: s.backend,
            label: labelBySession.get(s.id) as string,
            resumed: s.resumed,
          };
        });
        setTabs(adopted);
        // Prefer the previously-active session if it still exists;
        // otherwise pick the last tab so the user lands somewhere.
        const matchActive =
          storedActive !== null
            ? adopted.find((t) => sessionIds.current.get(t.localId) === storedActive)
            : null;
        setActiveId(
          matchActive?.localId ?? adopted[adopted.length - 1]?.localId ?? null,
        );
        adoptionDone.current = true;
        // New worktree created with "Start default agent" (or from an
        // issue, which seeds the first prompt): launch once, and only into
        // an empty pane so a remount never double-launches.
        const pending = useUiStore.getState().consumePendingAgentLaunch(worktreeId);
        if (pending && adopted.length === 0) {
          onLaunchRef.current(pending.prompt);
        }
      } catch {
        adoptionDone.current = true;
      } finally {
        if (!cancelled) setInitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreeId]);

  // Mirror tabs into the ref every render. This is a ref write, not a
  // setState — safe to do during render.
  tabsRef.current = tabs;

  // "Open agent" from the agent board while this worktree is already
  // selected: switch to the requested tab. Requests issued before this
  // mount were already honored through `initialPersisted`, so only
  // nonces newer than the one seen at mount count. Waits for adoption
  // when the tab isn't there yet.
  const focusRequest = useUiStore((s) => s.agentFocusRequest);
  const handledFocusNonce = useRef(
    useUiStore.getState().agentFocusRequest?.nonce ?? 0,
  );
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce <= handledFocusNonce.current) return;
    const tab = tabs.find(
      (t) => sessionIds.current.get(t.localId) === focusRequest.agentId,
    );
    if (!tab) return;
    handledFocusNonce.current = focusRequest.nonce;
    setActiveId(tab.localId);
  }, [focusRequest, tabs]);

  // Push the current tabs' session IDs (in display order) to the UI
  // store so a worktree switch + return restores the same order. Tabs
  // whose session ID hasn't been published yet (just-launched, awaiting
  // `onSession`) are filtered out — they'll get appended on the next
  // sync once their ID arrives. Call this from effects or from event
  // handlers — never from inside a `setTabs` updater (React invokes
  // updaters during render, and triggering a Zustand setter from there
  // produces "Cannot update a component while rendering" errors).
  function syncTabOrder() {
    if (!adoptionDone.current) return;
    const ids: AgentSessionId[] = [];
    for (const t of tabsRef.current) {
      const id = sessionIds.current.get(t.localId);
      if (id) ids.push(id);
    }
    setAgentTabOrder(worktreeId, ids);
  }

  // Re-sync whenever the rendered tab order changes (drop-reorder, new
  // launch, close). Runs after commit, so calling the Zustand setter
  // here is safe.
  useEffect(() => {
    syncTabOrder();
    // syncTabOrder is intentionally not in deps — it captures stable
    // store setter and refs, and re-creating it each render would
    // trigger this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  /// Open a new agent tab. `profileKey` (null for an Edit & launch
  /// one-off) becomes this repo's last-used profile.
  function launch(
    backend: AgentBackendKind,
    command: string,
    profileKey: string | null,
    prompt?: string,
  ) {
    setLaunchMenuOpen(false);
    // Empty command → undefined argv, which the Rust side resolves to the
    // backend's built-in default command.
    const argv = commandArgv(command);
    const next: Tab = {
      localId: crypto.randomUUID(),
      mode: { kind: "launch", backend, argv, prompt },
      backend,
      label: nextLabel(tabLabelBase(backend, argv, profilesRef.current)),
    };
    setTabs((prev) => [...prev, next]);
    setActiveId(next.localId);
    if (profileKey) {
      setLastProfileKey(workspaceRoot, profileKey);
      setLastKey(profileKey);
    }
  }

  /// `+`, ⌘⇧A, and "Start default agent": the repo's last-used profile.
  /// `prompt` (create-from-issue) is the agent's first message.
  function onLaunch(prompt?: string) {
    const p = resolveDefaultProfile(
      profilesRef.current,
      getLastProfileKey(workspaceRoot),
      useSettingsStore.getState().settings.defaultAgentBackend,
    );
    if (prompt && !acceptsPositionalPrompt(p.backend)) {
      toastInfo(
        "Agent started without the issue",
        "This backend can't take a starting prompt — use Send to agent on the issue chip.",
      );
    }
    launch(p.backend, p.command, p.key, prompt);
  }

  async function saveProfile(
    name: string,
    backend: AgentBackendKind,
    command: string,
  ): Promise<boolean> {
    try {
      await saveAgentProfile({ workspace: workspaceRoot, name, backend, command });
    } catch (e) {
      useToastsStore.getState().push({
        kind: "error",
        title: "Couldn't save profile",
        body: asMessage(e),
      });
      return false;
    }
    const list = await refreshProfiles();
    if (list) profilesRef.current = buildLaunchProfiles(list, agentCommands);
    return true;
  }

  async function deleteProfile(p: LaunchProfile) {
    try {
      await deleteAgentProfile(p.scope === "repo" ? workspaceRoot : null, p.name);
    } catch (e) {
      useToastsStore.getState().push({
        kind: "error",
        title: "Couldn't delete profile",
        body: asMessage(e),
      });
      return;
    }
    const list = await refreshProfiles();
    if (list) profilesRef.current = buildLaunchProfiles(list, agentCommands);
  }

  /// Reopen a saved conversation in a new tab, or switch to the tab that
  /// already has it.
  function resumeSession(entry: AgentHistoryEntry) {
    setHistoryOpen(false);
    if (entry.liveAgentId) {
      const open = tabsRef.current.find(
        (t) => sessionIds.current.get(t.localId) === entry.liveAgentId,
      );
      if (open) {
        setActiveId(open.localId);
        return;
      }
    }
    const { backend } = entry;
    const argv = commandArgv(agentCommands[backend]);
    const next: Tab = {
      localId: crypto.randomUUID(),
      mode: {
        kind: "launch",
        backend,
        argv,
        resume: entry.sessionId,
      },
      backend,
      label: nextLabel(tabLabelBase(backend, argv, profilesRef.current)),
      resumed: true,
    };
    setTabs((prev) => [...prev, next]);
    setActiveId(next.localId);
  }
  const resumeRef = useRef(resumeSession);
  resumeRef.current = resumeSession;

  async function forgetSession(entry: AgentHistoryEntry) {
    setHistory((prev) =>
      prev.filter((e) => e.sessionId !== entry.sessionId),
    );
    await forgetAgentSession(entry.sessionId).catch(() => {});
    void refreshHistory();
  }

  // Run the latest `onLaunch` when the global launch nonce changes.
  // A ref holds the current closure (capturing live `backend`/`command`)
  // so the effect can depend on the nonce alone without re-firing when the
  // backend dropdown changes. `lastLaunchNonce` seeds to the mount-time
  // value so remounting on worktree switch never spuriously launches.
  const onLaunchRef = useRef(onLaunch);
  onLaunchRef.current = onLaunch;
  const lastLaunchNonce = useRef(agentLaunchNonce);
  useEffect(() => {
    if (agentLaunchNonce === lastLaunchNonce.current) return;
    lastLaunchNonce.current = agentLaunchNonce;
    onLaunchRef.current();
  }, [agentLaunchNonce]);

  async function closeTab(localId: string) {
    const agentId = sessionIds.current.get(localId);
    const closing = tabsRef.current.find((t) => t.localId === localId);
    // Look the conversation up before the kill, while it's still live.
    const saved =
      agentId && closing && resumable(closing.backend)
        ? (await refreshHistory())?.find((e) => e.liveAgentId === agentId)
        : undefined;
    // Pool entry is keyed by sessionId once known, falls back to
    // localId for in-flight launches whose onSession hasn't fired.
    const poolKey = agentId ?? localId;
    const state = leafStates.get(poolKey);
    if (state) {
      // disposeAgentLeafState handles killAgent internally — guarded by
      // sessionId so it's a no-op for pre-session entries.
      disposeAgentLeafState(state);
      leafStates.delete(poolKey);
    } else if (agentId) {
      // Defensive: tab existed but never made it into the pool
      // (e.g. slot never rendered). Kill the PTY directly.
      await killAgent(agentId).catch(() => {});
    }
    if (agentId) clearAgentLabel(agentId);
    sessionIds.current.delete(localId);
    setTabs((prev) => {
      const next = prev.filter((t) => t.localId !== localId);
      setActiveId((cur) => {
        if (cur !== localId) return cur;
        return next.length > 0 ? next[next.length - 1].localId : null;
      });
      return next;
    });
    // Sync runs from the `tabs`-watching useEffect after commit.
    if (saved) {
      void refreshHistory();
      if (takeCloseToast()) {
        useToastsStore.getState().push({
          kind: "info",
          title: "Saved to history",
          body: saved.title ?? undefined,
          action: {
            label: "Undo",
            run: () => {
              if (mounted.current)
                resumeRef.current({ ...saved, liveAgentId: null });
            },
          },
        });
      }
    }
  }

  function onTabDragStart(e: React.DragEvent, localId: string) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", localId);
    // Set the ref synchronously so dragover/drop handlers don't have to
    // wait for React to commit the state update (the first dragover
    // event can fire before the rerender, leaving `dragLocalId` null
    // and the browser showing a "no drop here" cursor).
    dragLocalIdRef.current = localId;
    setDragLocalId(localId);
  }

  function onTabDragOver(e: React.DragEvent, overLocalId: string) {
    // Always preventDefault — that's the standard "this element accepts
    // drops" signal. Without it the browser paints the green-plus
    // copy cursor and never fires `drop`.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverLocalId !== overLocalId) setDragOverLocalId(overLocalId);
  }

  function onTabDrop(e: React.DragEvent, targetLocalId: string) {
    e.preventDefault();
    const fromId =
      e.dataTransfer.getData("text/plain") || dragLocalIdRef.current;
    dragLocalIdRef.current = null;
    setDragLocalId(null);
    setDragOverLocalId(null);
    if (!fromId || fromId === targetLocalId) return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.localId === fromId);
      const toIdx = prev.findIndex((t) => t.localId === targetLocalId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      // Drop semantics:
      //   forward  drag (fromIdx < toIdx) → land AFTER target
      //   backward drag (fromIdx > toIdx) → land AT target (push right)
      // Both reduce to `splice(toIdx, 0, moved)` after the
      // forward-removal: in `next`, the target is at toIdx-1, so toIdx
      // is "one past target" (after); for backward, the target is
      // still at toIdx and inserting there pushes it right. The
      // forward branch is what lets a tab reach the rightmost slot —
      // anything strictly less than toIdx leaves the moved tab one
      // short of last.
      next.splice(toIdx, 0, moved);
      return next;
    });
    // Sync runs from the `tabs`-watching useEffect after commit.
  }

  function onTabDragEnd() {
    dragLocalIdRef.current = null;
    setDragLocalId(null);
    setDragOverLocalId(null);
  }

  const hasTabs = tabs.length > 0;

  return (
    <div className="relative flex h-full flex-col border-l border-neutral-800 bg-neutral-950">
      <div className={instanceStrip}>
        {tabs.map((tab) => (
          <div
            key={tab.localId}
            onClick={() => setActiveId(tab.localId)}
            role="tab"
            aria-selected={tab.localId === activeId}
            draggable
            onDragStart={(e) => onTabDragStart(e, tab.localId)}
            onDragOver={(e) => onTabDragOver(e, tab.localId)}
            onDragLeave={() => {
              if (dragOverLocalId === tab.localId) setDragOverLocalId(null);
            }}
            onDrop={(e) => onTabDrop(e, tab.localId)}
            onDragEnd={onTabDragEnd}
            className={cn(
              instanceTab(tab.localId === activeId),
              // Drop-target indicator: blue inset left edge on the tab
              // being hovered, but suppress on the dragged tab itself
              // to avoid confusing self-drop feedback.
              dragOverLocalId === tab.localId &&
                dragLocalId !== tab.localId &&
                "shadow-[inset_2px_0_0_theme(colors.blue.400)]",
              dragLocalId === tab.localId && "opacity-50",
            )}
          >
            <BackendIcon backend={tab.backend} />
            <span className="font-mono">{tab.label}</span>
            {tab.resumed && (
              <span className="text-neutral-500" title="Resumed conversation">
                ↺
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.localId);
              }}
              className={instanceTabClose(tab.localId === activeId)}
              title={
                resumable(tab.backend)
                  ? "Close (resume later from history)"
                  : "Kill agent"
              }
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <div className="sticky right-0 ml-auto flex shrink-0 items-center gap-1 bg-chrome px-1.5">
          <button
            data-agent-history-toggle
            onClick={() => {
              if (!historyOpen) void refreshHistory();
              setHistoryOpen((o) => !o);
            }}
            title="Recent agent sessions in this worktree"
            aria-expanded={historyOpen}
            className={cn(
              "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]",
              historyOpen
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200",
            )}
          >
            <HistoryIcon />
            {history.length > 0 && (
              <span className="tabular-nums">{history.length}</span>
            )}
          </button>
          <div
            data-agent-launch-toggle
            className={cn(
              "flex h-6 items-stretch overflow-hidden rounded-md border",
              launchMenuOpen ? "border-neutral-600" : "border-neutral-800",
            )}
          >
            <button
              onClick={() => onLaunch()}
              title={`Launch ${defaultProfile.name} (⌘⇧A)`}
              className="flex items-center gap-1 px-1.5 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
            >
              <Plus size={13} />
              <BackendIcon backend={defaultProfile.backend} size={11} />
            </button>
            <button
              onClick={() => {
                if (!launchMenuOpen) void refreshProfiles();
                setHistoryOpen(false);
                setLaunchMenuOpen((o) => !o);
              }}
              title="Choose a launch profile"
              aria-expanded={launchMenuOpen}
              className={cn(
                "flex items-center border-l border-neutral-800 px-0.5",
                launchMenuOpen
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200",
              )}
            >
              <ChevronDown size={12} />
            </button>
          </div>
        </div>
      </div>
      {historyOpen && (
        <AgentHistoryMenu
          worktreeName={worktreeName}
          entries={history}
          onResume={resumeSession}
          onForget={forgetSession}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {launchMenuOpen && (
        <AgentLaunchMenu
          profiles={profiles}
          defaultKey={defaultProfile.key}
          workspaceName={workspaceRoot.split("/").pop() || workspaceRoot}
          onLaunch={launch}
          onSaveProfile={saveProfile}
          onDeleteProfile={deleteProfile}
          onClose={() => setLaunchMenuOpen(false)}
        />
      )}

      <div className="relative flex-1">
        {!hasTabs && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 text-xs text-neutral-600">
            {!initLoading && history.length > 0 && (
              <div className="w-96 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-md border border-neutral-800">
                <div className="flex items-baseline justify-between px-2.5 pb-1 pt-1.5 text-[11px]">
                  <span className="font-semibold text-neutral-300">
                    Resume a recent session
                  </span>
                  {history.length > 3 && (
                    <button
                      onClick={() => setHistoryOpen(true)}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      All {history.length} →
                    </button>
                  )}
                </div>
                <AgentHistoryList
                  entries={history.slice(0, 3)}
                  onResume={resumeSession}
                />
              </div>
            )}
            {initLoading
              ? "Checking for running agents…"
              : (
                <span>
                  {history.length > 0 ? "or press " : "Press "}
                  <kbd className="rounded border border-neutral-700 px-1 text-neutral-400">⌘⇧A</kbd>
                  {" to launch "}
                  <span className="text-neutral-400">{defaultProfile.name}</span>
                  {" · "}
                  <button
                    data-agent-launch-toggle
                    onClick={() => {
                      void refreshProfiles();
                      setLaunchMenuOpen(true);
                    }}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    other profiles
                  </button>
                </span>
              )}
          </div>
        )}
        {tabs.map((tab) => {
          // Pool entries are keyed by sessionId once we have one and
          // localId in the meantime. Adoption tabs already arrive in
          // attach mode, so their first slot mount keys by sessionId
          // directly. Launch tabs key by localId, then flip below.
          const poolKey =
            tab.mode.kind === "attach" ? tab.mode.agentId : tab.localId;
          return (
            <div
              key={tab.localId}
              className={cn(
                "absolute inset-0",
                tab.localId !== activeId && "pointer-events-none",
              )}
              style={{
                visibility: tab.localId === activeId ? "visible" : "hidden",
              }}
            >
              <AgentLeafSlot
                worktreeId={worktreeId}
                mode={tab.mode}
                poolKey={poolKey}
                visible={tab.localId === activeId}
                leafStates={leafStates}
                onSession={(id) => {
                  sessionIds.current.set(tab.localId, id);
                  setAgentLabel(id, tab.label);
                  // Re-key the pool entry from localId → sessionId so
                  // the next mount (after a worktree switch and adopt
                  // pass) finds it under `mode.agentId`. Then flip the
                  // tab's mode to attach so this very render's slot
                  // also looks up the stable key going forward.
                  rekeyAgentLeafState(worktreeId, tab.localId, id);
                  setTabs((prev) =>
                    prev.map((t) =>
                      t.localId === tab.localId
                        ? { ...t, mode: { kind: "attach", agentId: id } }
                        : t,
                    ),
                  );
                  // The mirror-to-store effect above only re-runs when
                  // `activeId` changes, not when the session id arrives
                  // — push it directly so other parts of the app
                  // (send-queue, per-comment Send) see the agent
                  // immediately.
                  if (tab.localId === activeId) {
                    setActiveAgent(worktreeId, id);
                  }
                  // A just-launched tab was missing from the persisted
                  // order while its session ID was unknown; now that we
                  // have it, refresh so a worktree round-trip preserves
                  // the new tab's position too. `syncTabOrder` reads
                  // the tabs ref so it sees the current array even when
                  // the surrounding closure is stale.
                  syncTabOrder();
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/// Slot view for one agent tab. The xterm + its host element live in
/// `leafStates` — a module-level pool keyed first by the React tab's
/// `localId` (during in-flight launch) and re-keyed to `AgentSessionId`
/// once `onSession` fires. The slot just attaches the pooled host into
/// its DOM div on mount and detaches on unmount, so worktree switches
/// don't blow away scroll position, scrollback, selection, or search
/// state.
export function AgentLeafSlot({
  worktreeId,
  mode,
  poolKey,
  visible,
  leafStates,
  onSession,
}: {
  worktreeId: WorktreeId;
  mode: AgentLeafMode;
  poolKey: string;
  visible: boolean;
  leafStates: Map<string, AgentLeafState>;
  onSession: (id: AgentSessionId) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Attach this leaf's persistent host element into our slot. On
  // unmount (worktree switch / poolKey re-key after onSession), detach
  // but DON'T dispose — the state stays in the pool and the next mount
  // for the same key will reattach it intact.
  //
  // Deps are scoped to poolKey on purpose: the effect must run exactly
  // once per slot lifetime (per pool identity), not on every parent re-
  // render. Including the mode object or the freshly-bound `onSession`
  // in deps would re-run the effect on every ancestor render, briefly
  // detaching the xterm host from the DOM during cleanup → reattach.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    let state = leafStates.get(poolKey);
    if (!state) {
      state = createAgentLeafState(worktreeId, mode, onSession);
      leafStates.set(poolKey, state);
    }
    slot.appendChild(state.host);
    setError(state.error);
    state.errorListeners.add(setError);
    try {
      state.fit.fit();
    } catch {}
    return () => {
      state.errorListeners.delete(setError);
      if (state.host.parentNode === slot) {
        slot.removeChild(state.host);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey]);

  useEffect(() => {
    if (!visible) return;
    const state = leafStates.get(poolKey);
    if (!state) return;
    try {
      fitAndPin(state.fit, state.term);
    } catch {}
    state.term.focus();
  }, [visible, poolKey, leafStates]);

  return (
    <div className="flex h-full w-full flex-col">
      {error && (
        <div className="m-3 shrink-0 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      {/* Wrap xterm's host in a `relative flex-1` box so the host itself
          can stay `absolute inset-0`. Xterm's fit()'s internal DOM resizes
          have to NOT influence this container, or its ResizeObserver loops
          infinitely — `absolute` decouples child size from parent layout. */}
      <div className="relative flex-1">
        <div ref={slotRef} className="absolute inset-0 overflow-hidden" />
      </div>
    </div>
  );
}
