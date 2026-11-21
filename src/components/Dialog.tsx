import { useEffect, useRef, type ReactNode } from "react";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  width?: string;
  role?: "dialog" | "alertdialog";
}

/** Native <dialog> as a modal: focus trapping, Escape and top-layer stacking come from the browser. */
export function Dialog({ title, onClose, children, footer, width = "w-[520px]", role = "dialog" }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`${width} m-auto max-h-[85dvh] overflow-hidden rounded-[var(--sv-radius-dialog)] border border-border bg-raised p-0 text-ink shadow-xl backdrop:bg-scrim`}
    >
      <div className="flex max-h-[85dvh] flex-col">
        <h2 className="border-b border-border px-4 py-2.5 text-[15px] font-semibold">{title}</h2>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>
      </div>
    </dialog>
  );
}

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      width="w-[380px]"
      role="alertdialog"
      footer={
        <>
          <button className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-pretty">{message}</p>
    </Dialog>
  );
}
