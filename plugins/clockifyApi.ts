import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { loadEnv } from 'vite';
import {
  fetchActiveUsersFromEnv,
  fetchDetailedRowsForRange,
} from '../api/_lib/clockify';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function createHandler(env: Record<string, string>): Connect.NextHandleFunction {
  const reviewHistoryUpstream =
    env.VITE_FEEDBACK_API_URL?.trim().replace(/\/$/, '') ||
    'https://eps-timesheets.vercel.app/api';

  return async (req, res, next) => {
    const rawUrl = req.url ?? '';
    const url = rawUrl.split('?')[0];

    if (url === '/api/review-history') {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      try {
        const query = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
        const upstreamUrl = `${reviewHistoryUpstream}/review-history${query}`;
        const init: RequestInit = {
          method: req.method,
          headers: { 'Content-Type': 'application/json' },
        };
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          init.body = JSON.stringify(body ?? {});
        }
        const upstream = await fetch(upstreamUrl, init);
        const text = await upstream.text();
        res.statusCode = upstream.status;
        res.setHeader(
          'Content-Type',
          upstream.headers.get('content-type') || 'application/json',
        );
        res.end(text);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Review history proxy failed.';
        sendJson(res, 502, { error: message });
      }
      return;
    }

    if (url === '/api/clockify/users') {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      try {
        const users = await fetchActiveUsersFromEnv(env);
        sendJson(res, 200, { users, count: users.length });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Clockify request failed.';
        sendJson(res, 500, { error: message });
      }
      return;
    }

    if (url !== '/api/clockify/detailed') {
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    try {
      const body = (await readJsonBody(req)) as {
        startDate?: string;
        endDate?: string;
        employeeNames?: string[];
      };
      const startDate = body.startDate?.trim() ?? '';
      const endDate = body.endDate?.trim() ?? '';
      const employeeNames = Array.isArray(body.employeeNames)
        ? body.employeeNames
            .filter((name): name is string => typeof name === 'string')
            .map((name) => name.trim())
            .filter(Boolean)
        : undefined;

      if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
        sendJson(res, 400, {
          error: 'startDate and endDate must be YYYY-MM-DD.',
        });
        return;
      }

      if (startDate > endDate) {
        sendJson(res, 400, {
          error: 'startDate must be on or before endDate.',
        });
        return;
      }

      const rows = await fetchDetailedRowsForRange(
        env,
        startDate,
        endDate,
        employeeNames,
      );
      sendJson(res, 200, { rows, count: rows.length });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Clockify request failed.';
      sendJson(res, 500, { error: message });
    }
  };
}

export function clockifyApiPlugin(): Plugin {
  return {
    name: 'clockify-api',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '');
      server.middlewares.use(createHandler(env));
    },
    configurePreviewServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '');
      server.middlewares.use(createHandler(env));
    },
  };
}
