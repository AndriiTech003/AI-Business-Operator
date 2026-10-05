import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from '@codemirror/language';
import { tags } from '@lezer/highlight';

type ExprMode = null | 'plain' | '"' | "'";

export interface YamlState {
  keyAllowed: boolean;
  currentKey: string | null;
  pendingExpr: boolean;
  expr: ExprMode;
  blockIndent: number | null;
  lineIndent: number;
}

const EXPRESSION_KEYS = new Set(['when']);
const DECISION_WORDS = /^(?:allow|require_approval|deny)(?=[\s,\]}#]|$)/;
const ATOMS = /^(?:true|false|yes|no|null|~)(?=[\s,\]}#]|$)/;
const NUMBER = /^[-+]?(?:\d[\d_]*)(?:\.\d+)?(?:e[-+]?\d+)?(?=[\s,\]}#]|$)/i;
const KEY = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"[\]{},][^:#]*?)(?=\s*:(?:\s|$))/;

function readQuoted(stream: StringStream, quote: string): void {
  stream.next();
  while (!stream.eol()) {
    const ch = stream.next();
    if (quote === '"' && ch === '\\') {
      stream.next();
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && stream.peek() === "'") {
        stream.next();
        continue;
      }
      return;
    }
  }
}

function exprToken(stream: StringStream, state: YamlState): string | null {
  const quote = state.expr;
  const ch = stream.peek();
  if ((quote === '"' || quote === "'") && ch === quote) {
    stream.next();
    state.expr = null;
    return 'exprQuote';
  }
  if (stream.eatSpace()) return null;
  if (quote === 'plain' && ch === '#') {
    stream.skipToEnd();
    state.expr = null;
    return 'comment';
  }
  if (stream.match(/^\d+(?:\.\d+)?/)) return 'number';
  if (stream.match(/^(?:and|or|not|in)\b/)) return 'exprKeyword';
  if (stream.match(/^(?:null|true|false)\b/)) return 'atom';
  if (stream.match(/^[A-Za-z_]\w*(?=\s*\()/)) return 'exprFunction';
  if (stream.match(/^[A-Za-z_]\w*/)) return 'exprVariable';
  if ((ch === "'" || ch === '"') && ch !== quote) {
    readQuoted(stream, ch);
    return 'string';
  }
  if (stream.match(/^(?:==|!=|<=|>=|&&|\|\||[+\-*/%<>!?:.])/)) return 'operator';
  if (ch !== undefined && '()[],'.includes(ch)) {
    stream.next();
    return 'punctuation';
  }
  stream.next();
  return null;
}

export const yamlParser = {
  name: 'policy-yaml',
  startState(): YamlState {
    return { keyAllowed: true, currentKey: null, pendingExpr: false, expr: null, blockIndent: null, lineIndent: 0 };
  },
  copyState(s: YamlState): YamlState {
    return { ...s };
  },
  token(stream: StringStream, state: YamlState): string | null {
    if (stream.sol()) {
      state.lineIndent = stream.indentation();
      if (state.blockIndent !== null) {
        if (stream.string.trim() === '' || state.lineIndent > state.blockIndent) {
          stream.skipToEnd();
          return 'string';
        }
        state.blockIndent = null;
      }
      state.keyAllowed = true;
      state.currentKey = null;
      state.pendingExpr = false;
      if (state.expr === 'plain') state.expr = null;
    }
    if (state.expr === '"' || state.expr === "'") return exprToken(stream, state);
    if (stream.eatSpace()) return null;
    const ch = stream.peek();
    if (ch === '#' && (stream.pos === 0 || /\s/.test(stream.string.charAt(stream.pos - 1)))) {
      stream.skipToEnd();
      return 'comment';
    }
    if (state.expr === 'plain') return exprToken(stream, state);
    if (stream.sol() && stream.match(/^(?:---|\.\.\.)(?=\s|$)/)) return 'meta';
    if (state.keyAllowed) {
      if (stream.match(/^-(?=\s|$)/)) return 'punctuation';
      const m = stream.match(KEY);
      if (m && typeof m === 'object') {
        state.keyAllowed = false;
        state.currentKey = m[0].replace(/^["']|["']$/g, '').trim();
        return 'propertyName';
      }
    }
    state.keyAllowed = false;
    if (stream.match(/^:(?=\s|$)/)) {
      state.pendingExpr = state.currentKey !== null && EXPRESSION_KEYS.has(state.currentKey);
      return 'punctuation';
    }
    if (state.pendingExpr) {
      state.pendingExpr = false;
      if (ch === '"' || ch === "'") {
        stream.next();
        state.expr = ch;
        return 'exprQuote';
      }
      if (ch !== '|' && ch !== '>') {
        state.expr = 'plain';
        return exprToken(stream, state);
      }
    }
    if ((ch === '|' || ch === '>') && stream.match(/^[|>][-+0-9]*(?=\s*(?:#.*)?$)/)) {
      state.blockIndent = state.lineIndent;
      return 'meta';
    }
    if (ch === '"' || ch === "'") {
      readQuoted(stream, ch);
      return 'string';
    }
    if (stream.match(NUMBER)) return 'number';
    if (stream.match(ATOMS)) return 'atom';
    if (stream.match(DECISION_WORDS)) return 'keyword';
    if (ch === '&' || ch === '*') {
      if (stream.match(/^[&*][^\s,\]}]+/)) return 'labelName';
    }
    if (ch !== undefined && '[]{},'.includes(ch)) {
      stream.next();
      return 'punctuation';
    }
    if (stream.match(/^[^\s#,\]}]+/)) return 'string';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#' } },
  tokenTable: {
    exprQuote: tags.special(tags.string),
    exprKeyword: tags.operatorKeyword,
    exprFunction: tags.function(tags.variableName),
    exprVariable: tags.variableName,
  },
};

export const policyYaml = StreamLanguage.define<YamlState>(yamlParser);

export const policyHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: '#1d4ed8', fontWeight: '600' },
  { tag: tags.string, color: '#047857' },
  { tag: tags.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: tags.number, color: '#b45309' },
  { tag: tags.atom, color: '#be185d' },
  { tag: tags.keyword, color: '#9f1239', fontWeight: '600' },
  { tag: tags.meta, color: '#6b7280' },
  { tag: tags.labelName, color: '#7c3aed' },
  { tag: tags.punctuation, color: '#64748b' },
  { tag: tags.operator, color: '#475569', fontWeight: '600' },
  { tag: tags.special(tags.string), color: '#9333ea', fontWeight: '600' },
  { tag: tags.operatorKeyword, color: '#c026d3', fontWeight: '600' },
  { tag: tags.function(tags.variableName), color: '#0e7490', fontWeight: '600' },
  { tag: tags.variableName, color: '#9a3412' },
]);

export const policyHighlighting = syntaxHighlighting(policyHighlightStyle);
