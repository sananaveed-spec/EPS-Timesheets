import { format, parseISO, isValid } from 'date-fns';
import { OFFICE_CATEGORY_LABELS } from './officeCategories';
import type { OfficeCategory } from './officeCategories';

/** Offices that can receive timesheet ZIP emails. */
export type EmailReportOffice =
  | 'eps-clovis-office'
  | 'eps-fresno-shop';

export const EMAIL_REPORT_OFFICES: EmailReportOffice[] = [
  'eps-clovis-office',
  'eps-fresno-shop',
];

export function isEmailReportOffice(
  value: unknown,
): value is EmailReportOffice {
  return value === 'eps-clovis-office' || value === 'eps-fresno-shop';
}

/** Fixed recipients for every timesheet email. */
export const HARDCODED_FROM_EMAIL = 'abdur@epsfresno.com';
export const HARDCODED_TO_EMAIL = 'abdur@epsfresno.com';
export const HARDCODED_CC_EMAIL = 'sana@epsfresno.com';
export const FRESNO_SHOP_CC_EMAILS = [
  HARDCODED_CC_EMAIL,
  'joni@epsfresno.com',
] as const;
export const CLOVIS_OFFICE_CC_EMAILS = [
  HARDCODED_CC_EMAIL,
  'zulfi@epsfresno.com',
] as const;
export const HARDCODED_SENDER_FIRST_NAME = 'Abdur';

/** Body greeting per office (matches existing timesheet email templates). */
export const OFFICE_GREETING_NAME: Record<EmailReportOffice, string> = {
  'eps-fresno-shop': 'Joni',
  'eps-clovis-office': 'Zulfi',
};

export interface OfficeEmailPreset {
  office: EmailReportOffice;
  to: string[];
  cc: string[];
  greetingName: string;
}

export const DEFAULT_EMAIL_PRESETS: Record<
  EmailReportOffice,
  OfficeEmailPreset
> = {
  'eps-fresno-shop': {
    office: 'eps-fresno-shop',
    to: [HARDCODED_TO_EMAIL],
    cc: [...FRESNO_SHOP_CC_EMAILS],
    greetingName: OFFICE_GREETING_NAME['eps-fresno-shop'],
  },
  'eps-clovis-office': {
    office: 'eps-clovis-office',
    to: [HARDCODED_TO_EMAIL],
    cc: [...CLOVIS_OFFICE_CC_EMAILS],
    greetingName: OFFICE_GREETING_NAME['eps-clovis-office'],
  },
};

export function officeEmailLabel(office: EmailReportOffice): string {
  return OFFICE_CATEGORY_LABELS[office as OfficeCategory];
}

function parseReportDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const d = parseISO(trimmed);
    return isValid(d) ? d : null;
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (us) {
    const d = new Date(
      parseInt(us[3], 10),
      parseInt(us[1], 10) - 1,
      parseInt(us[2], 10),
    );
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

/** e.g. Sep1-27 */
export function formatShortDateRange(
  periodStart: string,
  periodEnd: string,
): string {
  const start = parseReportDate(periodStart);
  const end = parseReportDate(periodEnd);
  if (!start || !end) return 'Timesheet';
  const startPart = format(start, 'MMMd');
  const endPart =
    start.getMonth() === end.getMonth()
      ? format(end, 'd')
      : format(end, 'MMMd');
  return `${startPart}-${endPart}`;
}

/** e.g. September 1–27, 2026 */
export function formatLongDateRange(
  periodStart: string,
  periodEnd: string,
): string {
  const start = parseReportDate(periodStart);
  const end = parseReportDate(periodEnd);
  if (!start || !end)
    return periodStart && periodEnd
      ? `${periodStart}–${periodEnd}`
      : 'the selected period';
  const year = format(end, 'yyyy');
  if (
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth()
  ) {
    return `${format(start, 'MMMM d')}–${format(end, 'd')}, ${year}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${format(start, 'MMMM d')}–${format(end, 'MMMM d')}, ${year}`;
  }
  return `${format(start, 'MMMM d, yyyy')}–${format(end, 'MMMM d, yyyy')}`;
}

export function buildTimesheetSubject(
  office: EmailReportOffice,
  periodStart: string,
  periodEnd: string,
): string {
  const short = formatShortDateRange(periodStart, periodEnd);
  const end = parseReportDate(periodEnd);
  const year = end ? format(end, 'yyyy') : '';
  const label = officeEmailLabel(office);
  return `${short}${year ? ` ${year}` : ''} Timesheet | ${label}`;
}

export function buildTimesheetZipFilename(
  office: EmailReportOffice,
  periodStart: string,
  periodEnd: string,
): string {
  const short = formatShortDateRange(periodStart, periodEnd);
  return `${short} ${officeEmailLabel(office)}.zip`;
}

export function buildTimesheetBody(opts: {
  greetingName: string;
  periodStart: string;
  periodEnd: string;
  senderDisplayName?: string;
}): string {
  const longPeriod = formatLongDateRange(opts.periodStart, opts.periodEnd);
  const firstName =
    opts.senderDisplayName?.trim().split(/\s+/)[0] ||
    HARDCODED_SENDER_FIRST_NAME;
  return `${opts.greetingName},

Have a look at the attached timesheet revision for the period of ${longPeriod}. Please review the comments and take action if needed.

Thanks,
${firstName}`;
}

export function fixedTimesheetRecipients(
  office?: EmailReportOffice,
): {
  from: string;
  to: string[];
  cc: string[];
} {
  return {
    from: HARDCODED_FROM_EMAIL,
    to: [HARDCODED_TO_EMAIL],
    cc:
      office === 'eps-fresno-shop'
        ? [...FRESNO_SHOP_CC_EMAILS]
        : office === 'eps-clovis-office'
          ? [...CLOVIS_OFFICE_CC_EMAILS]
          : [HARDCODED_CC_EMAIL],
  };
}

export function parseEmailList(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
