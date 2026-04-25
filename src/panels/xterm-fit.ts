import type { Terminal } from "xterm";
import type { FitAddon } from "xterm-addon-fit";

/// fit() reflows the buffer and on a terminal with scrollback can leave
/// the viewport stranded near the top. Capture whether the user was
/// already pinned to the bottom and restore that after the reflow so
/// active panes stay glued to the latest output without yanking users
/// who have scrolled up to read history.
export function fitAndPin(fit: FitAddon, term: Terminal) {
  try {
    const buf = term.buffer.active;
    const wasAtBottom = buf.viewportY === buf.baseY;
    fit.fit();
    if (wasAtBottom) term.scrollToBottom();
  } catch {}
}
