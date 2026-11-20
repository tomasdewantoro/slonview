// CodeMirror 6 SQL editor used by SqlTab. Owns the EditorView; SqlTab drives it via `viewRef`.
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import type { SchemaNode } from "../../bindings/SchemaNode";
import { completionNamespace } from "../../lib/sqlResult";

export type RunMode = "cursor" | "all";

const setErrorMark = StateEffect.define<{ from: number; to: number } | null>();
const errorMark = Decoration.mark({ class: "cm-sql-error" });

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorMark)) {
        return effect.value ? Decoration.set([errorMark.range(effect.value.from, effect.value.to)]) : Decoration.none;
      }
    }
    return tr.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Underlines `from..to` (cleared on the next edit), moves the cursor there and scrolls to it. */
export function markSqlError(view: EditorView, from: number, to: number) {
  view.dispatch({
    effects: [setErrorMark.of({ from, to }), EditorView.scrollIntoView(from, { y: "center" })],
    selection: { anchor: from },
  });
  view.focus();
}

export function clearSqlError(view: EditorView) {
  view.dispatch({ effects: setErrorMark.of(null) });
}

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.5" },
  ".cm-gutters": { borderRight: "none" },
  ".cm-sql-error": {
    textDecoration: "underline wavy #ef4444",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
    backgroundColor: "rgba(239, 68, 68, 0.12)",
  },
});

const darkQuery = "(prefers-color-scheme: dark)";
function subscribeDark(onChange: () => void) {
  const mql = window.matchMedia(darkQuery);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const languageFor = (schema: SchemaNode[]) =>
  sql({ dialect: PostgreSQL, schema: completionNamespace(schema), defaultSchema: "public", upperCaseKeywords: true });

interface SqlEditorProps {
  viewRef: RefObject<EditorView | null>;
  /** localStorage key; the document is restored from it and saved to it on change. */
  storageKey: string;
  initialSql: string;
  schema: SchemaNode[];
  onRun: (mode: RunMode) => void;
  /** Return true when a running query was cancelled (consumes Esc). */
  onCancel: () => boolean;
}

export function SqlEditor({ viewRef, storageKey, initialSql, schema, onRun, onCancel }: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onRun, onCancel });
  handlers.current = { onRun, onCancel };
  const language = useRef(new Compartment());
  const theme = useRef(new Compartment());
  const dark = useSyncExternalStore(subscribeDark, () => window.matchMedia(darkQuery).matches);
  const initial = useRef({ initialSql, schema, dark });

  useEffect(() => {
    let saveTimer: number | undefined;
    const save = () => {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
      if (viewRef.current) localStorage.setItem(storageKey, viewRef.current.state.doc.toString());
    };
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: localStorage.getItem(storageKey) ?? initial.current.initialSql,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (handlers.current.onRun("cursor"), true) },
              { key: "Shift-Mod-Enter", run: () => (handlers.current.onRun("all"), true) },
              { key: "Escape", run: () => handlers.current.onCancel() },
            ]),
          ),
          basicSetup,
          language.current.of(languageFor(initial.current.schema)),
          theme.current.of(initial.current.dark ? oneDark : []),
          baseTheme,
          errorField,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            window.clearTimeout(saveTimer);
            saveTimer = window.setTimeout(save, 300);
          }),
        ],
      }),
    });
    viewRef.current = view;
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      if (saveTimer !== undefined) save();
      view.destroy();
      viewRef.current = null;
    };
  }, [storageKey, viewRef]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: language.current.reconfigure(languageFor(schema)) });
  }, [schema, viewRef]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : []) });
  }, [dark, viewRef]);

  return <div ref={hostRef} className="h-full min-h-0 bg-white dark:bg-[#282c34]" />;
}
