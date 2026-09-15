export interface ClockifyRow {
  Project: string;
  Client: string;
  Description: string;
  Activity: string;
  User: string;
  Group: string;
  Email: string;
  Tags: string;
  Type: string;
  Billable: string;
  Invoiced: string;
  'Invoice ID': string;
  'Start Date': string;
  'Start Time': string;
  'End Date': string;
  'End Time': string;
  'Duration (h)': string;
  'Duration (decimal)': string;
  'Billable Rate (USD)': string;
  'Billable Amount (USD)': string;
  'Date of creation': string;
}

export type IndentLevel = 0 | 1 | 2;

export interface PivotRow {
  label: string;
  indentLevel: IndentLevel;
  dateValues: Record<string, number>;
  grandTotal: number;
  isEmployeeTotal?: boolean;
}

export interface PivotData {
  /** Date columns shown in the detail pivot (days with hours). */
  dates: string[];
  dateLabels: string[];
  rows: PivotRow[];
  reportTitle: string;
  /** Selected report range for SUMMARY "Time period" (may include empty days). */
  periodStart?: string;
  periodEnd?: string;
}

export type EmployeeCategory =
  | 'full-time-salaried'
  | 'full-time-hourly'
  | 'part-time-hourly';

export interface ManagedUser {
  id: string;
  name: string;
  category: EmployeeCategory;
  /** Clockify workspace user id — source of truth for the display name. */
  clockifyUserId?: string;
}

export interface MentionUser {
  id: string;
  name: string;
  clockifyUserId?: string;
}

/** Clockify employee assigned to an EPS office or shop category. */
export interface OfficeMember {
  id: string;
  name: string;
  clockifyUserId?: string;
}

/** EPS office/shop category with its own member list (like Manage Users). */
export interface OfficeCategory {
  id: string;
  name: string;
  members: OfficeMember[];
}
