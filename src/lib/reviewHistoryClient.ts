import type { HighlightProposal } from './highlightRules';
import {
  makeReviewHistoryKeyParts,
  type ReviewHistoryEntry,
  type ReviewHistoryStatus,
} from './reviewHistoryFingerprint';

const FEEDBACK_API_URL = import.meta.env.VITE_FEEDBACK_API_URL?.trim() ?? '';

function endpointUrl(): string {
  if (FEEDBACK_API_URL) {
    return FEEDBACK_API_URL.replace(/\/$/, '') + '/review-history';
  }
  return '/api/review-history';
}

export async function fetchReviewHistory(
  periodStart: string,
  periodEnd: string,
): Promise<ReviewHistoryEntry[]> {
  const start = periodStart.toString().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const end = periodEnd.toString().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({ periodStart: start, periodEnd: end });
  const response = await fetch(`${endpointUrl()}?${params.toString()}`);
  const payload = (await response.json().catch(() => null)) as
    | { entries?: ReviewHistoryEntry[]; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.error || `Review history fetch failed (${response.status}).`,
    );
  }
  if (!payload || !Array.isArray(payload.entries)) {
    throw new Error(
      'Review history fetch returned an invalid response (is /api/review-history available?).',
    );
  }
  return payload.entries;
}

export async function saveReviewHistoryEntry(args: {
  proposal: HighlightProposal;
  periodStart: string;
  periodEnd: string;
  status: ReviewHistoryStatus;
}): Promise<ReviewHistoryEntry> {
  const keyParts = makeReviewHistoryKeyParts(
    args.proposal,
    args.periodStart,
    args.periodEnd,
  );

  const entry: ReviewHistoryEntry = {
    ...keyParts,
    status: args.status,
    triggerText: args.proposal.triggerText || args.proposal.matchedText,
    comment: args.proposal.comment,
    updatedAt: new Date().toISOString(),
  };

  const response = await fetch(endpointUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string }
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(
      payload?.error || `Review history save failed (${response.status}).`,
    );
  }
  return entry;
}

export async function clearReviewHistoryEntry(args: {
  proposal: HighlightProposal;
  periodStart: string;
  periodEnd: string;
}): Promise<void> {
  const keyParts = makeReviewHistoryKeyParts(
    args.proposal,
    args.periodStart,
    args.periodEnd,
  );
  // Clear by row fields so older ruleId-based historyIds are removed too.
  const params = new URLSearchParams({
    historyId: keyParts.historyId,
    periodStart: keyParts.periodStart,
    periodEnd: keyParts.periodEnd,
    matchedTextNorm: keyParts.matchedTextNorm,
    projectLabel: keyParts.projectLabel,
    employeeName: keyParts.employeeName,
  });
  const response = await fetch(`${endpointUrl()}?${params.toString()}`, {
    method: 'DELETE',
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string }
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(
      payload?.error || `Review history clear failed (${response.status}).`,
    );
  }
}
