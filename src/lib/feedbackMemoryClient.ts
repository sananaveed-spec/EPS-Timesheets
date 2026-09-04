import type { RejectFingerprintParts } from './feedbackMemoryFingerprint';

export type FeedbackRejectMemoryEntry = {
  fingerprintId: string;
  ruleId: string;
  triggerTextNorm: string;
  matchedTextNorm: string;
  projectLabel: string;
  employeeName: string;
  reason: string;
  note?: string;
  createdAt: string;
};

const FEEDBACK_MEMORY_API_KEY =
  import.meta.env.VITE_FEEDBACK_MEMORY_API_KEY?.trim() ?? '';

const FEEDBACK_API_URL = import.meta.env.VITE_FEEDBACK_API_URL?.trim() ?? '';

function endpointUrl(): string {
  if (FEEDBACK_API_URL) {
    return FEEDBACK_API_URL.replace(/\/$/, '') + '/feedback-memory';
  }
  return '/api/feedback-memory';
}

function authHeaders(): Record<string, string> {
  if (!FEEDBACK_MEMORY_API_KEY) return {};
  return { 'x-feedback-memory-api-key': FEEDBACK_MEMORY_API_KEY };
}

export async function fetchRejectFingerprints(): Promise<Set<string>> {
  const url = endpointUrl() + '?fingerprintsOnly=1';
  const response = await fetch(url, { headers: authHeaders(), method: 'GET' });
  if (!response.ok) {
    throw new Error(`Feedback memory fetch failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    fingerprints?: string[];
  };

  const fingerprints = Array.isArray(payload.fingerprints)
    ? payload.fingerprints
    : [];
  return new Set(fingerprints);
}

export async function fetchRejectMemoryEntries(): Promise<
  FeedbackRejectMemoryEntry[]
> {
  const response = await fetch(endpointUrl(), {
    headers: authHeaders(),
    method: 'GET',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error ||
        `Feedback memory entries fetch failed (${response.status}).`,
    );
  }

  const payload = (await response.json()) as {
    entries?: FeedbackRejectMemoryEntry[];
  };

  return Array.isArray(payload.entries) ? payload.entries : [];
}

export async function saveRejectMemoryEntry(args: {
  fingerprintParts: RejectFingerprintParts;
  reason: string;
  note?: string;
}): Promise<void> {
  const response = await fetch(endpointUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      fingerprintId: args.fingerprintParts.fingerprintId,
      ruleId: args.fingerprintParts.ruleId,
      triggerTextNorm: args.fingerprintParts.triggerTextNorm,
      matchedTextNorm: args.fingerprintParts.matchedTextNorm,
      projectLabel: args.fingerprintParts.projectLabel,
      employeeName: args.fingerprintParts.employeeName,
      reason: args.reason,
      note: args.note?.trim() || undefined,
      createdAt: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error || `Feedback memory save failed (${response.status}).`);
  }
}

export async function clearRejectMemory(): Promise<void> {
  const response = await fetch(endpointUrl(), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Feedback memory clear failed (${response.status}).`);
  }
}

