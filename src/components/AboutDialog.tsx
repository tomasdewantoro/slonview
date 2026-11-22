// About Slonview: the app version and the manual update check (the only request that goes
// anywhere other than the user's PostgreSQL servers, and only when the button is clicked).
import { CircleAlert, CircleCheck, Info, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import type { UpdateStatus } from "../bindings/UpdateStatus";
import { Dialog } from "./Dialog";

type Check = { kind: "idle" } | { kind: "checking" } | { kind: "done"; status: UpdateStatus } | { kind: "error"; message: string };

export function AboutButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex shrink-0 justify-end border-t border-border px-1.5 py-1">
      <button className="icon-btn" aria-label="About Slonview" title="About Slonview" onClick={() => setOpen(true)}>
        <Info size={14} />
      </button>
      {open && <AboutDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>({ kind: "idle" });

  useEffect(() => {
    api.appVersion().then(setVersion, () => setVersion(null));
  }, []);

  const runCheck = async () => {
    setCheck({ kind: "checking" });
    try {
      setCheck({ kind: "done", status: await api.checkForUpdates() });
    } catch (e) {
      setCheck({ kind: "error", message: errorMessage(e) });
    }
  };

  const openRelease = async (url: string) => {
    try {
      await api.openUrl(url);
    } catch (e) {
      setCheck({ kind: "error", message: errorMessage(e) });
    }
  };

  const available = check.kind === "done" && check.status.kind === "available" ? check.status : null;

  return (
    <Dialog
      title="About Slonview"
      onClose={onClose}
      width="w-[400px]"
      footer={
        <button className="btn" onClick={onClose} autoFocus>
          Close
        </button>
      }
    >
      <p className="text-[15px] font-semibold">
        Slonview <span className="font-mono font-normal text-muted" data-testid="app-version">{version ?? ""}</span>
      </p>
      <p className="mt-1 text-pretty text-muted">A read-only-by-default viewer for PostgreSQL®. MIT OR Apache-2.0.</p>
      <div className="mt-4 flex min-h-7 items-center gap-3">
        <button className="btn" onClick={() => void runCheck()} disabled={check.kind === "checking"}>
          {check.kind === "checking" && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />}
          Check for updates
        </button>
        <div aria-live="polite" data-testid="update-status" className="min-w-0 text-pretty">
          {check.kind === "checking" && <span className="text-muted">Checking…</span>}
          {check.kind === "done" && check.status.kind === "upToDate" && (
            <span className="flex items-center gap-1.5 text-ok">
              <CircleCheck size={14} aria-hidden /> Slonview is up to date.
            </span>
          )}
          {check.kind === "error" && (
            <span className="flex items-start gap-1.5 text-error">
              <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden /> {check.message}
            </span>
          )}
        </div>
      </div>
      {available && (
        <div className="mt-3 flex items-center gap-3 rounded border border-border bg-surface p-2.5">
          <p className="min-w-0 flex-1 text-pretty">
            Slonview <span className="font-mono">{available.latest}</span> is available. You have <span className="font-mono">{available.current}</span>.
          </p>
          <button className="btn btn-primary" onClick={() => void openRelease(available.url)}>
            Open release page
          </button>
        </div>
      )}
      <p className="mt-4 text-xs text-pretty text-muted">
        The check runs only when you click it. It asks api.github.com for the latest release; nothing about you or your databases is sent.
      </p>
    </Dialog>
  );
}
