import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const INDEX_PREFIX = 'review-history:index:period:';
const ENTRY_PREFIX = 'review-history:entry:';
const PERIODS_CATALOG_KEY = 'review-history:periods';

export type ReviewHistoryEntry = {
  historyId: string;
  periodStart: string;
  periodEnd: string;
  ruleId: string;
  matchedTextNorm: string;
  projectLabel: string;
  employeeName: string;
  status: 'accepted' | 'deleted';
  triggerText: string;
  comment: string;
  updatedAt: string;
};

function getRedis(): Redis | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL?.trim() ||
    process.env.KV_REST_API_URL?.trim();
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ||
    process.env.KV_REST_API_TOKEN?.trim();
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function normalizeText(text: string): string {
  return text
    .toString()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function periodIndexKey(periodStart: string, periodEnd: string): string {
  return `${INDEX_PREFIX}${normalizeText(periodStart)}::${normalizeText(periodEnd)}`;
}

function periodCatalogValue(periodStart: string, periodEnd: string): string {
  return `${normalizeText(periodStart)}::${normalizeText(periodEnd)}`;
}

function entryKey(historyId: string): string {
  return `${ENTRY_PREFIX}${historyId}`;
}

/** Parse MM/DD/YYYY or YYYY-MM-DD to a UTC day timestamp for overlap checks. */
function parsePeriodDate(value: string): number | null {
  const t = normalizeText(value);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) {
    return Date.UTC(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
    );
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (us) {
    return Date.UTC(
      Number(us[3]),
      Number(us[1]) - 1,
      Number(us[2]),
    );
  }
  return null;
}

function periodsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  const as = parsePeriodDate(aStart);
  const ae = parsePeriodDate(aEnd);
  const bs = parsePeriodDate(bStart);
  const be = parsePeriodDate(bEnd);
  if (as == null || ae == null || bs == null || be == null) {
    // Fall back to exact-period match when dates cannot be parsed.
    return (
      normalizeText(aStart) === normalizeText(bStart) &&
      normalizeText(aEnd) === normalizeText(bEnd)
    );
  }
  return as <= be && bs <= ae;
}

function splitPeriodCatalogValue(
  value: string,
): { start: string; end: string } | null {
  const idx = value.indexOf('::');
  if (idx <= 0) return null;
  const start = value.slice(0, idx);
  const end = value.slice(idx + 2);
  if (!start || !end) return null;
  return { start, end };
}

function sameRow(
  a: Pick<
    ReviewHistoryEntry,
    'matchedTextNorm' | 'projectLabel' | 'employeeName'
  >,
  b: Pick<
    ReviewHistoryEntry,
    'matchedTextNorm' | 'projectLabel' | 'employeeName'
  >,
): boolean {
  return (
    normalizeText(a.matchedTextNorm) === normalizeText(b.matchedTextNorm) &&
    normalizeText(a.projectLabel) === normalizeText(b.projectLabel) &&
    normalizeText(a.employeeName) === normalizeText(b.employeeName)
  );
}

function rowKey(
  entry: Pick<
    ReviewHistoryEntry,
    'matchedTextNorm' | 'projectLabel' | 'employeeName'
  >,
): string {
  return [
    normalizeText(entry.matchedTextNorm),
    normalizeText(entry.projectLabel),
    normalizeText(entry.employeeName),
  ].join('::');
}

function mergeEntriesByRowNewest(
  entries: ReviewHistoryEntry[],
): ReviewHistoryEntry[] {
  const sorted = [...entries].sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt),
  );
  const byRow = new Map<string, ReviewHistoryEntry>();
  for (const entry of sorted) {
    byRow.set(rowKey(entry), entry);
  }
  return Array.from(byRow.values()).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

async function loadPeriodEntries(
  redis: Redis,
  periodStart: string,
  periodEnd: string,
): Promise<ReviewHistoryEntry[]> {
  const indexKey = periodIndexKey(periodStart, periodEnd);
  const historyIds = await redis.smembers(indexKey);
  if (!historyIds || historyIds.length === 0) return [];

  const values = await Promise.all(
    historyIds.map(async (id) => {
      const entry = await redis.get<ReviewHistoryEntry>(entryKey(id));
      return { id, entry: entry ?? null };
    }),
  );

  const staleIds = values.filter((v) => v.entry == null).map((v) => v.id);
  if (staleIds.length > 0) {
    await redis.srem(indexKey, ...staleIds);
  }

  return values
    .map((v) => v.entry)
    .filter((v): v is ReviewHistoryEntry => v !== null);
}

/** Discover period indexes (backfills catalog for periods saved before catalog existed). */
async function listKnownPeriods(redis: Redis): Promise<string[]> {
  const found = new Set<string>(
    ((await redis.smembers(PERIODS_CATALOG_KEY)) as string[] | null) ?? [],
  );

  let cursor: string | number = 0;
  for (let i = 0; i < 30; i += 1) {
    const result = (await redis.scan(cursor, {
      match: `${INDEX_PREFIX}*`,
      count: 100,
    })) as [string | number, string[]];
    const next = result[0];
    const keys = result[1] ?? [];
    for (const key of keys) {
      if (!key.startsWith(INDEX_PREFIX)) continue;
      const suffix = key.slice(INDEX_PREFIX.length);
      if (suffix.includes('::')) found.add(suffix);
    }
    cursor = next;
    if (cursor === 0 || cursor === '0') break;
  }

  if (found.size > 0) {
    for (const member of found) {
      await redis.sadd(PERIODS_CATALOG_KEY, member);
    }
  }
  return Array.from(found);
}

/** Load exact period plus any catalog periods that overlap the requested range. */
async function loadOverlappingPeriodEntries(
  redis: Redis,
  periodStart: string,
  periodEnd: string,
): Promise<ReviewHistoryEntry[]> {
  const catalog = await listKnownPeriods(redis);
  const periodPairs = new Map<string, { start: string; end: string }>();

  periodPairs.set(periodCatalogValue(periodStart, periodEnd), {
    start: normalizeText(periodStart),
    end: normalizeText(periodEnd),
  });

  for (const raw of catalog) {
    const parsed = splitPeriodCatalogValue(raw);
    if (!parsed) continue;
    if (periodsOverlap(periodStart, periodEnd, parsed.start, parsed.end)) {
      periodPairs.set(periodCatalogValue(parsed.start, parsed.end), {
        start: parsed.start,
        end: parsed.end,
      });
    }
  }

  const batches = await Promise.all(
    Array.from(periodPairs.values()).map((p) =>
      loadPeriodEntries(redis, p.start, p.end),
    ),
  );
  return mergeEntriesByRowNewest(batches.flat());
}

async function deleteRowDuplicates(
  redis: Redis,
  periodStart: string,
  periodEnd: string,
  row: Pick<
    ReviewHistoryEntry,
    'matchedTextNorm' | 'projectLabel' | 'employeeName'
  >,
  keepHistoryId?: string,
): Promise<number> {
  const entries = await loadPeriodEntries(redis, periodStart, periodEnd);
  const indexKey = periodIndexKey(periodStart, periodEnd);
  let deleted = 0;
  for (const entry of entries) {
    if (keepHistoryId && entry.historyId === keepHistoryId) continue;
    if (!sameRow(entry, row)) continue;
    await redis.del(entryKey(entry.historyId));
    await redis.srem(indexKey, entry.historyId);
    deleted += 1;
  }
  return deleted;
}

/** Remove a highlight-row decision from every known period index. */
async function deleteRowAcrossCatalog(
  redis: Redis,
  row: Pick<
    ReviewHistoryEntry,
    'matchedTextNorm' | 'projectLabel' | 'employeeName'
  >,
  keepHistoryId?: string,
): Promise<number> {
  const catalog = await listKnownPeriods(redis);
  let deleted = 0;
  for (const raw of catalog) {
    const parsed = splitPeriodCatalogValue(raw);
    if (!parsed) continue;
    deleted += await deleteRowDuplicates(
      redis,
      parsed.start,
      parsed.end,
      row,
      keepHistoryId,
    );
  }
  return deleted;
}

function parseBody(req: VercelRequest): unknown {
  if (req.body == null) return null;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const redis = getRedis();
  if (!redis) {
    res.status(503).json({
      error:
        'Review history is not configured. Add Upstash/KV Redis env vars, then redeploy.',
    });
    return;
  }

  try {
    if (req.method === 'GET') {
      const periodStart = String(req.query['periodStart'] ?? '').trim();
      const periodEnd = String(req.query['periodEnd'] ?? '').trim();
      if (!periodStart || !periodEnd) {
        res.status(400).json({ error: 'periodStart and periodEnd are required.' });
        return;
      }

      const entries = await loadOverlappingPeriodEntries(
        redis,
        periodStart,
        periodEnd,
      );
      res.status(200).json({ entries });
      return;
    }

    if (req.method === 'POST') {
      const body = parseBody(req) as Partial<ReviewHistoryEntry> | null;
      if (!body) {
        res.status(400).json({ error: 'Invalid JSON body.' });
        return;
      }

      const historyId = String(body.historyId ?? '').trim();
      const periodStart = normalizeText(String(body.periodStart ?? ''));
      const periodEnd = normalizeText(String(body.periodEnd ?? ''));
      const ruleId = String(body.ruleId ?? '').trim();
      const matchedTextNorm = normalizeText(String(body.matchedTextNorm ?? ''));
      const projectLabel = normalizeText(String(body.projectLabel ?? ''));
      const employeeName = normalizeText(String(body.employeeName ?? ''));
      const status = String(body.status ?? '').trim();
      const triggerText = String(body.triggerText ?? '').trim();
      const comment = String(body.comment ?? '').trim();
      const updatedAt =
        typeof body.updatedAt === 'string' && body.updatedAt.trim()
          ? body.updatedAt
          : new Date().toISOString();

      if (
        !historyId ||
        !periodStart ||
        !periodEnd ||
        !ruleId ||
        !matchedTextNorm ||
        !projectLabel ||
        !employeeName ||
        (status !== 'accepted' && status !== 'deleted')
      ) {
        res.status(400).json({
          error:
            'Missing required fields: historyId, periodStart, periodEnd, ruleId, matchedTextNorm, projectLabel, employeeName, status (accepted|deleted).',
        });
        return;
      }

      const entry: ReviewHistoryEntry = {
        historyId,
        periodStart,
        periodEnd,
        ruleId,
        matchedTextNorm,
        projectLabel,
        employeeName,
        status,
        triggerText,
        comment,
        updatedAt,
      };

      // Register period, drop older same-row duplicates across all known periods.
      await redis.sadd(PERIODS_CATALOG_KEY, periodCatalogValue(periodStart, periodEnd));
      await deleteRowAcrossCatalog(redis, entry, historyId);

      await redis.set(entryKey(historyId), entry);
      await redis.sadd(periodIndexKey(periodStart, periodEnd), historyId);

      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const historyId = req.query['historyId']
        ? String(req.query['historyId']).trim()
        : '';
      const periodStart = String(req.query['periodStart'] ?? '').trim();
      const periodEnd = String(req.query['periodEnd'] ?? '').trim();
      const matchedTextNorm = String(req.query['matchedTextNorm'] ?? '').trim();
      const projectLabel = String(req.query['projectLabel'] ?? '').trim();
      const employeeName = String(req.query['employeeName'] ?? '').trim();

      if (matchedTextNorm && projectLabel && employeeName) {
        const deleted = await deleteRowAcrossCatalog(
          redis,
          { matchedTextNorm, projectLabel, employeeName },
        );
        if (historyId) {
          await redis.del(entryKey(historyId));
          if (periodStart && periodEnd) {
            await redis.srem(
              periodIndexKey(periodStart, periodEnd),
              historyId,
            );
          }
        }
        res.status(200).json({ ok: true, deletedCount: deleted });
        return;
      }

      if (historyId) {
        await redis.del(entryKey(historyId));
        if (periodStart && periodEnd) {
          await redis.srem(periodIndexKey(periodStart, periodEnd), historyId);
        }
        res.status(200).json({ ok: true, deletedHistoryId: historyId });
        return;
      }

      res.status(400).json({
        error:
          'Provide historyId, or matchedTextNorm+projectLabel+employeeName.',
      });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    res.status(500).json({ error: message });
  }
}
