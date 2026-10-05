import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ApprovalBatch } from '../components/ApprovalBatch';
import { Empty, ErrorBox, Spinner } from '../components/ui';

export function ApprovalsPage() {
  const q = useQuery({
    queryKey: ['proposals', 'pending'],
    queryFn: () => api.proposals('pending'),
    refetchInterval: 5000,
  });
  if (q.isLoading) return <Spinner label="Loading approvals…" />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const batches = (q.data?.batches ?? []).filter(
    (b) => b.status === 'pending' && b.proposals.some((p) => p.status === 'pending'),
  );
  return (
    <div className="stack">
      <p className="muted">
        Actions the operator prepared but may not execute without a human decision. Approve, edit or reject them — the
        run continues on the server with exactly the payloads you approved.
      </p>
      {batches.length === 0 ? (
        <Empty title="Nothing waiting for approval">
          New approval batches appear here as soon as a run needs them.
        </Empty>
      ) : (
        batches.map((b) => <ApprovalBatch key={b.id} batch={b} showGoal />)
      )}
    </div>
  );
}
