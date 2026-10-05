import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDateTime, formatUsd } from '../lib/format';
import { successRate } from '../lib/eval';
import { navigate } from '../lib/route';
import { Card, Empty, ErrorBox, Spinner } from '../components/ui';

export function EvalPage() {
  const q = useQuery({ queryKey: ['eval-runs'], queryFn: api.evalRuns, refetchInterval: 30_000 });
  return (
    <Card title="Eval runs">
      <p className="muted">
        Scenario suites run in CI with recorded model answers. Gates: zero policy violations and zero successful prompt
        injections.
      </p>
      {q.isLoading ? <Spinner label="Loading eval runs…" /> : null}
      {q.isError ? <ErrorBox error={q.error} /> : null}
      {q.data && q.data.items.length === 0 ? (
        <Empty title="No eval runs stored yet">
          Run <code>pnpm eval</code> to execute the scenario suite; results appear here.
        </Empty>
      ) : null}
      {q.data && q.data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="table table-click" data-testid="eval-runs-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Mode</th>
                <th>Models</th>
                <th className="num">Scenarios</th>
                <th className="num">Success</th>
                <th className="num">Violations</th>
                <th className="num">Injection success</th>
                <th>Gates</th>
                <th className="num">Avg steps</th>
                <th className="num">Avg cost</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((r) => {
                const rate = successRate(r.passed, r.passed + r.failed);
                return (
                  <tr key={r.id} data-testid="eval-row" onClick={() => navigate(`#/eval/${r.id}`)}>
                    <td className="nowrap">
                      <a href={`#/eval/${r.id}`} onClick={(e) => e.stopPropagation()}>
                        {formatDateTime(r.createdAt)}
                      </a>
                    </td>
                    <td>
                      <span className="tag tag-muted">{r.mode}</span>
                    </td>
                    <td className="small">{r.models.join(', ')}</td>
                    <td className="num">{r.scenarioCount}</td>
                    <td className="num">
                      <span className={rate >= 0.9 ? 'text-ok' : rate >= 0.6 ? 'text-warn' : 'text-danger'}>
                        {(rate * 100).toFixed(0)}%
                      </span>{' '}
                      <span className="muted small">
                        {r.passed}/{r.passed + r.failed}
                      </span>
                    </td>
                    <td className={`num ${r.violations > 0 ? 'text-danger' : 'text-ok'}`}>{r.violations}</td>
                    <td className={`num ${r.injectionSuccess > 0 ? 'text-danger' : 'text-ok'}`}>
                      {r.injectionSuccess}
                    </td>
                    <td>
                      {r.gatesPassed ? (
                        <span className="tag tag-ok">passed</span>
                      ) : (
                        <span className="tag tag-danger">failed</span>
                      )}
                    </td>
                    <td className="num">{r.avgSteps.toFixed(1)}</td>
                    <td className="num">{formatUsd(r.avgCostUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
