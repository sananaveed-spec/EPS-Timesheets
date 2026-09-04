import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeedbackRejectMemoryEntry } from '../lib/feedbackMemoryClient';
import {
  clearRejectMemory,
  fetchRejectMemoryEntries,
} from '../lib/feedbackMemoryClient';

function truncate(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + '…';
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function FeedbackMemoryPanel({
  onCleared,
}: {
  onCleared?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<FeedbackRejectMemoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const displayed = useMemo(() => entries.slice(0, 50), [entries]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchRejectMemoryEntries();
      setEntries(next);
    } catch (e) {
      setEntries([]);
      setError(e instanceof Error ? e.message : 'Failed to load rejects.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const onClearAll = useCallback(async () => {
    const ok = window.confirm(
      'Clear all saved reject memory? This will re-enable suppressed highlight suggestions.',
    );
    if (!ok) return;
    setLoading(true);
    setError(null);
    try {
      await clearRejectMemory();
      setEntries([]);
      onCleared?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear rejects.');
    } finally {
      setLoading(false);
    }
  }, [onCleared]);

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Saved rejects</h2>
          <p className="mt-1 text-sm text-gray-600">
            Used to suppress repeated false-positive highlight proposals.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {open ? 'Hide' : 'View'}
          </button>
          <button
            type="button"
            onClick={() => void onClearAll()}
            disabled={loading}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear all
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4">
          {loading && (
            <p className="text-sm text-gray-600">Loading saved rejects…</p>
          )}
          {!loading && error && (
            <p className="text-sm text-red-700">{error}</p>
          )}
          {!loading && !error && displayed.length === 0 && (
            <p className="text-sm text-gray-600">
              No saved rejects yet.
            </p>
          )}

          {!loading && !error && displayed.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500">
                Showing {Math.min(50, entries.length)} of {entries.length}
                saved rejects.
              </div>
              <ul className="space-y-3">
                {displayed.map((e) => (
                  <li key={e.fingerprintId} className="rounded-lg bg-gray-50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                        {e.ruleId}
                      </span>
                      <span className="text-xs font-medium text-gray-500">
                        {formatWhen(e.createdAt)}
                      </span>
                    </div>
                    <div className="mt-2 text-sm text-gray-800">
                      Reason: <span className="font-medium">{e.reason}</span>
                    </div>
                    <div className="mt-1 text-sm text-gray-700">
                      Project: {e.projectLabel}
                    </div>
                    <div className="mt-1 text-sm text-gray-700">
                      Employee: {e.employeeName}
                    </div>
                    <div className="mt-2 text-xs text-gray-600">
                      Trigger: {truncate(e.triggerTextNorm, 80)}
                    </div>
                    {e.note && (
                      <div className="mt-1 text-xs text-gray-600">
                        Note: {truncate(e.note, 120)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

