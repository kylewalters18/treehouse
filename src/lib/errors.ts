/// Turn whatever Tauri/JS threw at us into a user-readable string.
///
/// Tauri command errors from Rust arrive as serialized `AppError` objects of
/// shape `{ kind, message }`. Plain `String(e)` renders those as
/// "[object Object]" — this helper digs out the `message` field first and
/// falls back to `toString()` for anything else.
export function asMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; toString?: () => string };
    if (typeof o.message === "string") return o.message;
  }
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
