import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const INDEX_KEY = 'feedback-memory:index:fingerprints';
const ENTRY_PREFIX = 'feedback-memory:entry:';

export type FeedbackMemoryEntry = {
  fingerprintId: string;
  ruleId: string;
  triggerTextNorm: string;
  matchedTextNorm: string;
  projectLabel: string;
  employeeName: string;
  reason: string;
  note?: string;
  createdAt: string;
};

function readOptionalApiKey(): string | null {
  // Optional extra protection if you want to require a shared secret header.
  // When unset, the endpoints are left open (still protected by Vercel/KV credentials).
  return process.env.FEEDBACK_MEMORY_API_KEY?.trim() || null;
}

function assertApiKey(req: VercelRequest): boolean {
  const expected = readOptionalApiKey();
  if (!expected) return true;
  const provided = String(req.headers['x-feedback-memory-api-key'] ?? '').trim();
  return Boolean(provided) && provided === expected;
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

  if (!assertApiKey(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const fingerprintsOnly = req.query['fingerprintsOnly'] === '1';
      const maxEntriesRaw = req.query['maxEntries'];
      const maxEntries = Number.isFinite(Number(maxEntriesRaw))
        ? Math.max(1, Number(maxEntriesRaw))
        : 5000;

      const fingerprintIds = await redis.smembers(INDEX_KEY);
      if (!fingerprintIds || fingerprintIds.length === 0) {
        res.status(200).json({ fingerprints: [], entries: [] });
        return;
      }

      if (fingerprintsOnly) {
        res.status(200).json({ fingerprints: fingerprintIds });
        return;
      }

      const keys = fingerprintIds.map((id) => `${ENTRY_PREFIX}${id}`);
      const values = await Promise.all(
        keys.map(async (key) => {
          const entry = await redis.get<FeedbackMemoryEntry>(key);
          return entry ?? null;
        }),
      );

      const entries = values
        .filter((v): v is FeedbackMemoryEntry => v !== null)
        .slice(0, maxEntries)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      res.status(200).json({ entries, fingerprints: fingerprintIds });
      return;
    }

    if (req.method === 'POST') {
      const body = parseBody(req) as Partial<FeedbackMemoryEntry> | null;
      if (!body) {
        res.status(400).json({ error: 'Invalid JSON body.' });
        return;
      }

      const fingerprintId = String(body.fingerprintId ?? '').trim();
      const ruleId = String(body.ruleId ?? '').trim();
      const triggerTextNorm = String(body.triggerTextNorm ?? '').trim();
      const matchedTextNorm = String(body.matchedTextNorm ?? '').trim();
      const projectLabel = String(body.projectLabel ?? '').trim();
      const employeeName = String(body.employeeName ?? '').trim();
      const reason = String(body.reason ?? '').trim();
      const note = body.note != null ? String(body.note).trim() : undefined;
      const createdAt =
        typeof body.createdAt === 'string' && body.createdAt.trim()
          ? body.createdAt
          : new Date().toISOString();

      if (
        !fingerprintId ||
        !ruleId ||
        !triggerTextNorm ||
        !matchedTextNorm ||
        !projectLabel ||
        !employeeName ||
        !reason
      ) {
        res.status(400).json({
          error:
            'Missing required fields: fingerprintId, ruleId, triggerTextNorm, matchedTextNorm, projectLabel, employeeName, reason.',
        });
        return;
      }

      const entry: FeedbackMemoryEntry = {
        fingerprintId,
        ruleId,
        triggerTextNorm,
        matchedTextNorm,
        projectLabel,
        employeeName,
        reason,
        note: note || undefined,
        createdAt,
      };

      const entryKey = `${ENTRY_PREFIX}${fingerprintId}`;
      await redis.set(entryKey, entry);
      await redis.sadd(INDEX_KEY, fingerprintId);

      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const fingerprintId = req.query['fingerprintId']
        ? String(req.query['fingerprintId']).trim()
        : '';

      if (fingerprintId) {
        await redis.del(`${ENTRY_PREFIX}${fingerprintId}`);
        await redis.srem(INDEX_KEY, fingerprintId);
        res.status(200).json({ ok: true, deletedFingerprintId: fingerprintId });
        return;
      }

      // Clear all
      const fingerprintIds = await redis.smembers(INDEX_KEY);
      if (fingerprintIds && fingerprintIds.length > 0) {
        await Promise.all(
          fingerprintIds.map((id) => redis.del(`${ENTRY_PREFIX}${id}`)),
        );
      }
      await redis.del(INDEX_KEY);

      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    res.status(500).json({ error: message });
  }
}

