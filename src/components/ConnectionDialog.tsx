import { Check, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import type { ConnProfile } from "../bindings/ConnProfile";
import type { ParsedConn } from "../bindings/ParsedConn";
import type { ServerInfo } from "../bindings/ServerInfo";
import type { SslMode } from "../bindings/SslMode";
import { appStore } from "../store/app";
import { Dialog } from "./Dialog";

export const PROFILE_COLORS = ["#3b82f6", "#22a06b", "#e5484d", "#f59e0b", "#8e4ec6", "#0ea5a4", "#6b7280"];

/** Mirrors `config::new_profile()` defaults. */
export function newProfile(): ConnProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    host: "localhost",
    port: 5432,
    database: "postgres",
    user: "",
    ssl: "prefer",
    readOnly: true,
    color: null,
    statementTimeoutMs: 30000,
  };
}

interface Props {
  /** null = create a new profile. */
  existing: ConnProfile | null;
  onClose: () => void;
}

type TestState = { kind: "idle" } | { kind: "running" } | { kind: "ok"; info: ServerInfo } | { kind: "error"; message: string };

export function ConnectionDialog({ existing, onClose }: Props) {
  const [p, setP] = useState<ConnProfile>(() => existing ?? newProfile());
  const [password, setPassword] = useState("");
  // Editing: an untouched password field means "keep the stored password".
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [pgpass, setPgpass] = useState<ParsedConn[] | null>(null);
  const [pgpassError, setPgpassError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const update = (patch: Partial<ConnProfile>) => {
    setP((cur) => ({ ...cur, ...patch }));
    setTest({ kind: "idle" });
  };

  const applyParsed = (parsed: ParsedConn) => {
    // Keep identity (id, color, read-only choice) of the profile being edited; take the connection fields.
    const { host, port, database, user, ssl } = parsed.profile;
    setP((cur) => ({ ...cur, host, port, database, user, ssl, name: cur.name || parsed.profile.name }));
    setPassword(parsed.password ?? "");
    setPasswordTouched(true);
    setTest({ kind: "idle" });
  };

  const parseUrl = async () => {
    if (!url.trim()) return;
    try {
      applyParsed(await api.parseConnUrl(url.trim()));
      setUrlError(null);
      setUrl("");
    } catch (e) {
      setUrlError(errorMessage(e));
    }
  };

  const loadPgpass = async () => {
    try {
      setPgpass(await api.importPgpass());
      setPgpassError(null);
    } catch (e) {
      setPgpassError(errorMessage(e));
    }
  };

  const passwordArg = (): string | null | undefined => {
    if (existing && !passwordTouched) return undefined;
    return password === "" ? null : password;
  };

  const runTest = async () => {
    setTest({ kind: "running" });
    try {
      const info = await api.testConnection(finalProfile(), passwordArg() ?? null);
      setTest({ kind: "ok", info });
    } catch (e) {
      setTest({ kind: "error", message: errorMessage(e) });
    }
  };

  const finalProfile = (): ConnProfile => ({
    ...p,
    name: p.name.trim() || `${p.database}@${p.host}`,
    host: p.host.trim(),
    database: p.database.trim(),
    user: p.user.trim(),
  });

  const valid = p.host.trim() !== "" && p.database.trim() !== "" && p.user.trim() !== "" && p.port > 0 && p.port < 65536;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await appStore.getState().saveProfile(finalProfile(), passwordArg());
      onClose();
    } catch (e) {
      setSaveError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={existing ? `Edit ${existing.name}` : "New connection"}
      onClose={onClose}
      width="w-[600px]"
      footer={
        <>
          <div className="mr-auto min-w-0 flex-1 truncate text-xs" aria-live="polite">
            {test.kind === "running" && <span className="text-muted">Connecting…</span>}
            {test.kind === "ok" && (
              <span className="flex items-center gap-1 text-ok" title={test.info.version}>
                <Check size={13} aria-hidden /> {test.info.version.split(" on ")[0]}
              </span>
            )}
            {test.kind === "error" && (
              <span className="text-danger" title={test.message}>
                {test.message}
              </span>
            )}
            {saveError && <span className="text-danger">{saveError}</span>}
          </div>
          <button className="btn" onClick={runTest} disabled={!valid || test.kind === "running"}>
            {test.kind === "running" && <LoaderCircle size={13} className="animate-spin" aria-hidden />}
            Test
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!valid || saving}>
            Save
          </button>
        </>
      }
    >
      <form
        className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save();
        }}
      >
        <label htmlFor="cd-url" className="text-muted">
          Paste URL
        </label>
        <div>
          <div className="flex gap-2">
            <input
              id="cd-url"
              className="field flex-1 font-mono text-xs"
              placeholder="postgres://user:password@host:5432/db?sslmode=require"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void parseUrl();
                }
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text");
                if (/^postgres(ql)?:\/\//.test(text.trim())) {
                  e.preventDefault();
                  setUrl(text);
                  void api
                    .parseConnUrl(text.trim())
                    .then((parsed) => {
                      applyParsed(parsed);
                      setUrl("");
                      setUrlError(null);
                    })
                    .catch((err) => setUrlError(errorMessage(err)));
                }
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" className="btn" onClick={parseUrl} disabled={!url.trim()}>
              Fill
            </button>
            <button type="button" className="btn" onClick={loadPgpass}>
              Import ~/.pgpass
            </button>
          </div>
          {urlError && <p className="mt-1 text-xs text-danger">{urlError}</p>}
          {pgpassError && <p className="mt-1 text-xs text-danger">{pgpassError}</p>}
        </div>

        {pgpass && (
          <>
            <span />
            <div className="rounded-md border border-line">
              <div className="flex items-center justify-between border-b border-line px-2 py-1 text-xs text-muted">
                <span>{pgpass.length === 0 ? "No concrete entries in ~/.pgpass" : "Pick an entry to fill the form"}</span>
                <button type="button" className="text-xs text-accent" onClick={() => setPgpass(null)}>
                  Close
                </button>
              </div>
              <ul className="max-h-32 overflow-auto py-0.5">
                {pgpass.map((entry, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="w-full truncate px-2 py-1 text-left font-mono text-xs hover:bg-hover"
                      onClick={() => {
                        applyParsed(entry);
                        setPgpass(null);
                      }}
                    >
                      {entry.profile.user}@{entry.profile.host}:{entry.profile.port}/{entry.profile.database}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        <div className="col-span-2 my-1 h-px bg-line" />

        <label htmlFor="cd-name" className="text-muted">
          Name
        </label>
        <input
          id="cd-name"
          className="field"
          value={p.name}
          placeholder={`${p.database || "db"}@${p.host || "host"}`}
          onChange={(e) => update({ name: e.target.value })}
          autoFocus
        />

        <label htmlFor="cd-host" className="text-muted">
          Host
        </label>
        <div className="flex gap-2">
          <input
            id="cd-host"
            className="field flex-1 font-mono text-xs"
            value={p.host}
            onChange={(e) => update({ host: e.target.value })}
            spellCheck={false}
          />
          <label htmlFor="cd-port" className="sr-only">
            Port
          </label>
          <input
            id="cd-port"
            className="field w-20 font-mono text-xs tabular-nums"
            inputMode="numeric"
            value={p.port || ""}
            onChange={(e) => update({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
          />
        </div>

        <label htmlFor="cd-db" className="text-muted">
          Database
        </label>
        <input
          id="cd-db"
          className="field font-mono text-xs"
          value={p.database}
          onChange={(e) => update({ database: e.target.value })}
          spellCheck={false}
        />

        <label htmlFor="cd-user" className="text-muted">
          User
        </label>
        <input
          id="cd-user"
          className="field font-mono text-xs"
          value={p.user}
          onChange={(e) => update({ user: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />

        <label htmlFor="cd-pw" className="text-muted">
          Password
        </label>
        <div className="flex gap-2">
          <input
            id="cd-pw"
            className="field flex-1 font-mono text-xs"
            type={showPassword ? "text" : "password"}
            value={password}
            placeholder={existing && !passwordTouched ? "Stored in Keychain (unchanged)" : "None"}
            onChange={(e) => {
              setPassword(e.target.value);
              setPasswordTouched(true);
              setTest({ kind: "idle" });
            }}
            autoComplete="off"
          />
          <button
            type="button"
            className="icon-btn size-[26px]"
            aria-label={showPassword ? "Hide password" : "Show password"}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>

        <label htmlFor="cd-ssl" className="text-muted">
          SSL
        </label>
        <select id="cd-ssl" className="field w-32" value={p.ssl} onChange={(e) => update({ ssl: e.target.value as SslMode })}>
          <option value="disable">disable</option>
          <option value="prefer">prefer</option>
          <option value="require">require</option>
        </select>

        <label htmlFor="cd-timeout" className="text-muted">
          Timeout
        </label>
        <div className="flex items-center gap-2">
          <input
            id="cd-timeout"
            className="field w-24 font-mono text-xs tabular-nums"
            inputMode="numeric"
            value={String(p.statementTimeoutMs / 1000)}
            onChange={(e) => update({ statementTimeoutMs: (Number(e.target.value.replace(/[^\d]/g, "")) || 0) * 1000 })}
          />
          <span className="text-xs text-muted">seconds per statement, 0 = no limit</span>
        </div>

        <span className="text-muted">Access</span>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!p.readOnly} onChange={(e) => update({ readOnly: !e.target.checked })} />
          <span>Allow writes</span>
          <span className="text-xs text-muted">{p.readOnly ? "sessions are read-only" : "INSERT/UPDATE/DELETE allowed"}</span>
        </label>

        <span className="text-muted">Color</span>
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Color">
          <button
            type="button"
            role="radio"
            aria-checked={p.color === null}
            aria-label="No color"
            onClick={() => update({ color: null })}
            className={`size-5 rounded-full border-2 border-dashed border-faint ${p.color === null ? "ring-2 ring-accent ring-offset-1 ring-offset-raised" : ""}`}
          />
          {PROFILE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={p.color === c}
              aria-label={`Color ${c}`}
              onClick={() => update({ color: c })}
              className={`size-5 rounded-full ${p.color === c ? "ring-2 ring-accent ring-offset-1 ring-offset-raised" : ""}`}
              style={{ background: c }}
            />
          ))}
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
