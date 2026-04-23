/// Global Vitest setup.
///
/// - Loads jest-dom matchers (toBeInTheDocument, toHaveTextContent, …).
/// - Provides stub implementations for the Tauri APIs the app imports at
///   module load time, so any code path that hits the IPC layer in tests
///   gets a predictable failure instead of an unhandled "not in Tauri"
///   error. Tests that exercise IPC should mock `@/ipc/client` directly.
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke called without a test-level mock");
  }),
  Channel: class {
    onmessage: ((data: unknown) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));
