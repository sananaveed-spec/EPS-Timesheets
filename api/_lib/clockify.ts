import { formatInTimeZone } from 'date-fns-tz';

const CLOCKIFY_BASE_URL = 'https://api.clockify.me/api/v1';
const MAX_RETRIES = 4;
const ENTRY_PAGE_SIZE = 5000;

export type ClockifyUser = {
  id: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'PENDING_EMAIL_VERIFICATION' | 'DECLINED';
};

export type ClockifyTimeEntry = {
  id: string;
  description?: string | null;
  userId?: string;
  projectId: string | null;
  project?: { id: string; name: string; clientName?: string } | null;
  tags?: { id: string; name: string }[] | null;
  timeInterval: {
    start: string;
    end: string | null;
    duration: string | null;
  };
};

/** Minimal row shape the converter pipeline needs (matches Clockify CSV columns). */
export type ClockifyCsvRow = {
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
};

type ClientConfig = {
  apiKey: string;
  workspaceId: string;
  timezone: string;
};

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'X-Api-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIsoDurationToSeconds(duration: string | null): number {
  if (!duration) return 0;
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export function getTimeEntrySeconds(entry: ClockifyTimeEntry): number {
  const fromDuration = parseIsoDurationToSeconds(entry.timeInterval.duration);
  if (fromDuration > 0) return fromDuration;

  if (!entry.timeInterval.end) {
    const startMs = new Date(entry.timeInterval.start).getTime();
    return Math.max(Math.floor((Date.now() - startMs) / 1000), 0);
  }

  const startMs = new Date(entry.timeInterval.start).getTime();
  const endMs = new Date(entry.timeInterval.end).getTime();
  return Math.max(Math.floor((endMs - startMs) / 1000), 0);
}

/**
 * Build Clockify time-entry filter bounds for a calendar date range.
 *
 * Clockify's `/user/{id}/time-entries` `start`/`end` params are interpreted as
 * workspace-local wall times (even when a `Z` suffix is present). Converting
 * local midnight to real UTC (e.g. 07:00Z for America/Los_Angeles) shifts the
 * window forward and drops early-day entries — which showed up as short days
 * like Zulfi 7/1 = 2h instead of 8h.
 *
 * `timezone` is kept for call-site compatibility; entry → date mapping still
 * uses `formatInTimeZone` separately.
 */
export function dateRangeToISO(
  startDate: string,
  endDate: string,
  _timezone: string,
): { startISO: string; endISO: string } {
  // Parameter kept for call-site compatibility.
  void _timezone;
  return {
    startISO: `${startDate}T00:00:00.000Z`,
    endISO: `${endDate}T23:59:59.999Z`,
  };
}

function formatHms(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function emptyRow(): ClockifyCsvRow {
  return {
    Project: '',
    Client: '',
    Description: '',
    Activity: '',
    User: '',
    Group: '',
    Email: '',
    Tags: '',
    Type: '',
    Billable: '',
    Invoiced: '',
    'Invoice ID': '',
    'Start Date': '',
    'Start Time': '',
    'End Date': '',
    'End Time': '',
    'Duration (h)': '',
    'Duration (decimal)': '',
    'Billable Rate (USD)': '',
    'Billable Amount (USD)': '',
    'Date of creation': '',
  };
}

export function mapEntryToCsvRow(
  entry: ClockifyTimeEntry,
  user: ClockifyUser | undefined,
  timezone: string,
): ClockifyCsvRow {
  const seconds = getTimeEntrySeconds(entry);
  const start = entry.timeInterval.start;
  const end = entry.timeInterval.end;
  const tags = (entry.tags ?? []).map((t) => t.name).filter(Boolean).join(', ');

  return {
    ...emptyRow(),
    Project: entry.project?.name?.trim() || 'No project',
    Client: entry.project?.clientName?.trim() || '',
    Description: entry.description?.trim() || '',
    User: user?.name?.trim() || 'Unknown user',
    Email: user?.email?.trim() || '',
    Tags: tags,
    'Start Date': formatInTimeZone(start, timezone, 'M/d/yyyy'),
    'Start Time': formatInTimeZone(start, timezone, 'HH:mm:ss'),
    'End Date': end ? formatInTimeZone(end, timezone, 'M/d/yyyy') : '',
    'End Time': end ? formatInTimeZone(end, timezone, 'HH:mm:ss') : '',
    'Duration (h)': formatHms(seconds),
    'Duration (decimal)': (seconds / 3600).toFixed(4),
  };
}

class ClockifyClient {
  private readonly apiKey: string;
  private readonly workspaceId: string;

  constructor(config: Pick<ClientConfig, 'apiKey' | 'workspaceId'>) {
    this.apiKey = config.apiKey;
    this.workspaceId = config.workspaceId;
  }

  private async fetchWithRetry(url: string | URL): Promise<Response> {
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      const response = await fetch(url, {
        headers: buildHeaders(this.apiKey),
        cache: 'no-store',
      });

      if (response.status !== 429) return response;
      if (attempt === MAX_RETRIES) return response;

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : 1000 * 2 ** attempt;
      await sleep(retryMs);
      attempt += 1;
    }
    throw new Error('Clockify retry loop unexpectedly ended.');
  }

  async getActiveUsers(): Promise<ClockifyUser[]> {
    const url = `${CLOCKIFY_BASE_URL}/workspaces/${this.workspaceId}/users`;
    const response = await this.fetchWithRetry(url);
    if (!response.ok) {
      throw new Error(`Clockify users request failed: ${response.status}`);
    }
    const users = (await response.json()) as ClockifyUser[];
    return users
      .filter((user) => user.status === 'ACTIVE')
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getUserTimeEntriesForRange(
    userId: string,
    startISO: string,
    endISO: string,
  ): Promise<ClockifyTimeEntry[]> {
    const all: ClockifyTimeEntry[] = [];
    let page = 1;

    while (true) {
      const url = new URL(
        `${CLOCKIFY_BASE_URL}/workspaces/${this.workspaceId}/user/${userId}/time-entries`,
      );
      url.searchParams.set('start', startISO);
      url.searchParams.set('end', endISO);
      url.searchParams.set('hydrated', 'true');
      url.searchParams.set('page-size', String(ENTRY_PAGE_SIZE));
      url.searchParams.set('page', String(page));

      const response = await this.fetchWithRetry(url);
      if (!response.ok) {
        throw new Error(
          `Clockify time entries request failed: ${response.status}`,
        );
      }

      const batch = (await response.json()) as ClockifyTimeEntry[];
      all.push(...batch);
      if (batch.length < ENTRY_PAGE_SIZE) break;
      page += 1;
    }

    return all;
  }
}

export function createClockifyClientFromEnv(env: Record<string, string>): {
  client: ClockifyClient;
  timezone: string;
} {
  const apiKey = env.CLOCKIFY_API_KEY?.trim();
  const workspaceId = env.CLOCKIFY_WORKSPACE_ID?.trim();
  const timezone =
    env.CLOCKIFY_WORKSPACE_TIMEZONE?.trim() || 'America/Los_Angeles';

  if (!apiKey || !workspaceId) {
    throw new Error(
      'Missing CLOCKIFY_API_KEY or CLOCKIFY_WORKSPACE_ID in environment.',
    );
  }

  return {
    client: new ClockifyClient({ apiKey, workspaceId }),
    timezone,
  };
}

const USER_CONCURRENCY = 4;

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export type ClockifyUserSummary = {
  id: string;
  name: string;
  email: string;
};

export async function fetchActiveUsersFromEnv(
  env: Record<string, string>,
): Promise<ClockifyUserSummary[]> {
  const { client } = createClockifyClientFromEnv(env);
  const users = await client.getActiveUsers();
  return users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
  }));
}

export async function fetchDetailedRowsForRange(
  env: Record<string, string>,
  startDate: string,
  endDate: string,
  userNames?: string[],
): Promise<ClockifyCsvRow[]> {
  const { client, timezone } = createClockifyClientFromEnv(env);
  const { startISO, endISO } = dateRangeToISO(startDate, endDate, timezone);
  let users = await client.getActiveUsers();

  if (userNames && userNames.length > 0) {
    const selected = new Set(userNames.map((name) => name.trim()).filter(Boolean));
    users = users.filter((user) => selected.has(user.name));
    if (users.length === 0) {
      throw new Error('No matching Clockify employees found for the selection.');
    }
  }

  const userById = new Map(users.map((u) => [u.id, u]));

  const entryBatches = await mapPool(users, USER_CONCURRENCY, async (user) => {
    const entries = await client.getUserTimeEntriesForRange(
      user.id,
      startISO,
      endISO,
    );
    return entries.map((entry) =>
      mapEntryToCsvRow(entry, userById.get(user.id) ?? user, timezone),
    );
  });

  return entryBatches.flat();
}
