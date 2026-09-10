import type { HighlightProposal, HighlightStatus } from './highlightRules';

function normalizeText(text: string): string {
  return text
    .toString()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a64Hex(input: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;

  for (const b of data) {
    hash ^= BigInt(b);
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, '0');
}

export type ReviewHistoryStatus = Extract<
  HighlightStatus,
  'accepted' | 'deleted'
>;

export type ReviewHistoryEntry = {
  historyId: string;
  periodStart: string;
  periodEnd: string;
  ruleId: string;
  matchedTextNorm: string;
  projectLabel: string;
  employeeName: string;
  status: ReviewHistoryStatus;
  triggerText: string;
  comment: string;
  updatedAt: string;
};

export type ReviewHistoryKeyParts = {
  historyId: string;
  periodStart: string;
  periodEnd: string;
  ruleId: string;
  matchedTextNorm: string;
  projectLabel: string;
  employeeName: string;
};

/** Stable id for a highlight within a report period (ignores edited trigger text). */
export function makeReviewHistoryKeyParts(
  proposal: Pick<
    HighlightProposal,
    'ruleId' | 'matchedText' | 'projectLabel' | 'employeeName'
  >,
  periodStart: string,
  periodEnd: string,
): ReviewHistoryKeyParts {
  const matchedTextNorm = normalizeText(proposal.matchedText);
  const projectLabel = normalizeText(proposal.projectLabel);
  const employeeName = normalizeText(proposal.employeeName);
  const periodStartNorm = normalizeText(periodStart);
  const periodEndNorm = normalizeText(periodEnd);

  const raw = [
    periodStartNorm,
    periodEndNorm,
    proposal.ruleId,
    matchedTextNorm,
    projectLabel,
    employeeName,
  ].join('::');

  return {
    historyId: fnv1a64Hex(raw),
    periodStart: periodStartNorm,
    periodEnd: periodEndNorm,
    ruleId: proposal.ruleId,
    matchedTextNorm,
    projectLabel,
    employeeName,
  };
}

export function applyReviewHistory(
  proposals: HighlightProposal[],
  entries: ReviewHistoryEntry[],
): HighlightProposal[] {
  if (entries.length === 0) return proposals;

  const byKey = new Map(
    entries.map((e) => [
      `${e.ruleId}::${e.matchedTextNorm}::${e.projectLabel}::${e.employeeName}`,
      e,
    ]),
  );

  return proposals.map((p) => {
    const key = [
      p.ruleId,
      normalizeText(p.matchedText),
      normalizeText(p.projectLabel),
      normalizeText(p.employeeName),
    ].join('::');
    const saved = byKey.get(key);
    if (!saved) return p;
    return {
      ...p,
      status: saved.status,
      comment: saved.comment || p.comment,
      triggerText: saved.triggerText || p.triggerText,
    };
  });
}
