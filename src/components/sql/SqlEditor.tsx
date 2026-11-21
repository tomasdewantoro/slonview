// CodeMirror 6 SQL editor used by SqlTab. Owns the EditorView; SqlTab drives it via `viewRef`.
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { SchemaNode } from "../../bindings/SchemaNode";
import { completionNamespace } from "../../lib/sqlResult";
import { columnCompletion, type ColumnIndex } from "../../lib/sqlColumns";
import { statementAt } from "../../lib/sqlSplit";

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

// Brand editor theme (brand guidelines §11.2). Every colour is a CSS token from src/styles/tokens.css,
// so light and dark follow prefers-color-scheme without rebuilding the theme.
const brandTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--sv-editor-bg)", color: "var(--sv-editor-fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--sv-font-mono)",
    lineHeight: "1.5",
    fontVariantLigatures: "none",
    fontFeatureSettings: '"calt" 0, "zero" 1',
  },
  ".cm-content": { caretColor: "var(--sv-editor-cursor)" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--sv-editor-cursor)" },
  ".cm-gutters": { backgroundColor: "var(--sv-editor-gutter-bg)", color: "var(--sv-editor-gutter-fg)", borderRight: "none" },
  ".cm-activeLineGutter": { backgroundColor: "var(--sv-editor-active-line)", color: "var(--sv-editor-gutter-active-fg)" },
  ".cm-activeLine": { backgroundColor: "var(--sv-editor-active-line)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--sv-editor-selection)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--sv-accent-soft)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--sv-accent-soft)", outline: "1px solid var(--sv-border-strong)" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--sv-error-soft)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--sv-surface-2)", border: "none", color: "var(--sv-muted)" },
  ".cm-tooltip": { backgroundColor: "var(--sv-raised)", color: "var(--sv-ink)", border: "1px solid var(--sv-border)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--sv-accent)", color: "var(--sv-accent-fg)" },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail": { color: "var(--sv-accent-fg-muted)" },
  ".cm-completionDetail": { color: "var(--sv-muted)" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
  ".cm-panels": { backgroundColor: "var(--sv-surface)", color: "var(--sv-ink)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--sv-border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--sv-border)" },
  ".cm-searchMatch": { backgroundColor: "var(--sv-warn-soft)", outline: "1px solid var(--sv-warn)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--sv-selection)" },
  ".cm-sql-error": {
    textDecoration: "underline wavy var(--sv-editor-error-underline)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
    backgroundColor: "var(--sv-editor-error-bg)",
  },
});

// Replaces basicSetup's fallback highlight style; untagged text keeps editor-fg.
const brandHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--sv-syntax-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--sv-syntax-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--sv-syntax-number)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--sv-syntax-comment)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.paren, t.squareBracket, t.brace, t.separator], color: "var(--sv-syntax-operator)" },
]);

const darkQuery = "(prefers-color-scheme: dark)";
function subscribeDark(onChange: () => void) {
  const mql = window.matchMedia(darkQuery);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const languageFor = (schema: SchemaNode[]) =>
  sql({ dialect: PostgreSQL, schema: completionNamespace(schema), defaultSchema: "public", upperCaseKeywords: true });

const PLAIN_IDENT = /^[a-z_][a-z_\d$]*$/;

/**
 * Column names for the tables the statement at the cursor references. Runs alongside lang-sql's
 * schema/table/keyword sources; `columns` is read at completion time so a reload needs no reconfigure.
 */
function columnSource(columns: RefObject<ColumnIndex>) {
  return (context: CompletionContext): CompletionResult | null => {
    const doc = context.state.doc.toString();
    const stmt = statementAt(doc, context.pos);
    if (!stmt || context.pos < stmt.start || context.pos > stmt.end) return null;
    const found = columnCompletion(columns.current, stmt.text, context.pos - stmt.start);
    if (!found) return null;
    const options: Completion[] = found.columns.map((c) => ({
      label: c.name,
      type: "property",
      detail: found.qualified ? c.typeName : `${c.table} · ${c.typeName}`,
      apply: PLAIN_IDENT.test(c.name) ? undefined : `"${c.name.replace(/"/g, '""')}"`,
      // Columns of the tables in the statement rank above keywords and table names.
      boost: 2,
    }));
    return { from: stmt.start + found.from, options, validFor: /^[\p{L}\p{N}_$]*$/u };
  };
}

interface SqlEditorProps {
  viewRef: RefObject<EditorView | null>;
  /** localStorage key; the document is restored from it and saved to it on change. */
  storageKey: string;
  initialSql: string;
  schema: SchemaNode[];
  /** Catalog columns for column autocomplete. */
  columns: ColumnIndex;
  onRun: (mode: RunMode) => void;
  /** ⌘E: explain the selection or the statement at the cursor. */
  onExplain: () => void;
  /** Return true when a running query was cancelled (consumes Esc). */
  onCancel: () => boolean;
}

export function SqlEditor({ viewRef, storageKey, initialSql, schema, columns, onRun, onExplain, onCancel }: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onRun, onExplain, onCancel });
  handlers.current = { onRun, onExplain, onCancel };
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const language = useRef(new Compartment());
  // Tells CodeMirror's own base styles (tooltips, panels) which scheme is active; colours come from tokens.
  const scheme = useRef(new Compartment());
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
              { key: "Mod-e", run: () => (handlers.current.onExplain(), true) },
            ]),
          ),
          basicSetup,
          language.current.of(languageFor(initial.current.schema)),
          PostgreSQL.language.data.of({ autocomplete: columnSource(columnsRef) }),
          scheme.current.of(EditorView.darkTheme.of(initial.current.dark)),
          brandTheme,
          syntaxHighlighting(brandHighlight),
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
    viewRef.current?.dispatch({ effects: scheme.current.reconfigure(EditorView.darkTheme.of(dark)) });
  }, [dark, viewRef]);

  return <div ref={hostRef} className="h-full min-h-0 bg-paper" />;
}
