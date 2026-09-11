import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import JSZip from 'jszip';
import type { HighlightProposal } from './highlightRules';
import type {
  EmployeeCategory,
  ManagedUser,
  PivotData,
  PivotRow,
} from '../types';
import {
  DEFAULT_FULL_TIME_HOURLY,
  DEFAULT_FULL_TIME_SALARIED,
  DEFAULT_PART_TIME_HOURLY,
  normalizeEmployeeName,
} from './employeeCategories';
import { getDatesInRange } from './transformer';

//const MARGIN = 10;
//const COLUMN_WIDTH_ROW_LABELS = 94;

const MARGIN = 3;
//const COLUMN_WIDTH_ROW_LABELS = 50;

/** Review comments drawn below highlighted descriptions in the pivot table. */
const NOTE_FONT_SIZE = 8;
const NOTE_LINE_HEIGHT = 3.2;
/** Approximate characters that fit per note line at NOTE_FONT_SIZE. */
const NOTE_CHARS_PER_LINE = 90;

function buildCategorySets(managedUsers: ManagedUser[]) {
  const fullTimeSalaried = new Set<string>(DEFAULT_FULL_TIME_SALARIED);
  const fullTimeHourly = new Set<string>(DEFAULT_FULL_TIME_HOURLY);
  const partTimeHourly = new Set<string>(DEFAULT_PART_TIME_HOURLY);

  for (const user of managedUsers) {
    const normalizedName = normalizeEmployeeName(user.name);
    if (!normalizedName) continue;

    fullTimeSalaried.delete(normalizedName);
    fullTimeHourly.delete(normalizedName);
    partTimeHourly.delete(normalizedName);

    const targetSetByCategory: Record<EmployeeCategory, Set<string>> = {
      'full-time-salaried': fullTimeSalaried,
      'full-time-hourly': fullTimeHourly,
      'part-time-hourly': partTimeHourly,
    };
    targetSetByCategory[user.category].add(normalizedName);
  }

  return {
    fullTimeSalaried,
    fullTimeHourly,
    partTimeHourly,
    fullTimeEmployees: new Set([...fullTimeSalaried, ...fullTimeHourly]),
  };
}

function formatDecimal(n: number): string {
  return parseFloat(n.toFixed(1)).toString();
}

function roundHoursForReport(n: number): number {
  return parseFloat(n.toFixed(1));
}

function rowToTableCells(pr: PivotRow | null, dates: string[]): (string | number)[] {
  const emptyRow = ['', ...dates.map(() => ''), ''];
  if (!pr) return emptyRow;
  const indent = '  '.repeat(pr.indentLevel);
  const label = pr.isEmployeeTotal ? pr.label : indent + pr.label;
  const dateVals = dates.map((d) => {
    const v = pr.dateValues[d];
    return v !== undefined && v !== 0 ? formatDecimal(v) : '';
  });
  const gt = pr.grandTotal !== 0 ? formatDecimal(pr.grandTotal) : '';
  return [label, ...dateVals, gt];
}

function isNewUserStart(row: PivotRow): boolean {
  return row.indentLevel === 0 && !row.isEmployeeTotal;
}

function splitRowsByUser(rows: PivotRow[]): { name: string; rows: PivotRow[] }[] {
  const sections: { name: string; rows: PivotRow[] }[] = [];
  let current: PivotRow[] = [];
  let currentName = '';

  for (const row of rows) {
    if (isNewUserStart(row) && current.length > 0) {
      sections.push({ name: currentName, rows: current });
      current = [];
    }
    if (isNewUserStart(row)) {
      currentName = row.label;
    }
    current.push(row);
  }
  if (current.length > 0) sections.push({ name: currentName, rows: current });

  return sections;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'employee';
}

function getVerticalDateLabel(dateStr: string): string {
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return dateStr;
  const month = parseInt(parts[0], 10);
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  const d = new Date(year, month - 1, day);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const shortYear = year % 100;
  return `${dayNames[d.getDay()]}, ${month}/${day}/${shortYear}`;
}

function formatDateForReport(dateStr: string): string {
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return dateStr;
  const month = parseInt(parts[0], 10);
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  const d = new Date(year, month - 1, day);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${dayNames[d.getDay()]}, ${month}/${day}/${year}`;
}

function formatDateForTimePeriod(dateStr: string): string {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return dateStr;
  const month = parseInt(parts[0], 10);
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (month < 1 || month > 12) return dateStr;
  return `${day}-${monthNames[month - 1]}-${year}`;
}

interface CompTimeEntry {
  date: string;
  hours: number;
}

interface AccruedPTOEntry {
  date: string;
  reportingHours: number;
  accruedPTO: number;
  reason: string;
}

interface TimesheetNeedsFilledEntry {
  date: string;
  hoursReported: number;
  hoursNeeded: number;
}

interface ReviewEntry {
  date: string;
  project: string;
  tag: string;
  description: string;
}

function isTravelOnSite(description: string): boolean {
  const d = description.toLowerCase().trim();

  if (d.includes('preparation for site visit')) return false;

  if (d.includes('in-office') || d.includes('in office') || /\bin\s+the\s+office\b/.test(d)) return false;
  if (d.includes('worked in the office') || d.includes('shop and office')) return false;
  if (d.includes('no miles required') || d.includes('there is no miles required')) return false;

  // Personal trips (restaurant, lunch, etc.) do not need miles.
  if (
    /\brestaurants?\b/i.test(d) ||
    /\brestraunts?\b/i.test(d) ||
    /\bresturants?\b/i.test(d) ||
    /\b(?:lunch|dinner|breakfast|brunch)\b/i.test(d) ||
    /\b(?:cafe|coffee\s+shop|starbucks)\b/i.test(d) ||
    /\bpersonal\s+(?:errand|trip|time|business)\b/i.test(d) ||
    /\bwent\s+(?:home|to\s+home)\b/i.test(d) ||
    /\b(?:grocery|groceries|bank|gym)\b/i.test(d)
  ) {
    return false;
  }

  const planningPatterns = [
    /\bwill\s+(schedule|go|visit|travel)\b/,
    /\bschedule\s+time\s+to\s+go\b/,
    /\bplan(ning)?\s+to\s+(go|visit|travel)\b/,
    /\bgoing\s+to\s+go\s+on[- ]?site\b/,
    /\bto\s+go\s+on[- ]?site\s+sometime\b/,
    /\bsometime\s+next\s+(week|month)\b/,
    /\bnext\s+week\s+or\s+the\s+week\s+after\b/,
    /\b(coordinated|coordinate|scheduled|schedule)\s+.*\b(go|on[- ]?site|visit)\b/,
    /\bworking\s+on\s+.*\b(potential\s+)?site\s+visit\b/,
    /\bfor\s+potential\s+site\s+visit\b/,
    /\bsetting\s+up\s+site\s+visit\b/,
    /\b(lined\s+up|line\s+up|lining\s+up)\b.*\bjob\s+walk\b/,
  ];
  if (planningPatterns.some((p) => p.test(d))) return false;

  const officeWorkPatterns = [
    /\breviewed\s+the\s+report\s+for\s+the\s+job\b/,
    /\bwent\s+over\s+the\s+hours\b/,
    /\bgot\s+the\s+billing\s+figured\s+out\b/,
    /\bbilling\s+figured\s+out\b.*\binvoic/,
    /\bnot\s+any\s+visit\s+outside\b/,
    /\bwent\s+over\s+times\s+and\s+dates\b/,
    /\bgot\s+dates\s+nailed\s+down\b/,
    /\bpertinent\s+information\s+to\s+the\s+customer\b/,
    /\bworked\s+in\s+the\s+morning\s+with\b/,
    /\bbefore\s+(they|he|she)\s+went\s+to\b/,
    /\bbefore\s+(they|he|she)\s+went\s+on[- ]?site\b/,
    /\bwent\s+over\s+(the\s+)?(work|procedure|upcoming|projects|emails?|plans?|jobs?)\b/,
    /\bputting\s+the\s+jobs?\s+together\b/,
    /\bemails?\s+and\s+job\s+coordination\b/,
    /\bplanning\s+documentation\b/,
    /\bnot\s+a\s+site\s+visit\b/,
    /\bgo\s+over\s+(projects?|work|procedure)\b/,
    /\bwent\s+through\s+e[- ]?mails?\b/,
    /\bwent\s+through\s+.*\blist\b/,
    /\bwent\s+through\s+.*\blists\b/,
    /\bwent\s+through\s+.*\b(report|video|videos|problem|study)\b/,
    /\bread\s+through\b/,
    /\bsent\s+(the\s+)?\w+\s+to\b/,
    /\bpicked\s+up\s+from\s+\w+\s+by\s+\w+\b/,
    /\bperformed\s+(testing|inspection)\b.*\b(picked\s+up|by\s+\w+)\b/,
    /\breview\s+(the\s+)?(design\s+and\s+)?site\s+visit\s+photos\b/,
    /\bafter\s+site\s+visit\b/,
    /\bprovide\s+responses\s+to\s+client\b/,
    /\bwent\s+through\s+every\s+relevant\s+xref\b/,
    /\blabeled\s+the\s+equipment\s+on\s+the\s+site\s+plans\b/,
    /\bleft\s+over\s+time\s+form\s+working\s+on\b/,
    /\breview\s+my\s+mark\s*ups?\s+and\s+comments\b/,
    /\btrying\s+to\s+clear\s+up\s+some\s+confusion\b/,
    /\bcomparing\s+my\s+updated\s+sheet\s+sets\b/,
    /\btrying\s+to\s+see\s+what\s+difference\s+was\s+made\s+in\s+the\s+xref\b/,
    /\bspent\s+a\s+little\s+more\s+time\s+than\s+i\s+should\s+have\b/,
    /\bwent\s+over\s+items\s+with\b.*\bhiring\s+an\s+office\s+manger\b/,
    /\bgot\s+a\s+call\s+from\s+the\s+clovis\s+office\b/,
    /\bordered\s+those\s+items\b/,
    /\bsent\s+joe\s+a\s+statement\b.*\bcity\s+of\s+fresno\b.*\bsubstation\s+project\b/,
    /\breviewing\s+\d+%?\s+drawing\b.*\bsis\b.*\brecommendations\b/,
    /\bdiscussion\s+with\b.*\bregarding\s+the\s+site\s+walk\b/,
    /\bmeeting\s+with\b.*\bto\s+go\s+over\b/,
    /\bgo\s+over\s+the\s+changes\s+required\b/,
    /\bsystem\s+configuration\b/,
    /\bplan\s+set\b/,
  ];
  if (officeWorkPatterns.some((p) => p.test(d))) return false;

  const travelPatterns = [
    /\bjob\s+walk\b/,
    /\bon[- ]?site\s+for\b/,
    /\bon[- ]?site\s*:/,
    /\bsite\s+visit\b/,
    /\bsite\s+walk\b/,
    /\bwent\s+to\s+(?!over\b)/,
    /\bwent\s+on[- ]?site\b/,
    /\btravel\s+to\b/,
    /\btravel\s+and\b/,
    /\bdrove\b/,
    /\bdriving\b/,
    /\bdrove\s+to\b/,
    /\bsite\s*:/,
    /\bgo\s+over\b.*\bat\s+(site|job|facility|plant|substation|project)\b/,
    /\b(at|to)\s+[\w\s]+\s+(for|to)\s+(meeting|job|visit|drop|gather|data)/,
  ];
  return travelPatterns.some((p) => p.test(d));
}

function isHolidayLeaveContext(value: string): boolean {
  const normalized = value.toUpperCase();
  if (!normalized.includes('HOLIDAY')) return false;

  // Avoid misclassifying hotel names like "Holiday Inn" as holiday leave.
  if (/\bHOLIDAY\s+INN\b/.test(normalized)) return false;

  return /\bHOLIDAY\b/.test(normalized);
}

function isFmlaLeaveContext(value: string): boolean {
  return /\bFMLA\b/.test(value.toUpperCase());
}

function hasMiles(description: string): boolean {
  return /\d+\s*(total\s+)?miles?\b|miles?\s*\d+|\d+\s*mi\b/i.test(description);
}

function isSiteSurveyTag(tag: string): boolean {
  return tag.trim().toUpperCase() === '101 - SITE SURVEY';
}

interface ReportCard {
  totalHours: number;
  sickHours: number;
  ptoHours: number;
  accruedPTOApplies: boolean;
  accruedPTOTime: AccruedPTOEntry[];
  timesheetNeedsFilled: TimesheetNeedsFilledEntry[];
  timesheetRuleApplies: boolean;
  sickTime: CompTimeEntry[];
  ptoTime: CompTimeEntry[];
  compTime: CompTimeEntry[];
  compTimeAccrued: CompTimeEntry[];
  compTimeApplies: boolean;
  overtimeTime: CompTimeEntry[];
  overtimeApplies: boolean;
  reviewNeeded: ReviewEntry[];
}

function isFullTimeEmployee(
  employeeName: string,
  categorySets: ReturnType<typeof buildCategorySets>
): boolean {
  const baseName = normalizeEmployeeName(employeeName);
  if (categorySets.fullTimeEmployees.has(baseName)) return true;
  return /^Kathy\b/i.test(baseName);
}

function isFullTimeHourly(
  employeeName: string,
  categorySets: ReturnType<typeof buildCategorySets>
): boolean {
  const baseName = normalizeEmployeeName(employeeName);
  if (categorySets.fullTimeHourly.has(baseName)) return true;
  return /^Kathy\b/i.test(baseName);
}

function isFullTimeSalaried(
  employeeName: string,
  categorySets: ReturnType<typeof buildCategorySets>
): boolean {
  const baseName = normalizeEmployeeName(employeeName);
  return categorySets.fullTimeSalaried.has(baseName);
}

function isPartTimeHourly(
  employeeName: string,
  categorySets: ReturnType<typeof buildCategorySets>
): boolean {
  const baseName = normalizeEmployeeName(employeeName);
  if (categorySets.partTimeHourly.has(baseName)) return true;
  return /^Jacob\b/i.test(baseName);
}

function isWeekday(dateStr: string): boolean {
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return false;
  const month = parseInt(parts[0], 10);
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  const d = new Date(year, month - 1, day);
  const dayOfWeek = d.getDay();
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

/** Mon–Fri dates in the selected period (includes days with 0 hours). */
function weekdaysInPeriod(
  periodStart: string | undefined,
  periodEnd: string | undefined,
  fallbackDates: string[],
): string[] {
  if (periodStart && periodEnd) {
    const range = getDatesInRange(periodStart, periodEnd);
    if (range && range.length > 0) {
      return range.filter(isWeekday);
    }
  }
  return fallbackDates.filter(isWeekday);
}

function computeReportCard(
  sectionRows: PivotRow[],
  dates: string[],
  employeeName: string,
  categorySets: ReturnType<typeof buildCategorySets>,
  periodStart?: string,
  periodEnd?: string,
): ReportCard {
  let totalHours = 0;
  let sickHours = 0;
  let ptoHours = 0;
  const timesheetNeedsFilled: TimesheetNeedsFilledEntry[] = [];
  const reviewNeeded: ReviewEntry[] = [];
  const sickByDate: Record<string, number> = {};
  const ptoByDate: Record<string, number> = {};
  const accruedPTOEligibleHoursByDate: Record<string, number> = {};
  const reportedHoursByDate: Record<string, number> = {};
  const accruedPTOExcludedHoursByDate: Record<string, number> = {};
  const accruedPTOExclusionReasonsByDate: Record<string, Set<string>> = {};
  const compByDate: Record<string, number> = {};
  let currentProjectLabel = '';
  let currentTag = '';

  const compAccruedByDate: Record<string, number> = {};
  const overtimeByDate: Record<string, number> = {};
  const accruedPTOApplies = isFullTimeEmployee(employeeName, categorySets);

  for (const row of sectionRows) {
    if (row.isEmployeeTotal) {
      totalHours = row.grandTotal;
      for (const d of dates) {
        reportedHoursByDate[d] = row.dateValues[d] ?? 0;
      }
      if (isFullTimeEmployee(employeeName, categorySets)) {
        // Use full selected period weekdays so zero-hour Mon–Fri days
        // (missing from detail columns) still show as outstanding.
        const checkDates = weekdaysInPeriod(periodStart, periodEnd, dates);
        for (const d of checkDates) {
          const total = roundHoursForReport(reportedHoursByDate[d] ?? 0);
          if (total < 8) {
            timesheetNeedsFilled.push({
              date: d,
              hoursReported: total,
              hoursNeeded: roundHoursForReport(8 - total),
            });
          }
        }
      }
      if (isFullTimeSalaried(employeeName, categorySets)) {
        for (const d of dates) {
          const total = row.dateValues[d] ?? 0;
          if (total <= 0) continue;
          let accrued = 0;
          if (isWeekday(d)) {
            if (total > 8) accrued = total - 8;
          } else {
            accrued = total;
          }
          if (accrued > 0) compAccruedByDate[d] = accrued;
        }
      }
      if (!isFullTimeSalaried(employeeName, categorySets)) {
        for (const d of dates) {
          const total = row.dateValues[d] ?? 0;
          if (total <= 0) continue;
          let overtime = 0;
          if (isWeekday(d)) {
            if (total > 8) overtime = total - 8;
          } else {
            overtime = total;
          }
          if (overtime > 0) overtimeByDate[d] = overtime;
        }
      }
      break;
    }
    if (row.indentLevel === 1) {
      currentProjectLabel = row.label.toUpperCase();
      currentTag = '';
    }
    if (row.indentLevel === 2 && row.grandTotal === 0) {
      currentTag = row.label;
    }
    if (row.indentLevel === 2 && row.grandTotal > 0) {
      const desc = row.label;
      const isHolidayTimeContext =
        isHolidayLeaveContext(currentProjectLabel) ||
        isHolidayLeaveContext(currentTag) ||
        isHolidayLeaveContext(desc);
      const isFmlaTimeContext =
        isFmlaLeaveContext(currentProjectLabel) ||
        isFmlaLeaveContext(currentTag) ||
        isFmlaLeaveContext(desc);
      const isExcludedLeaveContext = isHolidayTimeContext || isFmlaTimeContext;
      const isSickContext =
        currentProjectLabel.includes('SICK') ||
        currentTag.toUpperCase().includes('SICK') ||
        desc.toUpperCase().includes('SICK');
      if (isSiteSurveyTag(currentTag) && isTravelOnSite(desc) && !hasMiles(desc)) {
        for (const d of dates) {
          const hrs = row.dateValues[d] ?? 0;
          if (hrs > 0) reviewNeeded.push({ date: d, project: currentProjectLabel, tag: currentTag, description: desc });
        }
      }
      if (isExcludedLeaveContext || isSickContext) {
        for (const d of dates) {
          const hrs = row.dateValues[d] ?? 0;
          if (hrs > 0) {
            if (!accruedPTOExclusionReasonsByDate[d]) accruedPTOExclusionReasonsByDate[d] = new Set<string>();
            if (isHolidayTimeContext) accruedPTOExclusionReasonsByDate[d].add('Holiday');
            if (isFmlaTimeContext) accruedPTOExclusionReasonsByDate[d].add('FMLA');
            if (isSickContext) accruedPTOExclusionReasonsByDate[d].add('Sick');
          }
        }
      }

      const excludedForAccruedPTO =
        isExcludedLeaveContext ||
        currentProjectLabel.includes('PTO') ||
        currentProjectLabel.includes('SICK') ||
        currentProjectLabel.includes('COMP');
      if (!excludedForAccruedPTO) {
        for (const d of dates) {
          const hrs = row.dateValues[d] ?? 0;
          if (hrs > 0) {
            accruedPTOEligibleHoursByDate[d] = (accruedPTOEligibleHoursByDate[d] ?? 0) + hrs;
          }
        }
      } else {
        for (const d of dates) {
          const hrs = row.dateValues[d] ?? 0;
          if (hrs > 0) {
            accruedPTOExcludedHoursByDate[d] = (accruedPTOExcludedHoursByDate[d] ?? 0) + hrs;
            if (!accruedPTOExclusionReasonsByDate[d]) accruedPTOExclusionReasonsByDate[d] = new Set<string>();
            if (currentProjectLabel.includes('PTO')) accruedPTOExclusionReasonsByDate[d].add('PTO');
            if (currentProjectLabel.includes('SICK')) accruedPTOExclusionReasonsByDate[d].add('Sick');
            if (currentProjectLabel.includes('COMP')) accruedPTOExclusionReasonsByDate[d].add('Comp Time');
          }
        }
      }

      if (currentProjectLabel.includes('SICK')) {
        sickHours += row.grandTotal;
        for (const d of dates) {
          const hrs = row.dateValues[d] ?? 0;
          if (hrs > 0) sickByDate[d] = (sickByDate[d] ?? 0) + hrs;
        }
      } else if (
        !isPartTimeHourly(employeeName, categorySets) &&
        (
          currentProjectLabel.includes('VACATION') ||
          currentProjectLabel.includes('PTO') ||
          (currentProjectLabel.includes('COMP') &&
            isFullTimeHourly(employeeName, categorySets))
        )
      ) {
        ptoHours += row.grandTotal;
        for (const d of dates) {
          const hrs = row.dateValues[d] ?? 0;
          if (hrs > 0) ptoByDate[d] = (ptoByDate[d] ?? 0) + hrs;
        }
      } else if (
        currentProjectLabel.includes('COMP') &&
        isFullTimeSalaried(employeeName, categorySets)
      ) {
        for (const d of dates) {
          const hrs = row.dateValues[d] ?? 0;
          if (hrs > 0) compByDate[d] = (compByDate[d] ?? 0) + hrs;
        }
      }
    }
  }

  const sickTime: CompTimeEntry[] = dates
    .filter((d) => (sickByDate[d] ?? 0) > 0)
    .map((d) => ({ date: d, hours: sickByDate[d]! }));

  const ptoTime: CompTimeEntry[] = isPartTimeHourly(employeeName, categorySets)
    ? []
    : dates
        .filter((d) => (ptoByDate[d] ?? 0) > 0)
        .map((d) => ({ date: d, hours: ptoByDate[d]! }));

  const accruedPTOTime: AccruedPTOEntry[] = accruedPTOApplies
    ? dates.map((d) => {
        const reportingHours = reportedHoursByDate[d] ?? 0;
        const excludedHours = accruedPTOExcludedHoursByDate[d] ?? 0;
        const eligibleHoursSum = accruedPTOEligibleHoursByDate[d] ?? 0;
        let eligibleHoursForPto = 0;
        if (isWeekday(d) && reportingHours > 0) {
          const regularCap = Math.min(reportingHours, 8);
          // FMLA/leave stays categorized as excluded time, but does not reduce
          // same-day regular worked-hour eligibility for earned worked days.
          eligibleHoursForPto = Math.min(eligibleHoursSum, regularCap);
        }
        const reasons = Array.from(accruedPTOExclusionReasonsByDate[d] ?? []);
        if (excludedHours > 0) reasons.push(`${formatDecimal(excludedHours)} excluded hrs`);
        if (!isWeekday(d) && reportingHours > 0) reasons.push('Weekend');
        const reason = reasons.length > 0
          ? reasons.join(', ')
          : reportingHours <= 0
            ? 'No reported hours'
            : eligibleHoursForPto > 0
              ? '-'
              : 'No eligible hours';
        return {
          date: d,
          reportingHours,
          accruedPTO: eligibleHoursForPto / 8,
          reason,
        };
      })
    : [];

  const compTime: CompTimeEntry[] = dates
    .filter((d) => (compByDate[d] ?? 0) > 0)
    .map((d) => ({ date: d, hours: compByDate[d]! }));

  const compTimeAccrued: CompTimeEntry[] = dates
    .filter((d) => (compAccruedByDate[d] ?? 0) > 0)
    .map((d) => ({ date: d, hours: compAccruedByDate[d]! }));

  const overtimeTime: CompTimeEntry[] = dates
    .filter((d) => (overtimeByDate[d] ?? 0) > 0)
    .map((d) => ({ date: d, hours: overtimeByDate[d]! }));

  const timesheetRuleApplies = isFullTimeEmployee(employeeName, categorySets);
  const compTimeApplies = isFullTimeSalaried(employeeName, categorySets);
  const overtimeApplies = !isFullTimeSalaried(employeeName, categorySets);
  return { totalHours, sickHours, ptoHours, accruedPTOApplies, accruedPTOTime, timesheetNeedsFilled, timesheetRuleApplies, sickTime, ptoTime, compTime, compTimeAccrued, compTimeApplies, overtimeTime, overtimeApplies, reviewNeeded };
}

async function loadLogo(): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  format: 'JPEG' | 'PNG';
} | null> {
  try {
    const res = await fetch('/logo.png');
    if (!res.ok) return null;
    const blob = await res.blob();
    const sourceUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = sourceUrl;
    });

    // Downscale for PDF: logo only prints ~50×25mm; embedding the full
    // ~700KB PNG is the main reason each file hits multi‑MB sizes.
    const maxPx = 360;
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { dataUrl: sourceUrl, width: img.naturalWidth, height: img.naturalHeight, format: 'PNG' };
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);

    return { dataUrl, width, height, format: 'JPEG' };
  } catch {
    return null;
  }
}

function drawReportCardPage(
  doc: jsPDF,
  employeeName: string,
  reportCard: ReportCard,
  logo: { dataUrl: string; width: number; height: number; format: 'JPEG' | 'PNG' } | null,
  dates: string[],
  categorySets: ReturnType<typeof buildCategorySets>,
  periodStart?: string,
  periodEnd?: string,
): void {
  const pageWidth = doc.internal.pageSize.getWidth();

  let startY = 10;

  if (logo) {
    const maxWidth = 50;
    const maxHeight = 25;
    // logo.width/height are pixels of the already-downscaled image.
    const scale = Math.min(maxWidth / logo.width, maxHeight / logo.height);
    const logoWidth = logo.width * scale;
    const logoHeight = logo.height * scale;
    const logoX = (pageWidth - logoWidth) / 2;
    doc.addImage(
      logo.dataUrl,
      logo.format,
      logoX,
      startY,
      logoWidth,
      logoHeight,
      undefined,
      'FAST',
    );
    startY += logoHeight + 8;
  }

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  const heading = `${employeeName} - Report Card`;
  const headingW = doc.getTextWidth(heading);
  doc.text(heading, (pageWidth - headingW) / 2, startY);
  startY += 12;

  const formatHours = (h: number) =>
    h === 0 ? '0 hours' : h === 1 ? '1 hour' : `${formatDecimal(h)} hours`;

  const compTotal = reportCard.compTimeApplies
    ? reportCard.compTime.reduce((sum, e) => sum + e.hours, 0)
    : 0;
  const compAccruedTotal = reportCard.compTimeApplies
    ? reportCard.compTimeAccrued.reduce((sum, e) => sum + e.hours, 0)
    : 0;
  const overtimeTotal = reportCard.overtimeApplies
    ? reportCard.overtimeTime.reduce((sum, e) => sum + e.hours, 0)
    : 0;
  const accruedPTOTotal = reportCard.accruedPTOTime.reduce((sum, e) => sum + e.accruedPTO, 0);
  const timesheetSummary = !reportCard.timesheetRuleApplies
    ? 'N/A (rule applies only to full-time employees)'
    : reportCard.timesheetNeedsFilled.length === 0
      ? 'None'
      : `${reportCard.timesheetNeedsFilled.length} date(s) - see table below`;

  const reviewSummary = reportCard.reviewNeeded.length === 0
    ? 'None'
    : `${reportCard.reviewNeeded.length} entry(ies) - miles missing for travel/on-site`;

  const periodFrom = periodStart || dates[0];
  const periodTo = periodEnd || dates[dates.length - 1];
  const timePeriodValue =
    periodFrom && periodTo
      ? `${formatDateForTimePeriod(periodFrom)} to ${formatDateForTimePeriod(periodTo)}`
      : '-';

  const tableData: [string, string][] = [['Time period', timePeriodValue]];
  if (isPartTimeHourly(employeeName, categorySets)) {
    tableData.push(['Total hours', formatHours(reportCard.totalHours)]);
  }
  if (reportCard.timesheetRuleApplies) {
    tableData.push(['Outstanding Clockify Entries', timesheetSummary]);
  }
  tableData.push(['Outstanding miles entries', reviewSummary]);
  tableData.push(['Sick Time', formatHours(reportCard.sickHours)]);
  if (!isPartTimeHourly(employeeName, categorySets)) {
    tableData.push(['PTO Time', formatHours(reportCard.ptoHours)]);
  }
  if (reportCard.accruedPTOApplies) {
    tableData.push(['Earned worked days', formatDecimal(accruedPTOTotal)]);
  }
  if (reportCard.compTimeApplies) {
    tableData.push(['Compensation Time Used', formatHours(compTotal)]);
    tableData.push(['Compensation Time Accrued', formatHours(compAccruedTotal)]);
  }
  if (reportCard.overtimeApplies) {
    tableData.push(['Overtime', formatHours(overtimeTotal)]);
  }

  autoTable(doc, {
    head: [
      [{ content: 'SUMMARY TABLE', colSpan: 2, styles: { halign: 'left', fontSize: 14, fontStyle: 'bold', fillColor: [66, 66, 66], textColor: [255, 255, 255], lineWidth: 0.2 } }],
      ['Category', 'Value'],
    ],
    body: tableData,
    startY,
    theme: 'grid',
    pageBreak: 'avoid',
    headStyles: { fillColor: [66, 66, 66], fontStyle: 'bold', textColor: [255, 255, 255] },
    didParseCell: (data) => {
      if (data.section === 'head' && data.row.index === 1) {
        data.cell.styles.fillColor = false;
        data.cell.styles.textColor = [0, 0, 0];
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.lineWidth = 0.2;
      }
    },
    bodyStyles: { fontSize: 10 },
    margin: { left: MARGIN },
    tableWidth: pageWidth - MARGIN * 2,
    columnStyles: {
      0: { cellWidth: 120 },
      1: { cellWidth: 'auto' },
    },
  });
  startY = (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? startY;
  startY += 10;

  const formatHrs = (h: number) => formatDecimal(h);

  if (reportCard.timesheetRuleApplies) {
    const tsBody =
      reportCard.timesheetNeedsFilled.length > 0
        ? reportCard.timesheetNeedsFilled.map((e) => [
            formatDateForReport(e.date),
            formatHrs(e.hoursReported),
            formatHrs(e.hoursNeeded),
          ])
        : [['No dates need to be filled', '-', '-']];

    const hasDatesToFill = reportCard.timesheetNeedsFilled.length > 0;
    const tsRedColor: [number, number, number] = [180, 0, 0];
    autoTable(doc, {
      head: [
        [{ content: 'OUTSTANDING CLOCKIFY ENTRIES', colSpan: 3, styles: { halign: 'left', fontSize: 14, fontStyle: 'bold', fillColor: [66, 66, 66], textColor: [255, 255, 255], lineWidth: 0.2 } }],
        ['Date', 'Hours reported', 'Hours remaining'],
      ],
      body: tsBody,
      startY,
      theme: 'grid',
      pageBreak: 'avoid',
      headStyles: {
        fillColor: hasDatesToFill ? [200, 50, 50] : [66, 66, 66],
        fontStyle: 'bold',
        textColor: [255, 255, 255],
      },
      didParseCell: (data) => {
        if (data.section === 'head' && data.row.index === 1) {
          data.cell.styles.fillColor = false;
          data.cell.styles.textColor = [0, 0, 0];
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.lineWidth = 0.2;
        }
      },
      bodyStyles: { fontSize: 9, textColor: hasDatesToFill ? tsRedColor : undefined },
      margin: { left: MARGIN },
      tableWidth: pageWidth - MARGIN * 2,
      columnStyles: {
        0: { cellWidth: 120, ...(hasDatesToFill && { textColor: tsRedColor }) },
        1: { cellWidth: 50, halign: 'right', ...(hasDatesToFill && { textColor: tsRedColor }) },
        2: { cellWidth: 70, halign: 'right', ...(hasDatesToFill && { textColor: tsRedColor }) },
      },
    });
    startY = (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? startY;
    startY += 10;
  }

  if (reportCard.reviewNeeded.length > 0) {
    const reviewBody = reportCard.reviewNeeded.map((e) => [
      formatDateForReport(e.date),
      e.project,
      e.tag || '-',
      e.description,
    ]);
    autoTable(doc, {
      head: [
        [{ content: 'OUTSTANDING MILES ENTRIES', colSpan: 4, styles: { halign: 'left', fontSize: 14, fontStyle: 'bold', fillColor: [66, 66, 66], textColor: [255, 255, 255], lineWidth: 0.2 } }],
        ['Date', 'Project', 'Tag', 'Description (miles missing for travel/on-site)'],
      ],
      body: reviewBody,
      startY,
      theme: 'grid',
      pageBreak: 'avoid',
      headStyles: { fillColor: [66, 66, 66], fontStyle: 'bold', textColor: [255, 255, 255] },
      didParseCell: (data) => {
        if (data.section === 'head' && data.row.index === 1) {
          data.cell.styles.fillColor = false;
          data.cell.styles.textColor = [0, 0, 0];
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.lineWidth = 0.2;
        }
      },
      bodyStyles: { fontSize: 8 },
      margin: { left: MARGIN },
      tableWidth: pageWidth - MARGIN * 2,
      columnStyles: {
        0: { cellWidth: 45 },
        1: { cellWidth: 50, overflow: 'linebreak' },
        2: { cellWidth: 40, overflow: 'linebreak' },
        3: { cellWidth: 'auto', overflow: 'linebreak' },
      },
    });
    startY = (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? startY;
    startY += 10;
  }

  function drawDateHoursTable(
    title: string,
    entries: CompTimeEntry[],
    noDataMessage: string,
    secondColumnLabel = 'Hours'
  ): void {
    const total = entries.reduce((sum, e) => sum + e.hours, 0);
    const body = entries.length > 0
      ? [
          ...entries.map((e) => [formatDateForReport(e.date), formatHrs(e.hours)]),
          ['Total', formatHrs(total)],
        ]
      : [[noDataMessage, '-']];

    autoTable(doc, {
      head: [
        [{ content: title.toUpperCase(), colSpan: 2, styles: { halign: 'left', fontSize: 14, fontStyle: 'bold', fillColor: [66, 66, 66], textColor: [255, 255, 255], lineWidth: 0.2 } }],
        ['Date', secondColumnLabel],
      ],
      body,
      startY,
      theme: 'grid',
      pageBreak: 'avoid',
      headStyles: { fillColor: [66, 66, 66], fontStyle: 'bold', textColor: [255, 255, 255] },
      margin: { left: MARGIN },
      tableWidth: pageWidth - MARGIN * 2,
      columnStyles: {
        0: { cellWidth: 120 },
        1: { cellWidth: 50, halign: 'right' },
      },
      bodyStyles: { fontSize: 9 },
      didParseCell: (data) => {
        if (data.section === 'head' && data.row.index === 1) {
          data.cell.styles.fillColor = false;
          data.cell.styles.textColor = [0, 0, 0];
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.lineWidth = 0.2;
        }
        if (data.section === 'body' && data.row.index === body.length - 1 && entries.length > 0) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [245, 245, 245];
        }
      },
    });
    startY = (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? startY;
    startY += 10;
  }

  function drawAccruedPTOsTable(): void {
    const totalHours = reportCard.accruedPTOTime.reduce((sum, e) => sum + e.reportingHours, 0);
    const totalAccruedPTO = reportCard.accruedPTOTime.reduce((sum, e) => sum + e.accruedPTO, 0);
    const body = reportCard.accruedPTOTime.length > 0
      ? [
          ...reportCard.accruedPTOTime.map((e) => [
            formatDateForReport(e.date),
            formatHrs(e.reportingHours),
            formatHrs(e.accruedPTO),
            e.reason,
          ]),
          ['Total', formatHrs(totalHours), formatHrs(totalAccruedPTO), '-'],
        ]
      : [['No earned worked days', '-', '-', '-']];

    autoTable(doc, {
      head: [
        [{ content: 'EARNED WORK DAYS', colSpan: 4, styles: { halign: 'left', fontSize: 14, fontStyle: 'bold', fillColor: [66, 66, 66], textColor: [255, 255, 255], lineWidth: 0.2 } }],
        ['Date', 'Reporting Hours', 'EARNED WORK DAYS', 'Reason not count'],
      ],
      body,
      startY,
      theme: 'grid',
      pageBreak: 'avoid',
      headStyles: { fillColor: [66, 66, 66], fontStyle: 'bold', textColor: [255, 255, 255] },
      margin: { left: MARGIN },
      tableWidth: pageWidth - MARGIN * 2,
      columnStyles: {
        0: { cellWidth: 75 },
        1: { cellWidth: 35, halign: 'right' },
        2: { cellWidth: 30, halign: 'right' },
        3: { cellWidth: 'auto', overflow: 'linebreak' },
      },
      bodyStyles: { fontSize: 9 },
      didParseCell: (data) => {
        if (data.section === 'head' && data.row.index === 1) {
          data.cell.styles.fillColor = false;
          data.cell.styles.textColor = [0, 0, 0];
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.lineWidth = 0.2;
        }
        if (data.section === 'body' && data.row.index === body.length - 1 && reportCard.accruedPTOTime.length > 0) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [245, 245, 245];
        }
      },
    });
    startY = (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? startY;
    startY += 10;
  }

  drawDateHoursTable('Sick Time', reportCard.sickTime, 'No data found for sick time');
  if (!isPartTimeHourly(employeeName, categorySets)) {
    drawDateHoursTable('PTO Time', reportCard.ptoTime, 'No data found for PTO time');
  }
  if (reportCard.compTimeApplies) {
    drawDateHoursTable('Compensation Time Used', reportCard.compTime, 'No data found for compensation time');
    drawDateHoursTable('Compensation Time Accrued', reportCard.compTimeAccrued, 'No compensation time accrued');
  }
  if (reportCard.overtimeApplies) {
    drawDateHoursTable('Overtime', reportCard.overtimeTime, 'No overtime');
  }
  if (reportCard.accruedPTOApplies) {
    drawAccruedPTOsTable();
  }
}

function buildReportTitle(pivot: PivotData, revNumber: number): string {
  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const firstDateStr = pivot.dates[0];
  let month = 'REPORT';
  if (firstDateStr) {
    const parts = firstDateStr.trim().split('/');
    if (parts.length === 3) {
      const m = parseInt(parts[0], 10);
      if (m >= 1 && m <= 12) month = monthNames[m - 1];
    }
  }
  const printed = new Date();
  const printedStr = `${printed.getMonth() + 1}/${printed.getDate()}/${printed.getFullYear()}`;
  return `${month} REV${revNumber} PRINTED ${printedStr}`;
}

function proposalMatchesRow(
  proposal: HighlightProposal,
  row: PivotRow | null,
): boolean {
  if (!row || row.isEmployeeTotal) return false;
  const label = row.label.trim();
  const matched = proposal.matchedText.trim();
  if (!label || !matched) return false;
  return (
    label === matched ||
    label.includes(matched) ||
    matched.includes(label) ||
    label.replace(/^\s+/, '') === matched
  );
}

/** Yellow-highlight only the trigger sentence inside a wrapped label cell. */
function drawPhraseHighlightsInCell(
  doc: jsPDF,
  cell: { x: number; y: number; width: number; height: number },
  displayText: string,
  phrases: string[],
  fontSize = 9,
): { phrase: string; x: number; y: number; width: number }[] {
  const found: { phrase: string; x: number; y: number; width: number }[] = [];
  if (!phrases.length) return found;

  const padding = 2;
  const maxWidth = Math.max(10, cell.width - padding * 2);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(fontSize);
  const lineHeight = fontSize * 0.4;
  const lines = doc.splitTextToSize(displayText, maxWidth) as string[];

  // Map each wrapped line back to offsets in displayText
  const lineRanges: { line: string; start: number; end: number }[] = [];
  let searchPos = 0;
  for (const line of lines) {
    let idx = displayText.indexOf(line, searchPos);
    if (idx < 0) {
      // Whitespace normalization fallback
      const collapsed = line.trim();
      idx = collapsed
        ? displayText.toLowerCase().indexOf(collapsed.toLowerCase(), searchPos)
        : searchPos;
      if (idx < 0) idx = searchPos;
    }
    lineRanges.push({ line, start: idx, end: idx + line.length });
    searchPos = idx + line.length;
  }

  for (const phrase of phrases) {
    if (!phrase.trim()) continue;
    const lowerFull = displayText.toLowerCase();
    const lowerPhrase = phrase.toLowerCase();
    let phraseStart = lowerFull.indexOf(lowerPhrase);
    // Indent in displayText may shift phrase — also try without leading indent spaces
    if (phraseStart < 0) {
      phraseStart = lowerFull.indexOf(lowerPhrase.trim());
    }
    if (phraseStart < 0) continue;
    const phraseEnd = phraseStart + phrase.length;

    let cursorY = cell.y + padding + lineHeight * 0.85;
    let firstHit: { phrase: string; x: number; y: number; width: number } | null =
      null;

    for (const range of lineRanges) {
      const overlapStart = Math.max(range.start, phraseStart);
      const overlapEnd = Math.min(range.end, phraseEnd);
      if (overlapStart < overlapEnd) {
        const localStart = overlapStart - range.start;
        const localEnd = overlapEnd - range.start;
        const before = range.line.slice(0, localStart);
        const matched = range.line.slice(localStart, localEnd);
        const x0 = cell.x + padding + doc.getTextWidth(before);
        const w = Math.max(doc.getTextWidth(matched), 2);
        doc.setFillColor(255, 242, 0);
        doc.rect(
          x0 - 0.2,
          cursorY - lineHeight + 0.7,
          w + 0.4,
          lineHeight,
          'F',
        );
        doc.setTextColor(0, 0, 0);
        doc.text(matched, x0, cursorY);
        if (!firstHit) {
          firstHit = { phrase: matched, x: x0, y: cursorY, width: w };
        }
      }
      cursorY += lineHeight;
      if (cursorY > cell.y + cell.height) break;
    }

    if (firstHit) found.push(firstHit);
  }

  return found;
}

export async function generatePdfsZip(
  pivot: PivotData,
  zipFilename = 'time-reports.zip',
  revNumber = 1,
  managedUsers: ManagedUser[] = [],
  acceptedHighlights: HighlightProposal[] = [],
): Promise<void> {
  const dates = pivot.dates;
  const numDateCols = dates.length;
  const dateHeaderLabels = dates.map(getVerticalDateLabel);
  const zip = new JSZip();
  const logo = await loadLogo();
  const categorySets = buildCategorySets(managedUsers);

  const userSections = splitRowsByUser(pivot.rows);

  for (const { name, rows: sectionRows } of userSections) {
    const doc = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });
    const reportCard = computeReportCard(
      sectionRows,
      dates,
      name,
      categorySets,
      pivot.periodStart,
      pivot.periodEnd,
    );
    const reportTitle = buildReportTitle(pivot, revNumber);
    drawReportCardPage(
      doc,
      name,
      reportCard,
      logo,
      dates,
      categorySets,
      pivot.periodStart,
      pivot.periodEnd,
    );

    const employeeHighlights = acceptedHighlights.filter(
      (h) => h.employeeName === name && h.status === 'accepted',
    );
    const usedHighlightIds = new Set<string>();

    doc.addPage('a4', 'landscape');
    const pageWidth = doc.internal.pageSize.getWidth();

  //  const availableWidth = pageWidth - MARGIN * 2 - COLUMN_WIDTH_ROW_LABELS;
   // const dateColWidth = availableWidth / (numDateCols + 1);
   // const dateColStyle = {
    //  cellWidth: dateColWidth,
    //  halign: 'right' as const,
    //  overflow: 'linebreak' as const,
   // };
   // const columnStyles = {
    //  0: { cellWidth: COLUMN_WIDTH_ROW_LABELS, overflow: 'linebreak' as const },
     // ...Object.fromEntries(
       // Array.from({ length: numDateCols + 1 }, (_, i) => [i + 1, dateColStyle])
     // ),
   // };


// START OF REPLACEMENT
const FIXED_DATE_COL_WIDTH = 8; // Width in mm (flexible for ~4-5 characters)
const totalDateAreaWidth = FIXED_DATE_COL_WIDTH * (numDateCols + 1);

// Calculate Row Label width based on whatever is left of the page
const dynamicRowLabelWidth = pageWidth - (MARGIN * 2) - totalDateAreaWidth;

const dateColStyle = {
  cellWidth: FIXED_DATE_COL_WIDTH,
  halign: 'right' as const,
  overflow: 'linebreak' as const,
  fontSize: 8, // Slightly smaller font to ensure numbers fit
};

const columnStyles = {
  // Column 0 (Row Labels) now takes all remaining space
  0: { cellWidth: dynamicRowLabelWidth, overflow: 'linebreak' as const },
  ...Object.fromEntries(
    Array.from({ length: numDateCols + 1 }, (_, i) => [i + 1, dateColStyle])
  ),
};
// END OF REPLACEMENT




    const headerRow = ['Row Labels', ...dateHeaderLabels, 'Grand Total'];
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    const headerHeight =
      Math.max(...headerRow.slice(1).map((l) => doc.getTextWidth(l as string)), 0);
    doc.setFontSize(10);
    const bodyRows: (string | number)[][] = [];
    const rowSource: (PivotRow | null)[] = [];
    for (const pr of sectionRows) {
      if (pr.indentLevel === 1) {
        bodyRows.push(rowToTableCells(null, dates));
        rowSource.push(null);
      }
      if (pr.isEmployeeTotal) {
        bodyRows.push(rowToTableCells(null, dates));
        rowSource.push(null);
      }
      bodyRows.push(rowToTableCells(pr, dates));
      rowSource.push(pr);
    }
    const blackText: [number, number, number] = [0, 0, 0];
    const redText: [number, number, number] = [200, 0, 0];

    const grandTotalColStyle = (columnStyles as Record<number, object>)[numDateCols + 1];
    const finalColumnStyles: Record<number, object> = {
      ...columnStyles,
      [numDateCols + 1]: { ...grandTotalColStyle, textColor: redText },
    };

    autoTable(doc, {
      head: [headerRow],
      body: bodyRows,
      startY: 18,
      theme: 'grid' as const,
      showHead: 'everyPage',
      headStyles: {
        fontSize: 8,
        fontStyle: 'bold',
        textColor: blackText,
        //minCellHeight: headerHeight,
		 minCellHeight: headerHeight + 3,
        cellPadding: 2,
        fillColor: [220, 220, 220],
        overflow: 'linebreak',
        halign: 'center',
        lineWidth: 0.1,
      },
      bodyStyles: {
        fontSize: 9,
        textColor: blackText,
        cellPadding: 2,
        overflow: 'linebreak',
      },
      columnStyles: finalColumnStyles,
      margin: { left: MARGIN },
      tableWidth: pageWidth - MARGIN * 2,
      didParseCell: (data) => {
        if (data.section === 'body') {
          const pr = rowSource[data.row.index];
          if (pr?.isEmployeeTotal) {
            data.cell.styles.fontStyle = 'bold';
          }
          if (pr?.indentLevel === 1) {
            data.cell.styles.fontStyle = 'bold';
          }
          // Do not yellow-fill the whole cell — phrase highlight is drawn later
          const matchedHighlights = pr
            ? employeeHighlights.filter((h) => proposalMatchesRow(h, pr))
            : [];
          if (matchedHighlights.length > 0 && data.column.index === 0) {
            const commentLineEstimate = matchedHighlights.reduce((sum, h) => {
              return (
                sum + Math.max(1, Math.ceil(h.comment.length / NOTE_CHARS_PER_LINE))
              );
            }, 0);
            // Blank lines reserve a separate area below the description.
            for (let i = 0; i < commentLineEstimate + 1; i++) {
              data.cell.text.push(' ');
            }
          }
        }
        if (data.section === 'head') {
          data.cell.styles.halign = 'center';
          if (data.column.index >= 1) {
            data.cell.text = [''];
          }
        }
      },

      didDrawCell: (data) => {
        if (data.section === 'head' && data.column.index >= 1) {
          const colIdx = data.column.index;
          const label = (headerRow[colIdx] ?? '') as string;
          const cx = data.cell.x + data.cell.width / 2;
          const cy = data.cell.y + data.cell.height - 2;
          const isGrandTotal = colIdx === numDateCols + 1;
          doc.setTextColor(isGrandTotal ? 200 : 0, 0, 0);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.text(label, cx, cy, {
            angle: 90,
            baseline: 'middle',
            align: 'left',
          });
        }

        if (
          data.section === 'body' &&
          data.column.index === 0 &&
          employeeHighlights.length > 0
        ) {
          const pr = rowSource[data.row.index];
          const matches = employeeHighlights.filter(
            (h) =>
              !usedHighlightIds.has(h.id) && proposalMatchesRow(h, pr),
          );
          if (matches.length > 0 && pr) {
            const indent = '  '.repeat(pr.indentLevel);
            const displayText = pr.isEmployeeTotal
              ? pr.label
              : indent + pr.label;

            const noteX = data.cell.x + 2;
            const maxWidth = Math.max(16, data.cell.width - 4);
            const renderedNotes: { lines: string[]; boxHeight: number }[] = [];
            for (const match of matches) {
              usedHighlightIds.add(match.id);
              const trigger = match.triggerText?.trim() || match.matchedText.trim();
              drawPhraseHighlightsInCell(
                doc,
                data.cell,
                displayText,
                [trigger],
                9,
              );
              doc.setFont('helvetica', 'bold');
              doc.setFontSize(NOTE_FONT_SIZE);
              const lines = doc.splitTextToSize(match.comment, maxWidth);
              renderedNotes.push({
                lines,
                boxHeight: lines.length * NOTE_LINE_HEIGHT + 1.6,
              });
            }

            const noteGap = 0.8;
            const totalNoteHeight = renderedNotes.reduce(
              (sum, note, index) =>
                sum + note.boxHeight + (index > 0 ? noteGap : 0),
              0,
            );
            let boxY =
              data.cell.y + data.cell.height - totalNoteHeight - 0.8;

            for (const note of renderedNotes) {
              doc.setFillColor(255, 255, 220);
              doc.setDrawColor(200, 0, 0);
              doc.setLineWidth(0.15);
              doc.rect(
                noteX - 0.4,
                boxY,
                maxWidth + 0.8,
                note.boxHeight,
                'FD',
              );
              doc.setTextColor(200, 0, 0);
              doc.text(note.lines, noteX, boxY + NOTE_LINE_HEIGHT);
              boxY += note.boxHeight + noteGap;
            }
            doc.setTextColor(0, 0, 0);
            doc.setFont('helvetica', 'normal');
          }
        }
      },
    });

    // Notes are drawn next to their trigger phrases during didDrawCell.

    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      const w = doc.internal.pageSize.getWidth();
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(0, 0, 0);
      doc.text(reportTitle, MARGIN, 6);
      doc.setFontSize(8);
      doc.text(`-- ${p} of ${totalPages} --`, w / 2 - 15, h - 8);
    }

    const pdfBlob = doc.output('blob');
    zip.file(`${sanitizeFilename(name)}.pdf`, pdfBlob, {
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
  }

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  const url = URL.createObjectURL(zipBlob);
  // Ensure browsers reliably treat this as a download (not a navigation).
  const a = document.createElement('a');
  a.href = url;
  a.download = zipFilename;
  a.target = '_self';
  a.rel = 'noopener';

  document.body.appendChild(a);
  a.click();
  a.remove();

  // Revoke later to avoid interrupting the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
