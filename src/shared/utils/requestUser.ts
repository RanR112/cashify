import type { Request } from 'express';
import { AppError } from '../errors/AppError.js';
import type { AuthUser } from '../types/express.js';

/**
 * Satu-satunya jalan controller memperoleh identitas: `req.user`, diisi middleware
 * authenticate dari klaim JWT `sub` (aturan 8). Body, query, params, dan header tidak
 * pernah dibaca untuk ini.
 */
export function requireUser(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized('Token autentikasi tidak ada');
  return req.user;
}
