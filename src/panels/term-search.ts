import type { Terminal } from "xterm";
import { SearchAddon } from "xterm-addon-search";

/// Imperative search overlay for an xterm terminal — Cmd+F (or
/// Ctrl+F on non-mac) opens a small bar pinned to the top-right of
/// the term's host element. Enter / Shift+Enter walk through hits;
/// Esc closes. Match decorations come from xterm's built-in search
/// addon styling (border + highlighted background on the matched
/// cells); we override the colors below to match the rest of the
/// editor's palette rather than the addon's defaults.
///
/// Implementation note: every other piece of the terminal lifecycle
/// is imperative (xterm host appended to a DOM slot, fit/dispose
/// owned in a `LeafState`), so the search UI follows suit — a vanilla
/// element added next to the term, and `tryHandleKey` returned for
/// the calling code to chain into its existing
/// `attachCustomKeyEventHandler`. This avoids React reconciling
/// children of the slot div while xterm has appended its host into
/// it directly.

export type TerminalSearch = {
  dispose: () => void;
  /// Call from your existing `attachCustomKeyEventHandler`. Returns
  /// `true` if the event was consumed (the caller should then return
  /// `false` from the xterm handler to stop propagation).
  tryHandleKey: (ev: KeyboardEvent) => boolean;
};

const MATCH_DECORATIONS = {
  matchBackground: "#27678299",
  matchBorder: "#3994BC",
  matchOverviewRuler: "#3994BC",
  activeMatchBackground: "#3994BCcc",
  activeMatchBorder: "#BBBEBF",
  activeMatchColorOverviewRuler: "#BBBEBF",
} as const;

const SEARCH_OPTS = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  decorations: MATCH_DECORATIONS,
} as const;

export function attachTerminalSearch(
  term: Terminal,
  host: HTMLElement,
): TerminalSearch {
  const addon = new SearchAddon();
  term.loadAddon(addon);

  // Container floats over the terminal's content area. Pointer
  // events default to none on the wrapper so a click outside the
  // bar still hits xterm; the bar itself re-enables them.
  const wrapper = document.createElement("div");
  wrapper.style.position = "absolute";
  wrapper.style.top = "8px";
  wrapper.style.right = "12px";
  wrapper.style.zIndex = "10";
  wrapper.style.display = "none";
  wrapper.style.alignItems = "center";
  wrapper.style.gap = "6px";
  wrapper.style.padding = "4px 6px";
  wrapper.style.background = "#1A1B1Cf2";
  wrapper.style.border = "1px solid #2A2B2C";
  wrapper.style.borderRadius = "6px";
  wrapper.style.fontSize = "11px";
  wrapper.style.color = "#BBBEBF";
  wrapper.style.fontFamily =
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
  wrapper.style.boxShadow = "0 4px 12px rgba(0,0,0,0.35)";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Find";
  input.spellcheck = false;
  input.style.background = "#0E0F10";
  input.style.color = "#BBBEBF";
  input.style.border = "1px solid #2A2B2C";
  input.style.borderRadius = "3px";
  input.style.padding = "3px 6px";
  input.style.fontSize = "11px";
  input.style.fontFamily = "inherit";
  input.style.minWidth = "180px";
  input.style.outline = "none";

  const prevBtn = makeButton("‹", "Previous match (⇧⏎)");
  const nextBtn = makeButton("›", "Next match (⏎)");
  const closeBtn = makeButton("✕", "Close (Esc)");

  wrapper.appendChild(input);
  wrapper.appendChild(prevBtn);
  wrapper.appendChild(nextBtn);
  wrapper.appendChild(closeBtn);
  // Host needs to be a positioning context so absolute children land
  // inside its bounds. Read computed style and patch only if needed.
  if (getComputedStyle(host).position === "static") {
    host.style.position = "relative";
  }
  host.appendChild(wrapper);

  let open = false;
  function show() {
    if (open) return;
    open = true;
    wrapper.style.display = "flex";
    input.value = lastQuery;
    input.focus();
    input.select();
  }
  function hide() {
    if (!open) return;
    open = false;
    wrapper.style.display = "none";
    addon.clearDecorations();
    term.focus();
  }
  let lastQuery = "";
  function findNext() {
    const q = input.value;
    lastQuery = q;
    if (!q) return;
    addon.findNext(q, SEARCH_OPTS);
  }
  function findPrev() {
    const q = input.value;
    lastQuery = q;
    if (!q) return;
    addon.findPrevious(q, SEARCH_OPTS);
  }

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      hide();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (ev.shiftKey) findPrev();
      else findNext();
    }
  });
  input.addEventListener("input", () => {
    // Live-update as the user types so the first match jumps into
    // view without an explicit Enter. Skips on empty input so we
    // don't paint a phantom decoration on every cell.
    if (!input.value) {
      addon.clearDecorations();
      return;
    }
    addon.findNext(input.value, SEARCH_OPTS);
  });
  prevBtn.addEventListener("click", findPrev);
  nextBtn.addEventListener("click", findNext);
  closeBtn.addEventListener("click", hide);

  function tryHandleKey(ev: KeyboardEvent): boolean {
    if (ev.type !== "keydown") return false;
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && (ev.key === "f" || ev.key === "F")) {
      ev.preventDefault();
      show();
      return true;
    }
    return false;
  }

  return {
    dispose() {
      addon.dispose();
      if (wrapper.parentElement === host) host.removeChild(wrapper);
    },
    tryHandleKey,
  };
}

function makeButton(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.style.background = "transparent";
  b.style.color = "#BBBEBF";
  b.style.border = "1px solid transparent";
  b.style.borderRadius = "3px";
  b.style.padding = "1px 6px";
  b.style.fontSize = "13px";
  b.style.lineHeight = "1";
  b.style.cursor = "pointer";
  b.addEventListener("mouseenter", () => {
    b.style.background = "#2A2B2C";
  });
  b.addEventListener("mouseleave", () => {
    b.style.background = "transparent";
  });
  return b;
}
