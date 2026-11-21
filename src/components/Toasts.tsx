import { TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { appStore, useApp, type Toast } from "../store/app";

const TTL_MS = 8000;

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    const t = setTimeout(() => appStore.getState().dismissToast(toast.id), TTL_MS);
    return () => clearTimeout(t);
  }, [toast.id]);
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className="flex w-[360px] items-start gap-2 rounded-md border border-border bg-raised p-2.5 shadow-lg"
    >
      {toast.kind === "error" && <TriangleAlert size={15} className="mt-0.5 shrink-0 text-error" aria-hidden />}
      <p className="min-w-0 flex-1 text-xs break-words text-pretty">{toast.message}</p>
      <button className="icon-btn size-5" aria-label="Dismiss" onClick={() => appStore.getState().dismissToast(toast.id)}>
        <X size={12} />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed right-3 bottom-9 z-40 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
