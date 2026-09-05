import type {
  EmployeeCategory,
  ManagedUser,
  MentionUser,
  PivotData,
  PivotRow,
} from '../types';
import {
  DEFAULT_FULL_TIME_HOURLY,
  DEFAULT_FULL_TIME_SALARIED,
  DEFAULT_PART_TIME_HOURLY,
  normalizeEmployeeName,
} from './employeeCategories';

export type HighlightStatus = 'pending' | 'accepted' | 'deleted';

export type HighlightRuleId =
  | 'missing_miles'
  | 'odd_miles'
  | 'miles_in_eps_admin_office_time'
  | 'multiple_hour_values_split_entry'
  | 'billable_keyword'
  | 'open_job_keyword'
  | 'future_billable'
  | 'wrong_coding'
  | 'holiday_comp'
  | 'category_sick'
  | 'internal_note'
  | 'admin_office_time';

export interface HighlightProposal {
  id: string;
  employeeName: string;
  ruleId: HighlightRuleId;
  ruleLabel: string;
  /** Full description / row text used for matching the row */
  matchedText: string;
  /** Specific phrase to yellow-highlight (not the whole row) */
  triggerText: string;
  projectLabel: string;
  tag: string;
  comment: string;
  status: HighlightStatus;
}

function firstName(employeeName: string): string {
  const base = normalizeEmployeeName(employeeName);
  return base.split(/\s+/)[0] || base || 'Employee';
}

function mentionFirstNames(mentionUsers: MentionUser[]): string[] {
  return mentionUsers
    .map((user) => firstName(user.name))
    .filter((name) => name.length > 0);
}

function mentionPrefix(mentionUsers: MentionUser[]): string {
  const names = mentionFirstNames(mentionUsers);
  if (names.length === 0) return '';
  return `${names.join('/')}.... `;
}

function mentionGreetingRegex(mentionUsers: MentionUser[]): RegExp | null {
  const names = mentionFirstNames(mentionUsers);
  if (names.length === 0) return null;
  const escaped = names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\/');
  return new RegExp(`^${escaped}\\s*\\.{0,6}\\s*`, 'i');
}

function withMentions(mentionUsers: MentionUser[], message: string): string {
  return `${mentionPrefix(mentionUsers)}${message}`;
}

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

function isPartTimeHourly(
  employeeName: string,
  categorySets: ReturnType<typeof buildCategorySets>,
): boolean {
  const baseName = normalizeEmployeeName(employeeName);
  if (categorySets.partTimeHourly.has(baseName)) return true;
  return /^Jacob\b/i.test(baseName);
}

function isFullTimeEmployee(
  employeeName: string,
  categorySets: ReturnType<typeof buildCategorySets>,
): boolean {
  const baseName = normalizeEmployeeName(employeeName);
  if (categorySets.fullTimeEmployees.has(baseName)) return true;
  return /^Kathy\b/i.test(baseName);
}

function isHolidayLeaveContext(value: string): boolean {
  const normalized = value.toUpperCase();
  if (!normalized.includes('HOLIDAY')) return false;
  if (/\bHOLIDAY\s+INN\b/.test(normalized)) return false;
  return /\bHOLIDAY\b/.test(normalized);
}

function isFmlaLeaveContext(value: string): boolean {
  return /\bFMLA\b/.test(value.toUpperCase());
}

/** Leave / non-work time — not eligible for "worked on holiday → Comp Time". */
function isLeaveProject(projectLabel: string, tag: string): boolean {
  const p = `${projectLabel} ${tag}`.toUpperCase();
  return (
    isHolidayLeaveContext(p) ||
    isFmlaLeaveContext(p) ||
    p.includes('SICK') ||
    p.includes('PTO') ||
    p.includes('VACATION') ||
    (p.includes('COMP') && p.includes('TIME'))
  );
}

function isLeaveDescription(desc: string): boolean {
  return (
    isHolidayLeaveContext(desc) ||
    isFmlaLeaveContext(desc) ||
    /\b(?:paternity|maternity|parental)\s+leave\b/i.test(desc) ||
    /\b(?:sick|pto|vacation)\b/i.test(desc)
  );
}

/** Format matches Clockify pivot date keys: MM/DD/YYYY */
function toPivotDateKey(year: number, monthIndex: number, day: number): string {
  const m = (monthIndex + 1).toString().padStart(2, '0');
  const d = day.toString().padStart(2, '0');
  return `${m}/${d}/${year}`;
}

function nthWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
  nth: number,
): string {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(year, monthIndex, day);
    if (d.getMonth() !== monthIndex) break;
    if (d.getDay() === weekday) {
      count += 1;
      if (count === nth) return toPivotDateKey(year, monthIndex, day);
    }
  }
  return toPivotDateKey(year, monthIndex, 1);
}

function lastWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
): string {
  for (let day = 31; day >= 1; day--) {
    const d = new Date(year, monthIndex, day);
    if (d.getMonth() !== monthIndex) continue;
    if (d.getDay() === weekday) return toPivotDateKey(year, monthIndex, day);
  }
  return toPivotDateKey(year, monthIndex, 1);
}

function observedHoliday(year: number, monthIndex: number, day: number): string {
  const d = new Date(year, monthIndex, day);
  const dow = d.getDay();
  // Sat → Friday before; Sun → Monday after
  if (dow === 6) return toPivotDateKey(year, monthIndex, day - 1);
  if (dow === 0) return toPivotDateKey(year, monthIndex, day + 1);
  return toPivotDateKey(year, monthIndex, day);
}

function usFederalHolidayKeys(year: number): Set<string> {
  return new Set([
    observedHoliday(year, 0, 1), // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3), // MLK Day
    nthWeekdayOfMonth(year, 1, 1, 3), // Presidents Day
    lastWeekdayOfMonth(year, 4, 1), // Memorial Day
    observedHoliday(year, 5, 19), // Juneteenth
    observedHoliday(year, 6, 4), // Independence Day
    nthWeekdayOfMonth(year, 8, 1, 1), // Labor Day
    nthWeekdayOfMonth(year, 9, 1, 2), // Columbus Day
    observedHoliday(year, 10, 11), // Veterans Day
    nthWeekdayOfMonth(year, 10, 4, 4), // Thanksgiving
    observedHoliday(year, 11, 25), // Christmas
  ]);
}

function federalHolidaySetForDates(dates: string[]): Set<string> {
  const years = new Set<number>();
  for (const dateStr of dates) {
    const parts = dateStr.trim().split('/');
    if (parts.length === 3) years.add(parseInt(parts[2], 10));
  }
  const keys = new Set<string>();
  for (const year of years) {
    if (!Number.isFinite(year)) continue;
    for (const key of usFederalHolidayKeys(year)) keys.add(key);
  }
  return keys;
}

function hasMiles(description: string): boolean {
  return /\d+\s*(total\s+)?miles?\b|miles?\s*\d+|\d+\s*mi\b/i.test(description);
}

function hasZeroMiles(description: string): boolean {
  return /\b0\s*miles?\b/i.test(description);
}

function collectEmployeeFirstNames(
  managedUsers: ManagedUser[],
  employeeNames: string[],
): Set<string> {
  const names = new Set<string>();
  for (const user of managedUsers) {
    const fn = firstName(user.name).toLowerCase();
    if (fn) names.add(fn);
  }
  for (const name of employeeNames) {
    const fn = firstName(name).toLowerCase();
    if (fn) names.add(fn);
  }
  return names;
}

/** True when a written name matches a known employee first name (exact or short form). */
function matchesEmployeeFirstName(
  writtenName: string,
  employeeFirstNames: Set<string>,
): boolean {
  const written = writtenName.toLowerCase();
  if (!written) return false;
  if (employeeFirstNames.has(written)) return true;
  // Short forms: "Zulfi" matches "Zulfiqar" (min 4 chars to avoid weak matches)
  if (written.length < 4) return false;
  for (const first of employeeFirstNames) {
    if (first.startsWith(written) || (first.length >= 4 && written.startsWith(first))) {
      return true;
    }
  }
  return false;
}

/** True when description already names who drove using "I" or a known employee first name. */
function hasNamedDriver(
  description: string,
  employeeFirstNames: Set<string>,
): boolean {
  if (/\bI\s+drove\b/.test(description)) return true;

  for (const match of description.matchAll(
    /\b([A-Za-z][A-Za-z.'-]*)\s+drove\b/gi,
  )) {
    if (matchesEmployeeFirstName(match[1]!, employeeFirstNames)) return true;
  }

  for (const match of description.matchAll(
    /\b([A-Za-z][A-Za-z.'-]*)\s+and\s+([A-Za-z][A-Za-z.'-]*)\s+drove\b/gi,
  )) {
    if (
      matchesEmployeeFirstName(match[1]!, employeeFirstNames) ||
      matchesEmployeeFirstName(match[2]!, employeeFirstNames)
    ) {
      return true;
    }
  }

  return false;
}

function hasMultipleHourValues(description: string): boolean {
  // Matches: "1 hour", "2 hours", "2.5 hrs", "3 hr", case-insensitive.
  // Also tolerates trailing punctuation: "2 hr.", "2 hrs,", etc.
  // Break time (e.g. "1 hour break", "1 hr break time") is ignored — it is
  // not a second work block that needs splitting.
  const hourRegex =
    /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr)\.?(?=\b|$|[^A-Za-z0-9])/gi;
  let workHourCount = 0;
  for (const match of description.matchAll(hourRegex)) {
    const end = (match.index ?? 0) + match[0].length;
    const after = description.slice(end, end + 24);
    if (/^\s*(?:time\s+)?break(?:\s+time)?\b/i.test(after)) continue;
    workHourCount += 1;
  }
  return workHourCount >= 2;
}

/** Personal / non-job trips — miles not required (e.g. restaurant, lunch). */
function isPersonalTravel(description: string): boolean {
  return (
    /\brestaurants?\b/i.test(description) ||
    /\brestraunts?\b/i.test(description) || // common misspelling
    /\bresturants?\b/i.test(description) ||
    /\b(?:lunch|dinner|breakfast|brunch|bbq|barbecue)\b/i.test(description) ||
    /\b(?:cafe|coffee\s+shop|starbucks)\b/i.test(description) ||
    /\bpersonal\s+(?:errand|trip|time|business)\b/i.test(description) ||
    /\bwent\s+(?:home|to\s+home)\b/i.test(description) ||
    /\b(?:grocery|groceries|bank|gym)\b/i.test(description)
  );
}

/** IN-SHOP / office errands (pickup supplies, laptop) — miles not required. */
function isShopOrOfficeErrand(description: string): boolean {
  const d = description.toLowerCase();
  if (/\bin[- ]?shop\b/i.test(d)) return true;
  if (/\bin[- ]?office\b/i.test(d) || /\bin[- ]?home\b/i.test(d)) return true;

  // Went/go to company office or shop for supplies / equipment pickup
  if (
    /\b(?:went|go(?:ing)?|drove)\s+to\b.*\b(?:office|shop)\b/i.test(d) &&
    /\b(?:pickup|pick\s*up|supplies?|laptop|computers?|mails?|checks?|packages?)\b/i.test(
      d,
    )
  ) {
    return true;
  }

  if (
    /\b(?:clovis|fresno)\s+(?:office|shop)\b/i.test(d) &&
    /\b(?:pickup|pick\s*up|supplies?|laptop|computers?|mails?|checks?|packages?)\b/i.test(
      d,
    )
  ) {
    return true;
  }

  return false;
}

/** Scheduling / planning a future visit — not travel that already happened. */
function isPlanningTravel(description: string): boolean {
  const d = description.toLowerCase();
  // Shared target: job walk / site visit|walk|survey / on-site
  const visitTarget =
    '(?:job(?:\\s+walk)?|site\\s+(?:visit|walk|survey)|on[- ]?site)';
  const aThe = '(?:(?:a|the)\\s+)?';

  return (
    new RegExp(
      String.raw`\bschedul(?:e|ed|ing)\s+${aThe}${visitTarget}\b`,
      'i',
    ).test(d) ||
    new RegExp(
      String.raw`\bprepar(?:e|ed|ing)\s+(?:everything\s+)?(?:for\s+)?${aThe}${visitTarget}\b`,
      'i',
    ).test(d) ||
    new RegExp(
      String.raw`\b(?:plan|planned|planning)\s+(?:for\s+)?${aThe}${visitTarget}\b`,
      'i',
    ).test(d) ||
    // Reverse order: "site visit planned", "job walk scheduled", etc.
    new RegExp(
      String.raw`\b${aThe}${visitTarget}\s+(?:is\s+|was\s+|has\s+been\s+)?(?:planned|planning|scheduled|scheduling|prepared|preparing)\b`,
      'i',
    ).test(d) ||
    /\bplan(?:ning)?\s+to\s+(?:go|visit|travel|schedule|do)\b/i.test(d) ||
    /\b(?:will|going\s+to)\s+(?:schedule|go|visit|travel|do|prepare|plan)\b/i.test(
      d,
    ) ||
    /\bschedule\s+time\s+to\s+go\b/i.test(d) ||
    new RegExp(
      String.raw`\bsetting\s+up\s+${aThe}${visitTarget}\b`,
      'i',
    ).test(d) ||
    new RegExp(
      String.raw`\bsetting\s+everything\s+for\s+${aThe}${visitTarget}\b`,
      'i',
    ).test(d) ||
    /\bfor\s+potential\s+site\s+visit\b/i.test(d) ||
    new RegExp(
      String.raw`\b(?:lined\s+up|line\s+up|lining\s+up)\b.*\b${visitTarget}\b`,
      'i',
    ).test(d) ||
    new RegExp(
      String.raw`\bcoordinat(?:ed|e|ing)\s+.*\b${visitTarget}\b`,
      'i',
    ).test(d)
  );
}

/** Drop planning-only sentences so "scheduled a job walk" doesn't force miles. */
function withoutPlanningSentences(description: string): string {
  const parts = description.split(/(?<=[.!?])\s+|\n+/);
  const kept = parts.filter((part) => {
    const t = part.trim();
    if (!t) return false;
    return !isPlanningTravel(t);
  });
  return kept.join(' ').trim();
}

/** "On site" describes existing equipment/conditions, not employee travel. */
function isSiteReference(description: string): boolean {
  return (
    /\bwhat\s+(?:they|the\s+(?:client|customer|site))\s+(?:currently\s+)?(?:have|has|use|uses)\s+on[- ]?site\b/i.test(
      description,
    ) ||
    /\bmatch(?:es|ed|ing)?\s+what\b.*\bon[- ]?site\b/i.test(description) ||
    /\b(?:existing|current)\s+(?:equipment|settings?|conditions?|configuration)\s+on[- ]?site\b/i.test(
      description,
    ) ||
    /\bon[- ]?site\s+(?:equipment|settings?|conditions?|configuration)\b/i.test(
      description,
    )
  );
}

function hasActualSiteTravel(description: string): boolean {
  return (
    /\bwent\s+(?:to|on)[- ]?site\b/i.test(description) ||
    /\bdrove\b/i.test(description) ||
    /\btravel(?:ed|led|ing)?\s+to\b/i.test(description) ||
    /\bvisited\s+(?:the\s+)?site\b/i.test(description) ||
    /\b(?:performed|completed)\s+(?:a\s+)?(?:job\s+walk|site\s+(?:visit|walk|survey))\b/i.test(
      description,
    )
  );
}

function isProfessionalTravel(description: string): boolean {
  return (
    /\bjob\s+walk\b/i.test(description) ||
    /\bon[- ]?site\b/i.test(description) ||
    /\bsite\s+(?:visit|walk|survey)\b/i.test(description) ||
    /\bpersonal\s+truck\b/i.test(description)
  );
}

function isTravelOnSite(description: string): boolean {
  const d = description.toLowerCase().trim();

  if (d.includes('preparation for site visit')) return false;
  if (d.includes('in-office') || d.includes('in office') || /\bin\s+the\s+office\b/.test(d)) {
    return false;
  }
  if (d.includes('worked in the office') || d.includes('shop and office')) return false;
  if (d.includes('no miles required') || d.includes('there is no miles required')) {
    return false;
  }
  if (isPersonalTravel(description)) return false;
  if (isShopOrOfficeErrand(description)) return false;
  if (isSiteReference(description) && !hasActualSiteTravel(description)) {
    return false;
  }

  // Ignore future scheduling ("Scheduled a job walk…") when checking miles.
  const workText = withoutPlanningSentences(description);
  if (!workText) return false;
  const work = workText.toLowerCase();

  // Clear professional site work always counts.
  if (isProfessionalTravel(workText)) return true;

  // Vague travel verbs alone (went to / drove) only count with job context,
  // not personal destinations like restaurants.
  const travelPatterns = [
    /\btravel\s+to\b/,
    /\btravel\s+and\b/,
    /\bdrove\s+to\b/,
    /\bdrove\b/,
    /\bdriving\b/,
    /\bwent\s+to\s+(?!over\b)/,
  ];
  return travelPatterns.some((p) => p.test(work));
}

function isSiteSurveyTag(tag: string): boolean {
  return tag.trim().toUpperCase() === '101 - SITE SURVEY';
}

/** Non-billable / overhead projects are labeled with a leading * (e.g. *EPS Admin). */
function isNonBillableStarProject(projectLabel: string): boolean {
  return projectLabel.trim().startsWith('*');
}

function isEpsAdminOfficeOrProposalTime(projectLabel: string): boolean {
  // *EPS Admin: Office Time or *EPS Admin: Proposal Time
  if (!isNonBillableStarProject(projectLabel)) return false;
  if (!/\bEPS\s*ADMIN\b/i.test(projectLabel)) return false;
  return (
    /\bOFFICE\s+TIME\b/i.test(projectLabel) ||
    /\bPROPOSAL\s+TIME\b/i.test(projectLabel)
  );
}

/** Projects whose name includes both Admin and Office (e.g. *EPS Admin: Office Time). */
function isAdminOfficeProject(projectLabel: string): boolean {
  const p = projectLabel.toUpperCase();
  return /\bADMIN\b/.test(p) && /\bOFFICE\b/.test(p);
}

function isProposalTime(projectLabel: string): boolean {
  return /PROPOSAL\s+TIME/i.test(projectLabel);
}

function hasJobWalk(description: string): boolean {
  return /\bjob\s+walk\b/i.test(description);
}

function isAdminProject(projectLabel: string, tag: string): boolean {
  if (isNonBillableStarProject(projectLabel)) return true;
  const p = projectLabel.toUpperCase();
  const t = tag.toUpperCase();
  return (
    p.includes('EPS ADMIN') ||
    p.includes('900 SERIES') ||
    t.includes('900 SERIES') ||
    p.includes('OVERHEAD')
  );
}

/** Internal office/shop support that is correctly charged to EPS Admin. */
function isInternalAdminWork(description: string): boolean {
  return (
    /\bEPS(?:\/AllumiaX)?\s+(?:Fresno\s+)?Shop\s+Laptops?\b/i.test(
      description,
    ) ||
    /\bset\s+up\b.*\b(?:laptops?|computers?)\b.*\b(?:interns?|employees?|staff)\b/i.test(
      description,
    ) ||
    /\banswered\s+phone\s+calls\b.*\b(?:follow-up\s+)?emails?\b/i.test(
      description,
    ) ||
    /\breceived\s+packages?\s+from\s+shipping\s+couriers?\b/i.test(
      description,
    ) ||
    /\bdropped\s+off\s+(?:mails?|checks?)\b/i.test(description)
  );
}

function isFutureBillableProject(projectLabel: string): boolean {
  return /future\s+billable/i.test(projectLabel);
}

/** True when the Internal note section already marks work as non-billable. */
function internalNoteSaysNonBillable(description: string): boolean {
  const idx = description.search(/\binternal\s+note\b/i);
  if (idx < 0) return false;
  return /non[-\s]?billable/i.test(description.slice(idx));
}

/** True when the Internal note section already says future billable. */
function internalNoteSaysFutureBillable(description: string): boolean {
  const idx = description.search(/\binternal\s+note\b/i);
  if (idx < 0) return false;
  return /future\s+billable/i.test(description.slice(idx));
}

function splitRowsByUser(rows: PivotRow[]): { name: string; rows: PivotRow[] }[] {
  const sections: { name: string; rows: PivotRow[] }[] = [];
  let current: PivotRow[] = [];
  let currentName = '';

  for (const row of rows) {
    const isNewUser = row.indentLevel === 0 && !row.isEmployeeTotal;
    if (isNewUser && current.length > 0) {
      sections.push({ name: currentName, rows: current });
      current = [];
    }
    if (isNewUser) currentName = row.label;
    current.push(row);
  }
  if (current.length > 0) sections.push({ name: currentName, rows: current });
  return sections;
}

function makeId(
  employeeName: string,
  ruleId: HighlightRuleId,
  matchedText: string,
  projectLabel: string,
): string {
  return `${employeeName}::${ruleId}::${projectLabel}::${matchedText}`.slice(0, 240);
}

function pushUnique(
  list: HighlightProposal[],
  seen: Set<string>,
  proposal: Omit<HighlightProposal, 'id' | 'status'> & { id?: string },
): void {
  const id =
    proposal.id ??
    makeId(
      proposal.employeeName,
      proposal.ruleId,
      `${proposal.triggerText}::${proposal.matchedText}`,
      proposal.projectLabel,
    );
  if (seen.has(id)) return;
  seen.add(id);
  list.push({ ...proposal, id, status: 'pending' });
}

/** One review card per description row — combine multiple rule hits. */
function mergeProposalsByRow(
  proposals: HighlightProposal[],
  mentionUsers: MentionUser[],
): HighlightProposal[] {
  const groups = new Map<string, HighlightProposal[]>();
  for (const p of proposals) {
    const key = `${p.employeeName}::${p.projectLabel}::${p.tag}::${p.matchedText}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const rulePriority: HighlightRuleId[] = [
    'open_job_keyword',
    'future_billable',
    'wrong_coding',
    'billable_keyword',
    'multiple_hour_values_split_entry',
    'missing_miles',
    'odd_miles',
    'miles_in_eps_admin_office_time',
    'admin_office_time',
    'holiday_comp',
    'category_sick',
    'internal_note',
  ];

  const merged: HighlightProposal[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }

    const sorted = [...group].sort(
      (a, b) =>
        rulePriority.indexOf(a.ruleId) - rulePriority.indexOf(b.ruleId),
    );
    const primary = sorted[0]!;

    // Proposal Time + job walk: one future-billable note, not Miles/Billable.
    if (
      isProposalTime(primary.projectLabel) &&
      hasJobWalk(primary.matchedText)
    ) {
      const trigger =
        sentenceContaining(primary.matchedText, [/\bjob\s+walk\b/i]) ||
        primary.triggerText;
      merged.push({
        ...primary,
        id: makeId(
          primary.employeeName,
          'future_billable',
          `${trigger}::${primary.matchedText}`,
          primary.projectLabel,
        ),
        ruleId: 'future_billable',
        ruleLabel: RULE_LABELS.future_billable,
        triggerText: trigger,
        comment: withMentions(mentionUsers, 'This will be future billable?'),
        status: 'pending',
      });
      continue;
    }

    const uniqueComments = [
      ...new Set(sorted.map((g) => g.comment.trim()).filter(Boolean)),
    ];
    const greeting = mentionGreetingRegex(mentionUsers);
    let hasMentionGreeting = false;
    const comments = uniqueComments
      .map((comment) => {
        if (!greeting || !greeting.test(comment)) return comment;
        if (!hasMentionGreeting) {
          hasMentionGreeting = true;
          return comment;
        }
        return comment.replace(greeting, '').trim();
      })
      .filter(Boolean);
    const labels = [...new Set(sorted.map((g) => g.ruleLabel))];
    const triggerText =
      sorted.find((g) => g.triggerText.trim())?.triggerText ??
      primary.triggerText;

    merged.push({
      ...primary,
      id: makeId(
        primary.employeeName,
        primary.ruleId,
        `combined::${triggerText}::${primary.matchedText}`,
        primary.projectLabel,
      ),
      ruleLabel: labels.length === 1 ? labels[0]! : labels.join(' · '),
      triggerText,
      comment: comments.join(' · '),
      status: 'pending',
    });
  }

  return merged;
}

function firstRegexMatchIndex(
  text: string,
  patterns: RegExp[],
): { index: number; length: number; text: string } | null {
  let best: { index: number; length: number; text: string } | null = null;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    const match = re.exec(text);
    if (match?.index != null && match[0]) {
      const candidate = {
        index: match.index,
        length: match[0].length,
        text: match[0],
      };
      if (!best || candidate.index < best.index) best = candidate;
    }
  }
  return best;
}

/** Expand a keyword hit to the full sentence that contains it. */
function sentenceContaining(
  text: string,
  patterns: RegExp[],
): string | null {
  const hit = firstRegexMatchIndex(text, patterns);
  if (!hit) return null;

  let start = hit.index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1]!)) {
    start -= 1;
  }
  while (start < hit.index && /\s/.test(text[start]!)) {
    start += 1;
  }

  let end = hit.index + hit.length;
  while (end < text.length && !/[.!?\n]/.test(text[end]!)) {
    end += 1;
  }
  if (end < text.length && /[.!?]/.test(text[end]!)) {
    end += 1;
  }

  let sentence = text.slice(start, end).trim();

  // No clear sentence punctuation — use the whole description if it's one block
  if (!/[.!?]/.test(text)) {
    sentence = text.trim();
  }

  // Extremely long run-on: keep a readable clause around the hit
  if (sentence.length > 260) {
    const windowStart = Math.max(0, hit.index - 60);
    const windowEnd = Math.min(text.length, hit.index + hit.length + 160);
    let s = windowStart;
    let e = windowEnd;
    while (s > 0 && !/\s/.test(text[s]!)) s -= 1;
    while (e < text.length && !/\s/.test(text[e]!)) e += 1;
    sentence = text.slice(s, e).trim();
  }

  return sentence || hit.text;
}

const RULE_LABELS: Record<HighlightRuleId, string> = {
  missing_miles: 'Missing miles',
  odd_miles: 'Odd miles (0 miles)',
  miles_in_eps_admin_office_time: 'Miles in EPS Admin office time',
  admin_office_time: 'Admin/Office time',
  multiple_hour_values_split_entry: 'Multiple hour values in one entry',
  billable_keyword: 'Possible billable work',
  open_job_keyword: 'Open job / job number needed',
  future_billable: 'Future billable',
  wrong_coding: 'Possible wrong coding',
  holiday_comp: 'Holiday / Comp Time',
  category_sick: 'Sick category correction',
  internal_note: 'Internal note',
};

export function proposeHighlights(
  pivot: PivotData,
  managedUsers: ManagedUser[] = [],
  mentionUsers: MentionUser[] = [],
): HighlightProposal[] {
  const categorySets = buildCategorySets(managedUsers);
  const proposals: HighlightProposal[] = [];
  const seen = new Set<string>();
  const sections = splitRowsByUser(pivot.rows);
  const holidayDates = federalHolidaySetForDates(pivot.dates);
  const employeeFirstNames = collectEmployeeFirstNames(
    managedUsers,
    sections.map((section) => section.name),
  );

  for (const { name: employeeName, rows: sectionRows } of sections) {
    const employeeFirst = firstName(employeeName);
    let currentProjectLabel = '';
    let currentTag = '';

    for (const row of sectionRows) {
      if (row.isEmployeeTotal) break;

      if (row.indentLevel === 1) {
        currentProjectLabel = row.label;
        currentTag = '';
        continue;
      }

      if (row.indentLevel === 2 && row.grandTotal === 0) {
        currentTag = row.label;
        continue;
      }

      if (!(row.indentLevel === 2 && row.grandTotal > 0)) continue;

      const desc = row.label;
      const projectUpper = currentProjectLabel.toUpperCase();

      const travelPatterns = [
        /\bjob\s+walk\b/i,
        /\bsite\s+(?:visit|survey|walk)\b/i,
        /\bon[- ]?site\b/i,
        /\btravel\s+to\b/i,
        /\bpersonal\s+truck\b/i,
        /\bdrove\b/i,
        /\bwent\s+to\b/i,
      ];
      const proposalJobWalk =
        isProposalTime(currentProjectLabel) && hasJobWalk(desc);
      const internalAdminWork = isInternalAdminWork(desc);
      const needsMiles =
        !proposalJobWalk &&
        !internalAdminWork &&
        !isPlanningTravel(desc) &&
        !hasNamedDriver(desc, employeeFirstNames) &&
        (isSiteSurveyTag(currentTag) || isTravelOnSite(desc)) &&
        !hasMiles(desc) &&
        !hasZeroMiles(desc);
      if (needsMiles) {
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'missing_miles',
          ruleLabel: RULE_LABELS.missing_miles,
          matchedText: desc,
          triggerText: sentenceContaining(desc, travelPatterns) || desc.trim(),
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: withMentions(
            mentionUsers,
            'Mention who drove, so the miles can be tracked against that person’s entry.',
          ),
        });
      }

      const zeroMilesSentence = sentenceContaining(desc, [/\b0\s*miles?\b/i]);
      if (zeroMilesSentence) {
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'odd_miles',
          ruleLabel: RULE_LABELS.odd_miles,
          matchedText: desc,
          triggerText: zeroMilesSentence,
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment:
            withMentions(
              mentionUsers,
              'If miles are 0 then why it is mentioned? may be a typo?',
            ),
        });
      }

      if (hasMultipleHourValues(desc)) {
        const hoursSentence = sentenceContaining(desc, [
          /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr)\.?(?=\b|$|[^A-Za-z0-9])/i,
        ]);

        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'multiple_hour_values_split_entry',
          ruleLabel: RULE_LABELS.multiple_hour_values_split_entry,
          matchedText: desc,
          triggerText: hoursSentence || desc.trim(),
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: withMentions(mentionUsers, 'May need to split this entry.'),
        });
      }

      const epsAdminOfficeTimeMilesMentioned =
        isEpsAdminOfficeOrProposalTime(currentProjectLabel) &&
        hasMiles(desc) &&
        !hasZeroMiles(desc);

      if (epsAdminOfficeTimeMilesMentioned) {
        const milesSentence = sentenceContaining(desc, [/\bmiles?\b/i]);
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'miles_in_eps_admin_office_time',
          ruleLabel: RULE_LABELS.miles_in_eps_admin_office_time,
          matchedText: desc,
          triggerText: milesSentence || desc.trim(),
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: withMentions(
            mentionUsers,
            'Miles are mentioned. This may be billable/Future billable?',
          ),
        });
      }

      const jobWalkSentence = sentenceContaining(desc, [/\bjob\s+walk\b/i]);
      const projectAlreadyFutureBillable =
        isFutureBillableProject(currentProjectLabel);

      // Uncertain "future billable?" in the description (question mark or parenthesised)
      const uncertainFutureSentence = sentenceContaining(desc, [
        /future\s+billable\s*\?/i,
        /\(\s*future\s+billable\s*\?\s*\)/i,
      ]);

      // Explicit FUTURE BILLABLE in the description (not the project name —
      // already-coded Future Billable projects should not get a Move-to highlight).
      const explicitFutureSentence =
        (proposalJobWalk
          ? jobWalkSentence || desc.trim()
          : null) ||
        (!uncertainFutureSentence
          ? sentenceContaining(desc, [
              /\(?\s*FUTURE\s+BILLABLE\s*\)?/i,
              /future\s+billable/i,
            ])
          : null);

      const futureSentence = uncertainFutureSentence || explicitFutureSentence;
      if (futureSentence) {
        let futureComment: string | null = null;
        if (proposalJobWalk) {
          futureComment = withMentions(
            mentionUsers,
            'This will be future billable?',
          );
        } else if (uncertainFutureSentence) {
          futureComment = withMentions(
            mentionUsers,
            'Kindly check this is future billable or not?',
          );
        } else if (!projectAlreadyFutureBillable) {
          futureComment = withMentions(
            mentionUsers,
            'Move to future billable category? Take action as needed.',
          );
        }

        if (futureComment) {
          pushUnique(proposals, seen, {
            employeeName,
            ruleId: 'future_billable',
            ruleLabel: RULE_LABELS.future_billable,
            matchedText: desc,
            triggerText: futureSentence,
            projectLabel: currentProjectLabel,
            tag: currentTag,
            comment: futureComment,
          });
        }
      }

      // Project names like "ACC26xxx" are real standing projects, so only the
      // description can signal that a job still needs to be opened.
      const openJobSentence = sentenceContaining(desc, [
        /\*JOB NUMBER NEEDED\*/i,
        /ISSUE NEW JOB/i,
        /\b[A-Z]{2,6}\d{0,2}XXX\b/i,
        /open a job/i,
        /can not find a job/i,
        /couldn't find it on clockify/i,
        /could not find/i,
      ]);
      if (openJobSentence) {
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'open_job_keyword',
          ruleLabel: RULE_LABELS.open_job_keyword,
          matchedText: desc,
          triggerText: openJobSentence,
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: withMentions(
            mentionUsers,
            'Kindly shift this to specific job category, or create a job number and send to him',
          ),
        });
      }

      // "Billable?" only for * projects (non-billable). Job codes without *
      // are already billable — do not propose this comment there.
      const billablePatterns = [
        /\bjob\s+walk\b/i,
        /\bsite\s+(?:visit|survey|walk)\b/i,
        /\bon[- ]?site\b/i,
        /\btravel\s+to\b/i,
        /\bCMC\b/i,
        /\bICE\b/i,
        /\bIECO\b/i,
        /\bTHC\b/i,
        /\bVUE\b/i,
        /\bACE\b/i,
        /\bhospital\b/i,
        /\bValley Unique\b/i,
        /\bSealed Air\b/i,
        /\bSt\.?\s*Agnes\b/i,
      ];
      const billableSentence = sentenceContaining(desc, billablePatterns);
      // Proposal Time job walks are covered by future_billable, not "Billable?".
      // Internal note already saying nonbillable settles billable-work questions.
      if (
        isNonBillableStarProject(currentProjectLabel) &&
        billableSentence &&
        !internalAdminWork &&
        !proposalJobWalk &&
        !internalNoteSaysNonBillable(desc)
      ) {
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'billable_keyword',
          ruleLabel: RULE_LABELS.billable_keyword,
          matchedText: desc,
          triggerText: billableSentence,
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: withMentions(mentionUsers, 'Billable?'),
        });
      }

      const codingPatterns = [
        /\bCMC\b/i,
        /\bICE\b/i,
        /\bIECO\b/i,
        /\bTHC\b/i,
        /\bVUE\b/i,
        /\bACE\b/i,
        /\bhospital\b/i,
        /\bValley Unique\b/i,
        /\bSealed Air\b/i,
        /\bSt\.?\s*Agnes\b/i,
        /\bclient\b/i,
      ];
      const codingSentence = sentenceContaining(desc, codingPatterns);
      if (
        isNonBillableStarProject(currentProjectLabel) &&
        isAdminProject(currentProjectLabel, currentTag) &&
        !internalAdminWork &&
        codingSentence
      ) {
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'wrong_coding',
          ruleLabel: RULE_LABELS.wrong_coding,
          matchedText: desc,
          triggerText: codingSentence,
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: withMentions(mentionUsers, 'Charge to correct job?'),
        });
      }

      // Comp Time only when work is logged ON a federal holiday date.
      // Leave (Holiday / FMLA / Sick / PTO / etc.) is not "worked on holiday".
      if (
        isFullTimeEmployee(employeeName, categorySets) &&
        !isPartTimeHourly(employeeName, categorySets) &&
        !isLeaveProject(currentProjectLabel, currentTag) &&
        !isLeaveDescription(desc)
      ) {
        const workedHolidayDates = pivot.dates.filter(
          (d) => holidayDates.has(d) && (row.dateValues[d] ?? 0) > 0,
        );
        if (workedHolidayDates.length > 0) {
          pushUnique(proposals, seen, {
            employeeName,
            ruleId: 'holiday_comp',
            ruleLabel: RULE_LABELS.holiday_comp,
            matchedText: desc,
            triggerText: desc.trim(),
            projectLabel: currentProjectLabel,
            tag: currentTag,
            comment: withMentions(
              mentionUsers,
              `${workedHolidayDates.join(', ')} was a federal holiday. Will the hours worked be added to Comp Time?`,
            ),
          });
        }
      }

      const sickSentence = sentenceContaining(desc, [/\bsick(?:\s+time)?\b/i]);
      if (sickSentence && !projectUpper.includes('SICK')) {
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'category_sick',
          ruleLabel: RULE_LABELS.category_sick,
          matchedText: desc,
          triggerText: sickSentence,
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: `${employeeFirst}..... Use EPS Admin: Sick Time as project category`,
        });
      }

      const internalNoteSentence = sentenceContaining(desc, [
        /\binternal\s+note\b/i,
      ]);
      // Already on Future Billable with a confirming internal note — no "please note".
      if (
        internalNoteSentence &&
        !(
          isFutureBillableProject(currentProjectLabel) &&
          internalNoteSaysFutureBillable(desc)
        )
      ) {
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'internal_note',
          ruleLabel: RULE_LABELS.internal_note,
          matchedText: desc,
          triggerText: internalNoteSentence,
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: withMentions(mentionUsers, 'please note this point'),
        });
      }

      // Flag every entry coded to an Admin/Office project for review.
      if (isAdminOfficeProject(currentProjectLabel)) {
        pushUnique(proposals, seen, {
          employeeName,
          ruleId: 'admin_office_time',
          ruleLabel: RULE_LABELS.admin_office_time,
          matchedText: desc,
          triggerText: desc.trim(),
          projectLabel: currentProjectLabel,
          tag: currentTag,
          comment: withMentions(
            mentionUsers,
            'Review this Admin/Office Time entry.',
          ),
        });
      }
    }
  }

  return mergeProposalsByRow(proposals, mentionUsers);
}

export function groupProposalsByEmployee(
  proposals: HighlightProposal[],
): { employeeName: string; proposals: HighlightProposal[] }[] {
  const map = new Map<string, HighlightProposal[]>();
  for (const p of proposals) {
    const list = map.get(p.employeeName) ?? [];
    list.push(p);
    map.set(p.employeeName, list);
  }
  return Array.from(map.entries()).map(([employeeName, items]) => ({
    employeeName,
    proposals: items,
  }));
}

export function reviewIsComplete(proposals: HighlightProposal[]): boolean {
  if (proposals.length === 0) return true;
  return proposals.every((p) => p.status === 'accepted' || p.status === 'deleted');
}

export function getAcceptedHighlights(
  proposals: HighlightProposal[],
): HighlightProposal[] {
  return proposals.filter((p) => p.status === 'accepted');
}
