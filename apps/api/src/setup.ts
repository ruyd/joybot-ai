import type { INestApplication } from '@nestjs/common';
import { json, type RequestHandler } from 'express';

/**
 * What every app instance needs, in main.ts and in tests: the /api prefix, and larger JSON bodies
 * where they are expected (website pages with many modules; MCP, whose upload_site_image carries an
 * image as base64). Everything else keeps the default 100 kB. These run before Nest's own parsers,
 * which then see the body already read and leave it alone.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.use('/api/website', largeJson('2mb'));
  app.use('/api/mcp', largeJson('8mb'));
}

/** Wrapped so it is not named "jsonParser": Nest skips its own JSON parser when it finds one by that name. */
function largeJson(limit: string): RequestHandler {
  const parse = json({ limit });
  return function largeJsonParser(req, res, next) {
    parse(req, res, next);
  };
}
