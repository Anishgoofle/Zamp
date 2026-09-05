import type { VercelRequest, VercelResponse } from '@vercel/node';
import { HttpError, message } from './_db';

/**
 * The shape every endpoint here shares: POST only, JSON in, JSON out, and a
 * thrown `HttpError` becomes its status rather than a 500 with a stack trace.
 */
export function postJson<T>(
  handler: (body: Record<string, unknown>, req: VercelRequest) => Promise<T>,
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'POST only' });
      return;
    }
    try {
      res.status(200).json(await handler(parseBody(req.body), req));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      // Connection strings carry passwords; they arrive in the body and must not
      // come back out in an error, a log line, or a stack trace.
      res.status(status).json({ error: redact(message(e)) });
    }
  };
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Body is not valid JSON.');
    }
  }
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

/** `postgres://user:hunter2@host/db` → `postgres://user:***@host/db`. */
function redact(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/[^:@\s]+:)[^@\s]+@/gi, '$1***@');
}

export function requireString(
  body: Record<string, unknown>,
  key: string,
  fallback?: string,
): string {
  const value = body[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new HttpError(400, `Missing "${key}".`);
}
