import { useEffect, useMemo, useState } from 'react';
import type { HighlightProposal } from '../lib/highlightRules';
import { groupProposalsByEmployee } from '../lib/highlightRules';
import {
  DEFAULT_EMAIL_PRESETS,
  EMAIL_REPORT_OFFICES,
  OFFICE_GREETING_NAME,
  OFFICE_SENDER_FIRST_NAME,
  buildTimesheetBody,
  buildTimesheetSubject,
  buildTimesheetZipFilename,
  officeEmailLabel,
  parseEmailList,
  type EmailReportOffice,
} from '../lib/emailTemplates';
import {
  formatScheduledSendLabel,
  nextEightAmPacific,
} from '../lib/graphMail';
import {
  clearReviewHistoryEntry,
  saveReviewHistoryEntry,
} from '../lib/reviewHistoryClient';
import type { ReviewHistoryEntry } from '../lib/reviewHistoryFingerprint';
import { loadEmailPresets, saveEmailPreset } from '../lib/userSettings';

export interface SendEmailRequest {
  office: EmailReportOffice;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  zipFilename: string;
  /** Immediate send vs schedule for 8 AM Pacific. */
  sendNow?: boolean;
}

export interface SendEmailResult {
  scheduledAt: Date | null;
}

interface HighlightReviewProps {
  proposals: HighlightProposal[];
  onChange: (proposals: HighlightProposal[]) => void;
  onDownload: () => void;
  onSendEmail?: (
    request: SendEmailRequest,
  ) => void | Promise<void | SendEmailResult>;
  downloadDisabled?: boolean;
  downloading?: boolean;
  sendingEmail?: boolean;
  periodStart?: string;
  periodEnd?: string;
  onHistoryPersisted?: (entry: ReviewHistoryEntry) => void;
  onHistoryCleared?: (proposal: HighlightProposal) => void;
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
  onSendEmail,
  downloadDisabled = false,
  downloading = false,
  sendingEmail = false,
  periodStart = '',
  periodEnd = '',
  onHistoryPersisted,
  onHistoryCleared,
}: HighlightReviewProps) {
  const groups = useMemo(() => groupProposalsByEmployee(proposals), [proposals]);
  const [fileIndex, setFileIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTrigger, setDraftTrigger] = useState('');
  const [draftComment, setDraftComment] = useState('');
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [rejectSaving, setRejectSaving] = useState(false);
  const [historySaveError, setHistorySaveError] = useState<string | null>(null);

  const [emailOffice, setEmailOffice] = useState<EmailReportOffice>(
    'eps-fresno-shop',
  );
  const fresnoDefaults = DEFAULT_EMAIL_PRESETS['eps-fresno-shop'];
  const [emailFrom, setEmailFrom] = useState(fresnoDefaults.from);
  const [emailTo, setEmailTo] = useState(fresnoDefaults.to.join(', '));
  const [emailCc, setEmailCc] = useState(fresnoDefaults.cc.join(', '));
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);

  const safeIndex =
    groups.length === 0 ? 0 : Math.min(fileIndex, groups.length - 1);
  const current = groups[safeIndex];
  const counts = statusCounts(proposals);
  const currentCounts = current ? statusCounts(current.proposals) : null;
  const allResolved =
    proposals.length === 0 ||
    proposals.every((p) => p.status === 'accepted' || p.status === 'deleted');

  useEffect(() => {
    const presets = loadEmailPresets();
    const preset = presets[emailOffice];
    setEmailFrom(preset.from);
    setEmailTo(preset.to.join(', '));
    setEmailCc(preset.cc.join(', '));
    setEmailSubject(
      buildTimesheetSubject(emailOffice, periodStart, periodEnd),
    );
    setEmailBody(
      buildTimesheetBody({
        greetingName:
          preset.greetingName || OFFICE_GREETING_NAME[emailOffice],
        periodStart,
        periodEnd,
        senderDisplayName:
          preset.senderFirstName || OFFICE_SENDER_FIRST_NAME[emailOffice],
      }),
    );
    setEmailError(null);
    setEmailSuccess(null);
  }, [emailOffice, periodStart, periodEnd]);

  const persistDecision = async (
    proposal: HighlightProposal,
    status: 'accepted' | 'deleted',
  ) => {
    if (!periodStart || !periodEnd) {
      throw new Error('Missing report period — cannot save review history.');
    }
    const entry = await saveReviewHistoryEntry({
      proposal: { ...proposal, status },
      periodStart,
      periodEnd,
      status,
    });
    onHistoryPersisted?.(entry);
  };

  const updateProposal = (
    id: string,
    patch: Partial<
      Pick<HighlightProposal, 'status' | 'comment' | 'triggerText'>
    >,
  ) => {
    onChange(proposals.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const acceptProposal = async (proposal: HighlightProposal) => {
    const accepted = { ...proposal, status: 'accepted' as const };
    updateProposal(proposal.id, { status: 'accepted' });
    try {
      await persistDecision(accepted, 'accepted');
    } catch (e) {
      setHistorySaveError(
        e instanceof Error ? e.message : 'Failed to save accept history.',
      );
    }
  };

  const restoreProposal = async (proposal: HighlightProposal) => {
    updateProposal(proposal.id, { status: 'pending' });
    if (!periodStart || !periodEnd) return;
    try {
      await clearReviewHistoryEntry({
        proposal,
        periodStart,
        periodEnd,
      });
      onHistoryCleared?.(proposal);
    } catch (e) {
      setHistorySaveError(
        e instanceof Error ? e.message : 'Failed to restore highlight.',
      );
    }
  };

  const acceptAllOnFile = () => {
    if (!current) return;
    const ids = new Set(current.proposals.map((p) => p.id));
    const toAccept = current.proposals.filter((p) => p.status === 'pending');
    onChange(
      proposals.map((p) =>
        ids.has(p.id) && p.status === 'pending'
          ? { ...p, status: 'accepted' }
          : p,
      ),
    );
    void Promise.all(
      toAccept.map((p) =>
        persistDecision({ ...p, status: 'accepted' }, 'accepted').catch(
          () => undefined,
        ),
      ),
    );
  };

  const deleteProposal = async (proposal: HighlightProposal) => {
    const deleted = { ...proposal, status: 'deleted' as const };
    updateProposal(proposal.id, { status: 'deleted' });
    try {
      await persistDecision(deleted, 'deleted');
    } catch (e) {
      setHistorySaveError(
        e instanceof Error ? e.message : 'Failed to save delete history.',
      );
    }
  };

  const deleteAllOnFile = async () => {
    if (!current) return;
    setRejectSaving(true);
    setHistorySaveError(null);
    try {
      const ids = new Set(current.proposals.map((p) => p.id));
      const toDelete = current.proposals.filter((p) => p.status !== 'deleted');
      onChange(
        proposals.map((p) =>
          ids.has(p.id) ? { ...p, status: 'deleted' } : p,
        ),
      );
      await Promise.all(
        toDelete.map((p) =>
          persistDecision({ ...p, status: 'deleted' }, 'deleted').catch(
            () => undefined,
          ),
        ),
      );
    } finally {
      setRejectSaving(false);
      setBulkRejectOpen(false);
    }
  };

  const scheduledPreview = formatScheduledSendLabel(nextEightAmPacific());

  const handleSendEmail = async (sendNow: boolean) => {
    if (!onSendEmail) return;
    setEmailError(null);
    setEmailSuccess(null);
    const to = parseEmailList(emailTo);
    const cc = parseEmailList(emailCc);
    if (to.length === 0) {
      setEmailError('Add at least one To address.');
      return;
    }
    const subject =
      emailSubject.trim() ||
      buildTimesheetSubject(emailOffice, periodStart, periodEnd);
    const body =
      emailBody.trim() ||
      buildTimesheetBody({
        greetingName: OFFICE_GREETING_NAME[emailOffice],
        periodStart,
        periodEnd,
        senderDisplayName: OFFICE_SENDER_FIRST_NAME[emailOffice],
      });
    saveEmailPreset({
      office: emailOffice,
      from: emailFrom.trim() || DEFAULT_EMAIL_PRESETS[emailOffice].from,
      to,
      cc,
      greetingName: OFFICE_GREETING_NAME[emailOffice],
      senderFirstName: OFFICE_SENDER_FIRST_NAME[emailOffice],
    });
    const zipFilename = buildTimesheetZipFilename(
      emailOffice,
      periodStart,
      periodEnd,
    );
    try {
      const result = await onSendEmail({
        office: emailOffice,
        to,
        cc,
        subject,
        body,
        zipFilename,
        sendNow,
      });
      if (sendNow || !result?.scheduledAt) {
        setEmailSuccess(`Sent now to ${to.join(', ')}`);
      } else {
        setEmailSuccess(
          `Scheduled to ${to.join(', ')} — ${formatScheduledSendLabel(result.scheduledAt)}`,
        );
      }
    } catch (e) {
      setEmailError(e instanceof Error ? e.message : 'Failed to send email.');
    }
  };

  const fieldClass =
    'mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-800';

  const emailPanel = onSendEmail ? (
    <div className="mt-3 w-full max-w-md rounded-lg border border-gray-200 bg-white p-3 text-left">
      <p className="text-sm font-semibold text-gray-900">Send email</p>
      <label className="mt-2 block text-xs font-medium text-gray-600">
        Office
        <select
          value={emailOffice}
          onChange={(e) =>
            setEmailOffice(e.target.value as EmailReportOffice)
          }
          className={fieldClass}
        >
          {EMAIL_REPORT_OFFICES.map((office) => (
            <option key={office} value={office}>
              {officeEmailLabel(office)}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-xs font-medium text-gray-600">
        From
        <input
          type="text"
          value={emailFrom}
          onChange={(e) => setEmailFrom(e.target.value)}
          className={fieldClass}
        />
      </label>
      <p className="mt-1 text-[11px] text-gray-500">
        Sends as the signed-in Microsoft account (From is for your reference).
      </p>
      <label className="mt-2 block text-xs font-medium text-gray-600">
        To
        <input
          type="text"
          value={emailTo}
          onChange={(e) => setEmailTo(e.target.value)}
          placeholder="name@epsfresno.com"
          className={fieldClass}
        />
      </label>
      <label className="mt-2 block text-xs font-medium text-gray-600">
        Cc
        <input
          type="text"
          value={emailCc}
          onChange={(e) => setEmailCc(e.target.value)}
          placeholder="name@epsfresno.com, other@epsfresno.com"
          className={fieldClass}
        />
      </label>
      <label className="mt-2 block text-xs font-medium text-gray-600">
        Subject
        <input
          type="text"
          value={emailSubject}
          onChange={(e) => setEmailSubject(e.target.value)}
          className={fieldClass}
        />
      </label>
      <label className="mt-2 block text-xs font-medium text-gray-600">
        Body
        <textarea
          rows={6}
          value={emailBody}
          onChange={(e) => setEmailBody(e.target.value)}
          className={`${fieldClass} resize-y`}
        />
      </label>
      <p className="mt-2 text-xs text-gray-600">
        <strong>Schedule</strong> sends at{' '}
        <span className="font-medium">{scheduledPreview}</span>.{' '}
        <strong>Send</strong> delivers immediately.
      </p>
      {emailError && (
        <p className="mt-2 text-xs text-red-600">{emailError}</p>
      )}
      {emailSuccess && (
        <p className="mt-2 text-xs text-green-700">{emailSuccess}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            void handleSendEmail(true);
          }}
          disabled={
            !allResolved ||
            downloadDisabled ||
            downloading ||
            sendingEmail ||
            !periodStart ||
            !periodEnd
          }
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sendingEmail ? 'Working…' : 'Send now'}
        </button>
        <button
          type="button"
          onClick={() => {
            void handleSendEmail(false);
          }}
          disabled={
            !allResolved ||
            downloadDisabled ||
            downloading ||
            sendingEmail ||
            !periodStart ||
            !periodEnd
          }
          className="rounded-md border border-emerald-700 bg-white px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sendingEmail ? 'Working…' : 'Schedule (8 AM PT)'}
        </button>
      </div>
    </div>
  ) : null;

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
        {emailPanel}
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

      {historySaveError && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {historySaveError}
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
              setHistorySaveError(null);
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
          <p className="mt-1 text-xs text-gray-600">
            They will show as deleted next time you run this same period.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={rejectSaving}
              onClick={() => void deleteAllOnFile()}
              className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rejectSaving ? 'Saving…' : 'Confirm delete'}
            </button>
            <button
              type="button"
              disabled={rejectSaving}
              onClick={() => setBulkRejectOpen(false)}
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
                        const nextTrigger =
                          draftTrigger.trim() ||
                          item.triggerText ||
                          item.matchedText;
                        const nextComment = draftComment.trim() || item.comment;
                        const updated = {
                          ...item,
                          triggerText: nextTrigger,
                          comment: nextComment,
                          status: 'accepted' as const,
                        };
                        updateProposal(item.id, {
                          triggerText: nextTrigger,
                          comment: nextComment,
                          status: 'accepted',
                        });
                        setEditingId(null);
                        void persistDecision(updated, 'accepted').catch((e) => {
                          setHistorySaveError(
                            e instanceof Error
                              ? e.message
                              : 'Failed to save accept history.',
                          );
                        });
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
                  {item.status === 'deleted' ? (
                    <button
                      type="button"
                      onClick={() => void restoreProposal(item)}
                      className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
                    >
                      Restore to pending
                    </button>
                  ) : item.status === 'accepted' ? (
                    <>
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
                        onClick={() => {
                          setHistorySaveError(null);
                          void deleteProposal(item);
                        }}
                        className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void acceptProposal(item)}
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
                        onClick={() => {
                          setHistorySaveError(null);
                          void deleteProposal(item);
                        }}
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
          {allResolved ? emailPanel : null}
        </div>
      </div>
    </div>
  );
}
