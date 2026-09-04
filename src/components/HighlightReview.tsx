import { useMemo, useState } from 'react';
import type { HighlightProposal } from '../lib/highlightRules';
import { groupProposalsByEmployee } from '../lib/highlightRules';
import { makeRejectFingerprintParts } from '../lib/feedbackMemoryFingerprint';
import { saveRejectMemoryEntry } from '../lib/feedbackMemoryClient';

const REJECT_REASON_OPTIONS = [
  { id: 'false_positive', label: 'False positive / not needed' },
  { id: 'already_handled', label: 'Already handled elsewhere' },
  { id: 'wrong_match', label: 'Matched text is wrong' },
  { id: 'other', label: 'Other' },
] as const;

type RejectReasonId = (typeof REJECT_REASON_OPTIONS)[number]['id'];

interface HighlightReviewProps {
  proposals: HighlightProposal[];
  onChange: (proposals: HighlightProposal[]) => void;
  onDownload: () => void;
  downloadDisabled?: boolean;
  downloading?: boolean;
  onRejectSaved?: (fingerprintId: string) => void;
}

function statusCounts(items: HighlightProposal[]) {
  return {
    pending: items.filter((p) => p.status === 'pending').length,
    accepted: items.filter((p) => p.status === 'accepted').length,
    deleted: items.filter((p) => p.status === 'deleted').length,
  };
}

export function HighlightReview({
  proposals,
  onChange,
  onDownload,
  downloadDisabled = false,
  downloading = false,
  onRejectSaved,
}: HighlightReviewProps) {
  const groups = useMemo(() => groupProposalsByEmployee(proposals), [proposals]);
  const [fileIndex, setFileIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTrigger, setDraftTrigger] = useState('');
  const [draftComment, setDraftComment] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<RejectReasonId>('false_positive');
  const [rejectNote, setRejectNote] = useState('');
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState<RejectReasonId>(
    'false_positive',
  );
  const [bulkRejectNote, setBulkRejectNote] = useState('');
  const [rejectSaving, setRejectSaving] = useState(false);
  const [rejectSaveError, setRejectSaveError] = useState<string | null>(null);

  const safeIndex =
    groups.length === 0 ? 0 : Math.min(fileIndex, groups.length - 1);
  const current = groups[safeIndex];
  const counts = statusCounts(proposals);
  const currentCounts = current ? statusCounts(current.proposals) : null;
  const allResolved =
    proposals.length === 0 ||
    proposals.every((p) => p.status === 'accepted' || p.status === 'deleted');

  const updateProposal = (
    id: string,
    patch: Partial<
      Pick<HighlightProposal, 'status' | 'comment' | 'triggerText'>
    >,
  ) => {
    onChange(proposals.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const acceptAllOnFile = () => {
    if (!current) return;
    const ids = new Set(current.proposals.map((p) => p.id));
    onChange(
      proposals.map((p) =>
        ids.has(p.id) && p.status === 'pending'
          ? { ...p, status: 'accepted' }
          : p,
      ),
    );
  };

  const updateRejectStatus = (ids: Set<string>) => {
    onChange(
      proposals.map((p) => (ids.has(p.id) ? { ...p, status: 'deleted' } : p)),
    );
  };

  const saveRejectForProposal = async (
    proposal: HighlightProposal,
    reason: RejectReasonId,
    note: string,
  ) => {
    const fingerprintParts = makeRejectFingerprintParts(proposal);
    try {
      await saveRejectMemoryEntry({
        fingerprintParts,
        reason,
        note,
      });
    } catch (e) {
      // Failing to persist memory shouldn't block review; we still delete the item.
      setRejectSaveError(
        e instanceof Error ? e.message : 'Failed to save reject memory.',
      );
    } finally {
      onRejectSaved?.(fingerprintParts.fingerprintId);
    }
  };

  const saveBulkRejects = async () => {
    if (!current) return;
    setRejectSaving(true);
    setRejectSaveError(null);
    try {
      const ids = new Set(current.proposals.map((p) => p.id));
      const payloads = current.proposals
        .filter((p) => ids.has(p.id))
        .map((proposal) => ({
        fingerprintParts: makeRejectFingerprintParts(proposal),
      }));

      updateRejectStatus(ids);
      await Promise.all(
        payloads.map(async ({ fingerprintParts }) => {
          try {
            await saveRejectMemoryEntry({
              fingerprintParts,
              reason: bulkRejectReason,
              note: bulkRejectNote,
            });
          } catch (e) {
            setRejectSaveError(
              e instanceof Error ? e.message : 'Failed to save reject memory.',
            );
          } finally {
            onRejectSaved?.(fingerprintParts.fingerprintId);
          }
        }),
      );
    } finally {
      setRejectSaving(false);
      setBulkRejectOpen(false);
      setBulkRejectReason('false_positive');
      setBulkRejectNote('');
    }
  };

  if (groups.length === 0) {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-6">
        <h2 className="text-base font-semibold text-gray-900">
          Highlight review
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          No automatic highlights were proposed for this file. You can download
          the ZIP as usual.
        </p>
        <button
          type="button"
          onClick={onDownload}
          disabled={downloadDisabled || downloading}
          className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {downloading ? 'Preparing ZIP…' : 'Download ZIP (all employee PDFs)'}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Highlight review
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Review proposed highlights one employee file at a time. Use Edit to
            change the yellow trigger text and/or comment before accepting.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-yellow-100 px-2.5 py-1 font-medium text-yellow-900">
            {counts.pending} pending
          </span>
          <span className="rounded-full bg-green-100 px-2.5 py-1 font-medium text-green-800">
            {counts.accepted} accepted
          </span>
          <span className="rounded-full bg-gray-200 px-2.5 py-1 font-medium text-gray-700">
            {counts.deleted} deleted
          </span>
        </div>
      </div>

      {rejectSaveError && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {rejectSaveError}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 ring-1 ring-gray-200">
        <div className="text-sm text-gray-800">
          <span className="font-semibold">
            File {safeIndex + 1} of {groups.length}:
          </span>{' '}
          {current.employeeName}.pdf
          {currentCounts && (
            <span className="ml-2 text-gray-500">
              ({currentCounts.pending} pending · {currentCounts.accepted}{' '}
              accepted · {currentCounts.deleted} deleted)
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={acceptAllOnFile}
            className="rounded border border-green-300 bg-green-50 px-2.5 py-1 text-xs font-medium text-green-800 hover:bg-green-100"
          >
            Accept all on this file
          </button>
          <button
            type="button"
            onClick={() => {
              setBulkRejectOpen(true);
              setBulkRejectReason('false_positive');
              setBulkRejectNote('');
              setRejectSaveError(null);
            }}
            disabled={rejectSaving}
            className="rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Delete all on this file
          </button>
        </div>
      </div>

      {bulkRejectOpen && current && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
          <div className="text-sm font-medium text-gray-900">
            Delete all proposals on {current.employeeName}.pdf?
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr]">
            <label className="block text-xs font-medium text-gray-700 md:col-span-1">
              Reject reason
              <select
                value={bulkRejectReason}
                onChange={(e) =>
                  setBulkRejectReason(e.target.value as RejectReasonId)
                }
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
              >
                {REJECT_REASON_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-gray-700 md:col-span-1">
              Optional note
              <textarea
                value={bulkRejectNote}
                onChange={(event) => setBulkRejectNote(event.target.value)}
                rows={3}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900 outline-none focus:border-blue-500"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={rejectSaving}
              onClick={() => void saveBulkRejects()}
              className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rejectSaving ? 'Saving…' : 'Confirm delete (and save reject memory)'}
            </button>
            <button
              type="button"
              disabled={rejectSaving}
              onClick={() => {
                setBulkRejectOpen(false);
                setBulkRejectReason('false_positive');
                setBulkRejectNote('');
              }}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul className="mt-3 space-y-3">
        {current.proposals.map((item) => {
          const isEditing = editingId === item.id;
          const isRejecting = rejectingId === item.id;
          return (
            <li
              key={item.id}
              className={`rounded-lg bg-white p-3 ring-1 ${
                item.status === 'accepted'
                  ? 'ring-green-300'
                  : item.status === 'deleted'
                    ? 'ring-gray-200 opacity-60'
                    : 'ring-amber-300'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                  {item.ruleLabel}
                </span>
                <span className="text-xs uppercase tracking-wide text-gray-500">
                  {item.status}
                </span>
              </div>

              {item.projectLabel && (
                <p className="mt-2 text-xs text-gray-500">
                  Project: {item.projectLabel}
                  {item.tag ? ` · Tag: ${item.tag}` : ''}
                </p>
              )}

              {!isEditing && (
                <>
                  <p className="mt-1 text-sm text-gray-800">
                    <span className="font-medium">Trigger: </span>
                    <span className="rounded bg-yellow-200 px-1">
                      {item.triggerText || item.matchedText}
                    </span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">
                    <span className="font-medium">Matched text: </span>
                    {item.matchedText}
                  </p>
                  <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-sm text-red-800">
                    <span className="font-medium">Comment: </span>
                    {item.comment}
                  </p>
                </>
              )}

              {isEditing && (
                <div className="mt-2 space-y-2">
                  <label className="block text-xs font-medium text-gray-700">
                    Trigger (yellow highlight in PDF)
                    <textarea
                      value={draftTrigger}
                      onChange={(event) => setDraftTrigger(event.target.value)}
                      rows={3}
                      className="mt-1 w-full rounded border border-yellow-300 bg-yellow-50 px-2 py-1.5 text-sm text-gray-900 outline-none focus:border-blue-500"
                    />
                  </label>
                  <p className="text-xs text-gray-500">
                    Add or delete words here. Keep text that appears in the
                    matched description so the PDF can highlight it.
                  </p>
                  <label className="block text-xs font-medium text-gray-700">
                    Comment
                    <textarea
                      value={draftComment}
                      onChange={(event) => setDraftComment(event.target.value)}
                      rows={3}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900 outline-none focus:border-blue-500"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        updateProposal(item.id, {
                          triggerText:
                            draftTrigger.trim() ||
                            item.triggerText ||
                            item.matchedText,
                          comment: draftComment.trim() || item.comment,
                          status: 'accepted',
                        });
                        setEditingId(null);
                      }}
                      className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                    >
                      Save & accept
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {!isEditing && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {isRejecting ? (
                    <>
                      <label className="block w-full text-xs font-medium text-gray-700">
                        Reject reason
                        <select
                          value={rejectReason}
                          onChange={(e) =>
                            setRejectReason(e.target.value as RejectReasonId)
                          }
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
                        >
                          {REJECT_REASON_OPTIONS.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block w-full text-xs font-medium text-gray-700">
                        Optional note
                        <textarea
                          value={rejectNote}
                          onChange={(event) => setRejectNote(event.target.value)}
                          rows={3}
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900 outline-none focus:border-blue-500"
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={rejectSaving}
                          onClick={() => {
                            const reasonToSave = rejectReason;
                            const noteToSave = rejectNote;
                            updateProposal(item.id, { status: 'deleted' });
                            setRejectingId(null);
                            setRejectNote('');
                            setRejectReason('false_positive');
                            setRejectSaving(true);
                            void (async () => {
                              try {
                                await saveRejectForProposal(
                                  item,
                                  reasonToSave,
                                  noteToSave,
                                );
                              } finally {
                                setRejectSaving(false);
                              }
                            })();
                          }}
                          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {rejectSaving ? 'Saving…' : 'Confirm delete'}
                        </button>
                        <button
                          type="button"
                          disabled={rejectSaving}
                          onClick={() => {
                            setRejectingId(null);
                            setRejectNote('');
                            setRejectReason('false_positive');
                          }}
                          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                  <button
                    type="button"
                    onClick={() =>
                      updateProposal(item.id, { status: 'accepted' })
                    }
                    className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(item.id);
                      setDraftTrigger(item.triggerText || item.matchedText);
                      setDraftComment(item.comment);
                    }}
                    className="rounded border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-800 hover:bg-blue-100"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      (() => {
                        setRejectingId(item.id);
                        setRejectReason('false_positive');
                        setRejectNote('');
                        setRejectSaveError(null);
                      })()
                    }
                    className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Delete
                  </button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={safeIndex <= 0}
            onClick={() => setFileIndex((i) => Math.max(0, i - 1))}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous file
          </button>
          <button
            type="button"
            disabled={safeIndex >= groups.length - 1}
            onClick={() =>
              setFileIndex((i) => Math.min(groups.length - 1, i + 1))
            }
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next file
          </button>
        </div>

        <div className="flex flex-col items-end gap-1">
          {!allResolved && (
            <p className="text-xs text-amber-800">
              Resolve every pending item (Accept or Delete) to enable download.
            </p>
          )}
          <button
            type="button"
            onClick={onDownload}
            disabled={!allResolved || downloadDisabled || downloading}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {downloading
              ? 'Preparing ZIP…'
              : 'Download ZIP (accepted highlights only)'}
          </button>
        </div>
      </div>
    </div>
  );
}
