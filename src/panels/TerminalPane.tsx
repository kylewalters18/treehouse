import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import "xterm/css/xterm.css";

import { useUiStore } from "@/stores/ui";
import {
  openTerminal,
  ptyWrite,
  ptyResize,
  closeTerminal,
} from "@/ipc/client";
import type { TerminalId, WorktreeId } from "@/ipc/types";

export function TerminalPane() {
  const worktreeId = useUiStore((s) => s.selectedWorktreeId);

  if (!worktreeId) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-neutral-600">
        Select a worktree to open a terminal
      </div>
    );
  }

  return <TerminalInstance key={worktreeId} worktreeId={worktreeId} />;
}

function TerminalInstance({ worktreeId }: { worktreeId: WorktreeId }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef<TerminalId | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const encoder = new TextEncoder();

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
      },
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    fitRef.current = fit;

    term.open(host);
    fit.fit();

    (async () => {
      try {
        const session = await openTerminal(
          worktreeId,
          term.cols,
          term.rows,
          (ev) => {
            if (disposed) return;
            if (ev.kind === "data") {
              term.write(new Uint8Array(ev.bytes));
            } else if (ev.kind === "exit") {
              term.write(
                `\r\n\x1b[38;2;115;115;115m[process exited${
                  ev.code !== null ? ` — code ${ev.code}` : ""
                }]\x1b[0m\r\n`,
              );
            }
          },
        );
        if (disposed) {
          await closeTerminal(session.id);
          return;
        }
        terminalIdRef.current = session.id;

        term.onData((data) => {
          const id = terminalIdRef.current;
          if (!id) return;
          ptyWrite(id, encoder.encode(data)).catch((e) =>
            console.error("pty_write failed", e),
          );
        });

        term.onResize(({ cols, rows }) => {
          const id = terminalIdRef.current;
          if (!id) return;
          ptyResize(id, cols, rows).catch(() => {});
        });

        resizeObserver = new ResizeObserver(() => {
          try {
            fit.fit();
          } catch {
            // dom not laid out yet
          }
        });
        resizeObserver.observe(host);
      } catch (e) {
        term.write(`\r\nerror: failed to open terminal — ${e}\r\n`);
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      const id = terminalIdRef.current;
      if (id) {
        closeTerminal(id).catch(() => {});
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      terminalIdRef.current = null;
    };
  }, [worktreeId]);

  return (
    <div className="relative h-full w-full bg-neutral-950">
      <div ref={hostRef} className="absolute inset-0 p-2" />
    </div>
  );
}
