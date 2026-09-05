import { readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { startDevDatabase } from './dev-database';

/**
 * Serve `api/*.ts` from the Vite dev server the way Vercel serves them in
 * production, so `npm run dev` is the whole product and not just the half that
 * doesn't need a database. The alternative is asking anyone who wants to try it
 * locally to install the Vercel CLI and log in first.
 *
 * Handlers load through `ssrLoadModule`, so they hot-reload and share the engine
 * source with the client build. One copy of the code, two runtimes.
 */
export function apiRoutes(): Plugin {
  return {
    name: 'api-routes',
    async configureServer(server) {
      // Only when nothing real is configured. A DATABASE_URL in .env wins.
      if (!process.env.DATABASE_URL) {
        const seeded = await startDevDatabase();
        server.config.logger.info(`  \u001b[32m\u2713\u001b[0m dev database ready (${seeded})`);
      }

      const dir = resolve(server.config.root, 'api');
      const routes = new Set(
        readdirSync(dir)
          .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
          .map((f) => f.replace(/\.ts$/, '')),
      );

      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (!path.startsWith('/api/')) return next();

        const route = path.slice('/api/'.length);
        if (!routes.has(route)) return next();

        void (async () => {
          try {
            const mod = await server.ssrLoadModule(`/api/${route}.ts`);
            const handler = mod.default as (req: unknown, res: unknown) => Promise<void>;
            await handler(await withBody(req), asVercelResponse(res));
          } catch (e) {
            server.ssrFixStacktrace(e as Error);
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
        })();
      });
    },
  };
}

/** Vercel hands the handler a parsed `body`. Node's raw request doesn't have one. */
async function withBody(req: IncomingMessage): Promise<IncomingMessage & { body: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body: unknown = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw; // let the handler report the parse failure with its own message
    }
  }
  return Object.assign(req, { body });
}

/** The two response helpers the handlers use, over a plain `ServerResponse`. */
function asVercelResponse(res: ServerResponse) {
  return Object.assign(res, {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    json(value: unknown) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
      return this;
    },
  });
}
