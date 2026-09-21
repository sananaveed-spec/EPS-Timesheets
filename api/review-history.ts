import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const INDEX_PREFIX = 'review-history:index:period:';
const ENTRY_PREFIX = 'review-history:entry:';

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

function entryKey(historyId: string): string {
  return `${ENTRY_PREFIX}${historyId}`;
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
    .filter((v): v is ReviewHistoryEntry => v !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

      const entries = await loadPeriodEntries(redis, periodStart, periodEnd);
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

      // Drop older ruleId-keyed duplicates for the same highlight row.
      await deleteRowDuplicates(redis, periodStart, periodEnd, entry, historyId);

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

      if (periodStart && periodEnd && matchedTextNorm && projectLabel && employeeName) {
        const deleted = await deleteRowDuplicates(
          redis,
          periodStart,
          periodEnd,
          { matchedTextNorm, projectLabel, employeeName },
        );
        if (historyId) {
          await redis.del(entryKey(historyId));
          await redis.srem(periodIndexKey(periodStart, periodEnd), historyId);
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
          'Provide historyId, or periodStart+periodEnd+matchedTextNorm+projectLabel+employeeName.',
      });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    res.status(500).json({ error: message });
  }
}
