import { createHash } from 'node:crypto';
import { canonicalJson } from '@aio/contracts';

export function argsHash(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson({ tool, args })).digest('hex');
}

export class HashMismatchError extends Error {
  constructor(
    readonly proposalId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `payload hash mismatch for proposal ${proposalId}: approved ${expected.slice(0, 12)}, got ${actual.slice(0, 12)}`,
    );
    this.name = 'HashMismatchError';
  }
}

export function assertApprovedPayload(
  proposalId: string,
  tool: string,
  args: Record<string, unknown>,
  approvedHash: string,
): void {
  const actual = argsHash(tool, args);
  if (actual !== approvedHash) throw new HashMismatchError(proposalId, approvedHash, actual);
}
