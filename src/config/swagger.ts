import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './openapi.js';

/** Dokumentasi interaktif di /api-docs dan spesifikasi mentah di /api-docs.json. */
export function mountSwagger(app: Express): void {
  const document = buildOpenApiDocument();

  app.get('/api-docs.json', (_req, res) => {
    res.json(document);
  });
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(document, { customSiteTitle: 'Cashify API' }),
  );
}
