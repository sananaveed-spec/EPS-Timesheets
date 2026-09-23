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

/** Stable row identity for a highlight (ignores ruleId / edited trigger). */
export function proposalRowKey(
  proposal: Pick<
    HighlightProposal,
    'matchedText' | 'projectLabel' | 'employeeName'
  >,
): string {
  return rowHistoryKey(
    normalizeText(proposal.matchedText),
    normalizeText(proposal.projectLabel),
    normalizeText(proposal.employeeName),
  );
}

export function entryRowKey(entry: ReviewHistoryEntry): string {
  return rowHistoryKey(
    normalizeText(entry.matchedTextNorm),
    normalizeText(entry.projectLabel),
    normalizeText(entry.employeeName),
  );
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
    byRow.set(entryRowKey(entry), entry);
  }

  return proposals.map((p) => {
    const saved = byRow.get(proposalRowKey(p));
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

/**
 * Re-propose safely: apply Redis history, then overlay in-session
 * Accept/Delete/edits by highlight row (not proposal id / ruleId).
 */
export function mergeProposalsWithSessionAndHistory(
  fresh: HighlightProposal[],
  session: HighlightProposal[],
  entries: ReviewHistoryEntry[],
): HighlightProposal[] {
  const fromHistory = applyReviewHistory(fresh, entries);

  const sessionByRow = new Map<string, HighlightProposal>();
  for (const p of session) {
    if (p.status !== 'accepted' && p.status !== 'deleted') continue;
    sessionByRow.set(proposalRowKey(p), p);
  }
  if (sessionByRow.size === 0) return fromHistory;

  return fromHistory.map((p) => {
    const prior = sessionByRow.get(proposalRowKey(p));
    if (!prior) return p;
    return {
      ...p,
      status: prior.status,
      comment: prior.comment.trim() ? prior.comment : p.comment,
      triggerText: prior.triggerText.trim()
        ? prior.triggerText
        : p.triggerText,
    };
  });
}

/** Upsert one saved decision into the in-memory history list. */
export function upsertReviewHistoryEntry(
  entries: ReviewHistoryEntry[],
  next: ReviewHistoryEntry,
): ReviewHistoryEntry[] {
  const key = entryRowKey(next);
  return [...entries.filter((e) => entryRowKey(e) !== key), next];
}

/** Remove a row decision from the in-memory history list. */
export function removeReviewHistoryRow(
  entries: ReviewHistoryEntry[],
  proposal: Pick<
    HighlightProposal,
    'matchedText' | 'projectLabel' | 'employeeName'
  >,
): ReviewHistoryEntry[] {
  const key = proposalRowKey(proposal);
  return entries.filter((e) => entryRowKey(e) !== key);
}
