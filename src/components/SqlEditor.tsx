import { useEffect, useRef } from 'react';
import { bindEditor, persist } from '../actions';
import { isDirty, modelOf, monaco } from '../editor';
import { resolvedTheme } from '../theme';
import { useStore } from '../store';

// One Monaco instance for all documents: switching tab swaps the model and restores its view state.
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

export default function SqlEditor({ onCursor }: { onCursor: (ln: number, col: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shown = useRef<string | null>(null);
  // only SQL documents have a text model; with a designer tab active the editor keeps no model
  const activeDoc = useStore((s) => (s.docs.find((d) => d.id === s.activeDoc)?.kind === 'sql' ? s.activeDoc : null));

  useEffect(() => {
    const editor = monaco.editor.create(host.current!, {
      theme: resolvedTheme() === 'dark' ? 'mibsql-dark' : 'mibsql',
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      minimap: { enabled: false },
      tabSize: 2,
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      wordBasedSuggestions: 'off',
      suggest: { showWords: false, preview: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      fixedOverflowWidgets: true,
    });
    ed.current = editor;
    bindEditor((id) => (id === shown.current ? editor : null));
    editor.onDidChangeCursorPosition((e) => onCursor(e.position.lineNumber, e.position.column));
    const sub = editor.onDidChangeModelContent(() => {
      const id = shown.current;
      if (!id) return;
      // undo/redo set the alternative version id only after this event fires
      setTimeout(() => {
        const doc = useStore.getState().docs.find((d) => d.id === id);
        const dirty = isDirty(id);
        if (doc && doc.dirty !== dirty) useStore.getState().updateDoc(id, { dirty });
      });
      persist();
    });
    return () => { sub.dispose(); editor.dispose(); };
  }, []);

  useEffect(() => {
    const editor = ed.current;
    if (!editor) return;
    if (shown.current) viewStates.set(shown.current, editor.saveViewState());
    shown.current = activeDoc;
    if (!activeDoc) { editor.setModel(null); return; }
    editor.setModel(modelOf(activeDoc));
    const vs = viewStates.get(activeDoc);
    if (vs) editor.restoreViewState(vs);
    editor.focus();
  }, [activeDoc]);

  return <div className="editor" ref={host} />;
}
