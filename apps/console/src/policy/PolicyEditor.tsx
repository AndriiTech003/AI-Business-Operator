import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { diagnosticRange } from '../lib/lint';
import type { PolicyDiagnostic } from '../lib/api';
import { policyHighlighting, policyYaml } from './yaml-language';

const theme = EditorView.theme({
  '&': { fontSize: '13px', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--surface)' },
  '&.cm-focused': { outline: '2px solid var(--accent-soft)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55', minHeight: '420px', maxHeight: '640px' },
  '.cm-gutters': { background: 'var(--surface-2)', borderRight: '1px solid var(--border)', color: 'var(--muted)' },
  '.cm-activeLine': { background: 'rgba(79, 70, 229, 0.05)' },
  '.cm-activeLineGutter': { background: 'rgba(79, 70, 229, 0.08)' },
});

export function PolicyEditor({
  value,
  onChange,
  validate,
}: {
  value: string;
  onChange: (value: string) => void;
  validate: (yaml: string) => Promise<PolicyDiagnostic[]>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const validateRef = useRef(validate);
  const initial = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
    validateRef.current = validate;
  }, [onChange, validate]);

  useEffect(() => {
    if (host.current === null) return;
    const lint = linter(
      async (v): Promise<Diagnostic[]> => {
        const text = v.state.doc.toString();
        let diags: PolicyDiagnostic[];
        try {
          diags = await validateRef.current(text);
        } catch {
          return [];
        }
        if (v.state.doc.toString() !== text) return [];
        const doc = v.state.doc;
        return diags.map((d) => {
          const range = diagnosticRange({ lines: doc.lines, line: (n) => doc.line(n) }, d.line, d.col);
          return {
            from: range.from,
            to: range.to,
            severity: d.severity,
            message: d.path !== '' ? `${d.path}: ${d.message}` : d.message,
            source: 'policy',
          };
        });
      },
      { delay: 500 },
    );
    const state = EditorState.create({
      doc: initial.current,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        indentUnit.of('  '),
        bracketMatching(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        policyYaml,
        policyHighlighting,
        lint,
        lintGutter(),
        theme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div className="policy-editor" data-testid="policy-editor" ref={host} />;
}
