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

function periodIndexKey(periodStart: string, periodEnd: string): string {
  return `${INDEX_PREFIX}${periodStart}::${periodEnd}`;
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

      const indexKey = periodIndexKey(periodStart, periodEnd);
      const historyIds = await redis.smembers(indexKey);
      if (!historyIds || historyIds.length === 0) {
        res.status(200).json({ entries: [] });
        return;
      }

      const values = await Promise.all(
        historyIds.map(async (id) => {
          const entry = await redis.get<ReviewHistoryEntry>(
            `${ENTRY_PREFIX}${id}`,
          );
          return entry ?? null;
        }),
      );

      const entries = values
        .filter((v): v is ReviewHistoryEntry => v !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

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
      const periodStart = String(body.periodStart ?? '').trim();
      const periodEnd = String(body.periodEnd ?? '').trim();
      const ruleId = String(body.ruleId ?? '').trim();
      const matchedTextNorm = String(body.matchedTextNorm ?? '').trim();
      const projectLabel = String(body.projectLabel ?? '').trim();
      const employeeName = String(body.employeeName ?? '').trim();
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

      await redis.set(`${ENTRY_PREFIX}${historyId}`, entry);
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

      if (historyId) {
        await redis.del(`${ENTRY_PREFIX}${historyId}`);
        if (periodStart && periodEnd) {
          await redis.srem(periodIndexKey(periodStart, periodEnd), historyId);
        }
        res.status(200).json({ ok: true, deletedHistoryId: historyId });
        return;
      }

      res.status(400).json({ error: 'historyId is required to delete.' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    res.status(500).json({ error: message });
  }
}
