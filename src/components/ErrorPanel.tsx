import { TriangleAlert } from "lucide-react";
import { errorMessage, isAppError } from "../api";

const KIND_LABEL: Record<string, string> = {
  connect: "Connection error",
  auth: "Authentication failed",
  sql: "Query failed",
  cancelled: "Cancelled",
  timeout: "Timed out",
  notConnected: "Not connected",
  invalid: "Invalid input",
  internal: "Internal error",
};

/** Inline AppError: title by kind, Postgres message/detail/hint, SQLSTATE and position when present. */
export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const title = isAppError(error) ? (KIND_LABEL[error.kind] ?? "Error") : "Error";
  const sql = isAppError(error) && error.kind === "sql" ? error : null;
  return (
    <div role="alert" className="m-3 flex gap-2.5 rounded-md border border-error bg-error-soft p-3 text-ink">
      <TriangleAlert size={16} className="mt-0.5 shrink-0 text-error" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-error">{title}</span>
          {sql && <span className="font-mono text-xs text-muted">SQLSTATE {sql.code}</span>}
          {sql?.position != null && <span className="font-mono text-xs text-muted">at position {sql.position}</span>}
        </div>
        <pre className="mt-1 font-mono text-xs break-words whitespace-pre-wrap">{errorMessage(error)}</pre>
        {onRetry && (
          <button className="btn mt-2" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
