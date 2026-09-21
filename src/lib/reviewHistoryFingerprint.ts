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

/** Stable id for a highlight row within a report period.
 *  Intentionally ignores ruleId and edited trigger/comment so Accept/Delete
 *  still restore after highlight-rule changes or comment regenerations.
 */
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

function rowHistoryKey(
  matchedTextNorm: string,
  projectLabel: string,
  employeeName: string,
): string {
  return `${matchedTextNorm}::${projectLabel}::${employeeName}`;
}

export function applyReviewHistory(
  proposals: HighlightProposal[],
  entries: ReviewHistoryEntry[],
): HighlightProposal[] {
  if (entries.length === 0) return proposals;

  // Newest decision wins when older ruleId-based duplicates exist.
  const sorted = [...entries].sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt),
  );
  const byRow = new Map<string, ReviewHistoryEntry>();
  for (const entry of sorted) {
    byRow.set(
      rowHistoryKey(
        entry.matchedTextNorm,
        entry.projectLabel,
        entry.employeeName,
      ),
      entry,
    );
  }

  return proposals.map((p) => {
    const saved = byRow.get(
      rowHistoryKey(
        normalizeText(p.matchedText),
        normalizeText(p.projectLabel),
        normalizeText(p.employeeName),
      ),
    );
    if (!saved) return p;
    return {
      ...p,
      status: saved.status,
      comment: saved.comment.trim() ? saved.comment : p.comment,
      triggerText: saved.triggerText.trim()
        ? saved.triggerText
        : p.triggerText,
    };
  });
}
