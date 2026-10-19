import type { ClockifyRow } from '../types';

export type ClockifyUserSummary = {
  id: string;
  name: string;
  email: string;
};

export type ClockifyFetchResult =
  | { success: true; data: ClockifyRow[]; label: string }
  | { success: false; error: string };

export type ClockifyUsersResult =
  | { success: true; users: ClockifyUserSummary[] }
  | { success: false; error: string };

export async function fetchClockifyUsers(): Promise<ClockifyUsersResult> {
  try {
    const response = await fetch('/api/clockify/users');
    const payload = (await response.json()) as {
      users?: ClockifyUserSummary[];
      error?: string;
    };

    if (!response.ok) {
      return {
        success: false,
        error: payload.error || `Clockify users fetch failed (${response.status}).`,
      };
    }

    const users = payload.users ?? [];
    if (users.length === 0) {
      return {
        success: false,
        error: 'No active Clockify employees found.',
      };
    }

    return { success: true, users };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to reach Clockify API proxy.',
    };
  }
}

export async function fetchClockifyDetailedRange(
  startDate: string,
  endDate: string,
  employeeNames?: string[],
): Promise<ClockifyFetchResult> {
  try {
    const response = await fetch('/api/clockify/detailed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, employeeNames }),
    });

    const payload = (await response.json()) as {
      rows?: ClockifyRow[];
      count?: number;
      error?: string;
    };

    if (!response.ok) {
      return {
        success: false,
        error: payload.error || `Clockify fetch failed (${response.status}).`,
      };
    }

    const rows = payload.rows ?? [];
    // Allow empty entries when employees were selected — zero-hour PDFs still generate.
    if (rows.length === 0 && (!employeeNames || employeeNames.length === 0)) {
      return {
        success: false,
        error: 'No time entries found for the selected date range and employees.',
      };
    }

    const employeeLabel =
      employeeNames && employeeNames.length > 0
        ? ` · ${employeeNames.length} employee${employeeNames.length === 1 ? '' : 's'}`
        : '';

    return {
      success: true,
      data: rows,
      label: `Clockify ${startDate} to ${endDate}${employeeLabel}`,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to reach Clockify API proxy.',
    };
  }
}
