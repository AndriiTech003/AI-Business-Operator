import type { TaintFinding } from '@aio/contracts';
import { describeSource, findingSegments } from '../lib/taint';

export function TaintPanel({ findings }: { findings: TaintFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="taint-panel" data-testid="taint-highlight">
      <div className="taint-title">⚠ Argument taken from untrusted content — check before approving</div>
      {findings.map((f, i) => (
        <div className="taint-finding" key={`${f.argPath}-${i}`}>
          <div className="taint-meta">
            <span>
              argument <code>{f.argPath}</code> contains <span className="tag tag-warn">{f.kind}</span>{' '}
              <code className="taint-fragment-inline">{f.fragment}</code>
            </span>
            <span className="taint-source" data-testid="taint-source">
              {describeSource(f)}
            </span>
          </div>
          <blockquote className="taint-text">
            {findingSegments(f).map((seg, j) =>
              seg.marked ? (
                <mark key={j} data-testid="taint-fragment">
                  {seg.text}
                </mark>
              ) : (
                <span key={j}>{seg.text}</span>
              ),
            )}
          </blockquote>
        </div>
      ))}
    </div>
  );
}
