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
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error || `Review history fetch failed (${response.status}).`,
    );
  }
  const payload = (await response.json()) as { entries?: ReviewHistoryEntry[] };
  return Array.isArray(payload.entries) ? payload.entries : [];
}

export async function saveReviewHistoryEntry(args: {
  proposal: HighlightProposal;
  periodStart: string;
  periodEnd: string;
  status: ReviewHistoryStatus;
}): Promise<void> {
  const keyParts = makeReviewHistoryKeyParts(
    args.proposal,
    args.periodStart,
    args.periodEnd,
  );

  const response = await fetch(endpointUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...keyParts,
      status: args.status,
      triggerText: args.proposal.triggerText || args.proposal.matchedText,
      comment: args.proposal.comment,
      updatedAt: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error || `Review history save failed (${response.status}).`,
    );
  }
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
  const params = new URLSearchParams({
    historyId: keyParts.historyId,
    periodStart: keyParts.periodStart,
    periodEnd: keyParts.periodEnd,
  });
  const response = await fetch(`${endpointUrl()}?${params.toString()}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error || `Review history clear failed (${response.status}).`,
    );
  }
}
