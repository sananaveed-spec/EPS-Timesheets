import type { ClockifyRow, PivotData, PivotRow } from '../types';

function parseDate(dateStr: string): Date | null {
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return null;
  const month = parseInt(parts[0], 10);
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (isNaN(month) || isNaN(day) || isNaN(year)) return null;
  const d = new Date(year, month - 1, day);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeDateKey(dateStr: string): string {
  const d = parseDate(dateStr);
  if (!d) return dateStr.trim();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const y = d.getFullYear();
  return `${m}/${day}/${y}`;
}

function formatDateLabel(dateStr: string): string {
  const d = parseDate(dateStr);
  if (!d) return dateStr;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = days[d.getDay()];
  return `${dayName}, ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function getDuration(row: ClockifyRow): number {
  const dec = row['Duration (decimal)'];
  if (dec !== undefined && dec !== '') {
    const v = parseFloat(dec);
    if (!isNaN(v)) return v;
  }
  const h = row['Duration (h)'];
  if (h) {
    const parts = h.split(':');
    if (parts.length >= 1) {
      const hrs = parseFloat(parts[0]) || 0;
      const mins = (parseFloat(parts[1]) || 0) / 60;
      const secs = (parseFloat(parts[2]) || 0) / 3600;
      return hrs + mins + secs;
    }
  }
  return 0;
}

function normalizeHours(value: number): number {
  // Trim floating-point noise from summed decimal hour values.
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function getLastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function toDateKey(d: Date): string {
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const y = d.getFullYear();
  return `${m}/${day}/${y}`;
}

/** Accepts ISO `YYYY-MM-DD` or `M/D/YYYY` and returns a local Date at midnight. */
function parseFlexibleDate(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  if (!trimmed) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10);
    const day = parseInt(iso[3], 10);
    const d = new Date(year, month - 1, day);
    return isNaN(d.getTime()) ? null : d;
  }
  return parseDate(trimmed);
}

export function getDatesInRange(startDate: string, endDate: string): string[] | null {
  const start = parseFlexibleDate(startDate);
  const end = parseFlexibleDate(endDate);
  if (!start || !end || start.getTime() > end.getTime()) return null;
  const dates: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endTime = end.getTime();
  while (cursor.getTime() <= endTime) {
    dates.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function getUniqueDatesFromCsv(rows: ClockifyRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = normalizeDateKey(row['Start Date']?.trim() || '');
    if (key) seen.add(key);
  }
  const dates = Array.from(seen).sort((a, b) => {
    const da = parseDate(a)?.getTime() ?? 0;
    const db = parseDate(b)?.getTime() ?? 0;
    return da - db;
  });
  if (dates.length > 0) return dates;
  const now = new Date();
  const lastDay = getLastDayOfMonth(now.getFullYear(), now.getMonth() + 1);
  const fallback: string[] = [];
  for (let day = 1; day <= lastDay; day++) {
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    fallback.push(`${m.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${y}`);
  }
  return fallback;
}

export type TransformDateRange = {
  startDate: string;
  endDate: string;
};

export function transformToPivot(
  rows: ClockifyRow[],
  dateRange?: TransformDateRange,
): PivotData {
  // Detail table columns: only days that have time entries.
  const dates = getUniqueDatesFromCsv(rows);
  const dateLabels = dates.map(formatDateLabel);

  const rangeDates = dateRange
    ? getDatesInRange(dateRange.startDate, dateRange.endDate)
    : null;
  const periodStart =
    rangeDates && rangeDates.length > 0 ? rangeDates[0] : dates[0];
  const periodEnd =
    rangeDates && rangeDates.length > 0
      ? rangeDates[rangeDates.length - 1]
      : dates[dates.length - 1];

  const pivotRows: PivotRow[] = [];

  const byUser = new Map<string, ClockifyRow[]>();
  for (const row of rows) {
    const user = row.User?.trim() || 'Unknown';
    if (!byUser.has(user)) byUser.set(user, []);
    byUser.get(user)!.push(row);
  }

  const sortedUsers = Array.from(byUser.keys()).sort();

  for (const user of sortedUsers) {
    const userRows = byUser.get(user)!;

    pivotRows.push({
      label: user,
      indentLevel: 0,
      dateValues: {},
      grandTotal: 0,
    });

    type DateValues = Record<string, number>;
    const byProject = new Map<string, Map<string, Map<string, DateValues>>>();

    for (const row of userRows) {
      const project = row.Project?.trim() || 'Unknown';
      const tags = row.Tags?.trim() || '';
      const desc = row.Description?.trim() || '(No description)';
      const startDate = normalizeDateKey(row['Start Date']?.trim() || '');
      const duration = getDuration(row);
      if (!startDate) continue;

      if (!byProject.has(project)) {
        byProject.set(project, new Map());
      }
      const byTags = byProject.get(project)!;
      const tagKey = tags || project;
      if (!byTags.has(tagKey)) {
        byTags.set(tagKey, new Map());
      }
      const byDesc = byTags.get(tagKey)!;
      if (!byDesc.has(desc)) {
        byDesc.set(desc, {} as DateValues);
      }
      const dateMap = byDesc.get(desc)!;
      dateMap[startDate] = normalizeHours((dateMap[startDate] || 0) + duration);
    }

    const sortedProjects = [...byProject.entries()].sort((a, b) => {
      const aStar = a[0].startsWith('*') ? 0 : 1;
      const bStar = b[0].startsWith('*') ? 0 : 1;
      if (aStar !== bStar) return aStar - bStar;
      return a[0].localeCompare(b[0]);
    });

    for (const [project, byTags] of sortedProjects) {
      pivotRows.push({
        label: project,
        indentLevel: 1,
        dateValues: {},
        grandTotal: 0,
      });

      for (const [tagKey, byDesc] of byTags) {
        const showTags = tagKey !== project ? tagKey : null;
        if (showTags) {
          pivotRows.push({
            label: showTags,
            indentLevel: 2,
            dateValues: {},
            grandTotal: 0,
          });
        }

        for (const [desc, dateMap] of byDesc) {
          const total = Object.values(dateMap).reduce((a, b) => a + b, 0);
          const dateValues: Record<string, number> = {};
          for (const d of dates) {
            dateValues[d] = dateMap[d] ?? 0;
          }
          pivotRows.push({
            label: desc,
            indentLevel: 2,
            dateValues,
            grandTotal: total,
          });
        }
      }
    }

    const userDateTotals: Record<string, number> = {};
    for (const d of dates) userDateTotals[d] = 0;
    let userGrandTotal = 0;
    for (const row of userRows) {
      const sd = normalizeDateKey(row['Start Date']?.trim() || '');
      const dur = getDuration(row);
      if (sd) userDateTotals[sd] = normalizeHours((userDateTotals[sd] || 0) + dur);
      userGrandTotal = normalizeHours(userGrandTotal + dur);
    }

    pivotRows.push({
      label: `${user} Total`,
      indentLevel: 0,
      dateValues: userDateTotals,
      grandTotal: userGrandTotal,
      isEmployeeTotal: true,
    });
  }

  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const firstDate = dates[0] ? parseDate(dates[0]) : new Date();
  const month = firstDate ? monthNames[firstDate.getMonth()] : 'REPORT';
  const printedDate = new Date();
  const reportTitle = `${month} REV1 PRINTED ${printedDate.getMonth() + 1}/${printedDate.getDate()}/${printedDate.getFullYear()}`;

  return {
    dates,
    dateLabels,
    rows: pivotRows,
    reportTitle,
    periodStart,
    periodEnd,
  };
}
