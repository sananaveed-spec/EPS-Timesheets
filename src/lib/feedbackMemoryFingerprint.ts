import type { HighlightProposal } from './highlightRules';

function normalizeText(text: string): string {
  return text
    .toString()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// FNV-1a 64-bit hash (sync + deterministic; good enough for fingerprint IDs)
function fnv1a64Hex(input: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  let hash = 0xcbf29ce484222325n; // 14695981039346656037
  const prime = 0x100000001b3n; // 1099511628211
  const mask = (1n << 64n) - 1n;

  for (const b of data) {
    hash ^= BigInt(b);
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, '0');
}

export type RejectFingerprintParts = {
  fingerprintId: string;
  ruleId: string;
  triggerTextNorm: string;
  matchedTextNorm: string;
  projectLabel: string;
  employeeName: string;
};

export function makeRejectFingerprintParts(
  proposal: Pick<
    HighlightProposal,
    'ruleId' | 'triggerText' | 'matchedText' | 'projectLabel' | 'employeeName'
  >,
): RejectFingerprintParts {
  const triggerTextNorm = normalizeText(proposal.triggerText || proposal.matchedText);
  const matchedTextNorm = normalizeText(proposal.matchedText);
  const projectLabel = normalizeText(proposal.projectLabel);
  const employeeName = normalizeText(proposal.employeeName);

  const raw = [
    proposal.ruleId,
    triggerTextNorm,
    matchedTextNorm,
    projectLabel,
    employeeName,
  ].join('::');

  return {
    fingerprintId: fnv1a64Hex(raw),
    ruleId: proposal.ruleId,
    triggerTextNorm,
    matchedTextNorm,
    projectLabel,
    employeeName,
  };
}

