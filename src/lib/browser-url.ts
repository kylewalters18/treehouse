/// URL helpers for the bottom-pane Browser tab.

/// Address-bar input → URL. A bare port means localhost; a missing
/// scheme means http. Anything that isn't http(s) is rejected (null).
export function normalizeBrowserUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^\d{1,5}$/.test(s)) return `http://localhost:${s}/`;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Dev servers bound to all interfaces print 0.0.0.0, which isn't a
    // navigable address in WebKit.
    if (u.hostname === "0.0.0.0") u.hostname = "localhost";
    return u.toString();
  } catch {
    return null;
  }
}

/// True for URLs served from this machine — the ones the Browser tab
/// is for. Terminal ⌘-clicks on these open in-app instead of externally.
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
