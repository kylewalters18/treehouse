import { create } from "zustand";

export type ToastKind = "info" | "success" | "error";

export type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
};

type ToastsState = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: string) => void;
};

export const useToastsStore = create<ToastsState>((set, get) => ({
  toasts: [],
  push(t) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set({ toasts: [...get().toasts, { id, ...t }] });
    setTimeout(() => get().dismiss(id), 6000);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function toastError(title: string, body?: string) {
  useToastsStore.getState().push({ kind: "error", title, body });
}
export function toastInfo(title: string, body?: string) {
  useToastsStore.getState().push({ kind: "info", title, body });
}
export function toastSuccess(title: string, body?: string) {
  useToastsStore.getState().push({ kind: "success", title, body });
}
