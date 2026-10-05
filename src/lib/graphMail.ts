import type { IPublicClientApplication } from '@azure/msal-browser';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { mailRequest } from '../auth/authConfig';

/** Matches Outlook “Language and time” for Abdur’s mailbox. */
export const MAILBOX_TIME_ZONE = 'America/Los_Angeles';

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function mailConsentHint(message: string): string {
  return `${message} In Azure: App registration → API permissions → Microsoft Graph → delegated Mail.Send and Mail.ReadWrite → Grant admin consent. Then Logout and Sign in again.`;
}

/** Next 8:00 AM in Pacific Time (today if still before 8 AM, else tomorrow). */
export function nextEightAmPacific(now = new Date()): Date {
  const zonedNow = toZonedTime(now, MAILBOX_TIME_ZONE);
  const targetLocal = new Date(zonedNow);
  targetLocal.setHours(8, 0, 0, 0);
  if (zonedNow.getTime() >= targetLocal.getTime()) {
    targetLocal.setDate(targetLocal.getDate() + 1);
  }
  return fromZonedTime(targetLocal, MAILBOX_TIME_ZONE);
}

export function formatScheduledSendLabel(when: Date): string {
  return formatInTimeZone(
    when,
    MAILBOX_TIME_ZONE,
    "EEE M/d/yyyy 'at' h:mm a 'Pacific'",
  );
}

/** Graph SystemTime string for PidTagDeferredSendTime (0x3FEF). */
function toGraphSystemTime(when: Date): string {
  return when.toISOString().replace(/\.\d{3}Z$/, '.0000000Z');
}

export async function acquireMailAccessToken(
  instance: IPublicClientApplication,
): Promise<string> {
  const account =
    instance.getActiveAccount() ?? instance.getAllAccounts()[0] ?? null;
  if (!account) {
    throw new Error('Sign in again before sending email.');
  }

  try {
    const result = await instance.acquireTokenSilent({
      ...mailRequest,
      account,
    });
    return result.accessToken;
  } catch (silentError) {
    const detail =
      silentError instanceof Error ? silentError.message : 'Mail permission needed';
    sessionStorage.setItem('clockify-converter-pending-mail-consent', '1');
    await instance.acquireTokenRedirect({
      ...mailRequest,
      account,
    });
    throw new Error(
      mailConsentHint(
        `${detail}. Redirecting to Microsoft to grant mail permissions…`,
      ),
    );
  }
}

export interface SendTimesheetMailOptions {
  accessToken: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachment: {
    filename: string;
    blob: Blob;
  };
  /** When true, send immediately. When false/omitted, schedule for sendAt / next 8 AM PT. */
  sendNow?: boolean;
  /** Defaults to next 8:00 AM Pacific when not sendNow. */
  sendAt?: Date;
}

async function graphJson<T>(
  accessToken: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const err = (await response.json()) as {
        error?: { message?: string };
      };
      detail = err.error?.message ?? '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(
      detail
        ? `Email failed: ${detail}`
        : `Email failed (${response.status}).`,
    );
  }
  if (response.status === 202 || response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function messagePayload(options: {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  filename: string;
  contentBytes: string;
  deferredSendAt?: Date;
}) {
  const message: Record<string, unknown> = {
    subject: options.subject,
    body: {
      contentType: 'Text',
      content: options.body,
    },
    toRecipients: options.to.map((address) => ({
      emailAddress: { address },
    })),
    ccRecipients: options.cc.map((address) => ({
      emailAddress: { address },
    })),
    attachments: [
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: options.filename,
        contentType: 'application/zip',
        contentBytes: options.contentBytes,
      },
    ],
  };
  if (options.deferredSendAt) {
    message.singleValueExtendedProperties = [
      {
        id: 'SystemTime 0x3FEF',
        value: toGraphSystemTime(options.deferredSendAt),
      },
    ];
  }
  return message;
}

/**
 * Sends immediately via sendMail, or creates a deferred-send draft then sends.
 * Requires Mail.Send; scheduled path also needs Mail.ReadWrite.
 */
export async function sendTimesheetMail(
  options: SendTimesheetMailOptions,
): Promise<{ scheduledAt: Date | null }> {
  const { accessToken, to, cc, subject, body, attachment } = options;
  if (to.length === 0) {
    throw new Error('Add at least one To address.');
  }

  const contentBytes = await blobToBase64(attachment.blob);

  if (options.sendNow) {
    await graphJson<void>(
      accessToken,
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        method: 'POST',
        body: JSON.stringify({
          message: messagePayload({
            to,
            cc,
            subject,
            body,
            filename: attachment.filename,
            contentBytes,
          }),
          saveToSentItems: true,
        }),
      },
    );
    return { scheduledAt: null };
  }

  const scheduledAt = options.sendAt ?? nextEightAmPacific();

  const draft = await graphJson<{ id: string }>(
    accessToken,
    'https://graph.microsoft.com/v1.0/me/messages',
    {
      method: 'POST',
      body: JSON.stringify(
        messagePayload({
          to,
          cc,
          subject,
          body,
          filename: attachment.filename,
          contentBytes,
          deferredSendAt: scheduledAt,
        }),
      ),
    },
  );

  if (!draft?.id) {
    throw new Error('Email failed: draft was not created.');
  }

  await graphJson<void>(
    accessToken,
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draft.id)}/send`,
    { method: 'POST', body: '{}' },
  );

  return { scheduledAt };
}
