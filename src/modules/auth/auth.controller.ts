import type { Request, RequestHandler } from 'express';
import { AppError } from '../../shared/errors/AppError.js';
import { sendCreated, sendNoContent, sendOk } from '../../shared/utils/response.js';
import type { AuthService } from './auth.service.js';

const BEARER = /^Bearer\s+(\S+)$/i;

function bearerToken(req: Request): string {
  const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
  if (!token) throw AppError.unauthorized('Token autentikasi tidak ada');
  return token;
}

export function createAuthController(service: AuthService) {
  return {
    register: (async (req, res) => {
      sendCreated(res, await service.register(req.body));
    }) satisfies RequestHandler,

    login: (async (req, res) => {
      sendOk(res, await service.login(req.body));
    }) satisfies RequestHandler,

    google: (async (req, res) => {
      sendOk(res, await service.loginWithGoogle(req.body.id_token));
    }) satisfies RequestHandler,

    refresh: (async (req, res) => {
      sendOk(res, { session: await service.refresh(req.body.refresh_token) });
    }) satisfies RequestHandler,

    // `authenticate` sudah memverifikasi token; di sini hanya dicabut. Identitas tetap dari req.user.
    logout: (async (req, res) => {
      await service.logout(bearerToken(req));
      sendNoContent(res);
    }) satisfies RequestHandler,

    forgotPassword: (async (req, res) => {
      sendOk(res, { message: await service.forgotPassword(req.body) });
    }) satisfies RequestHandler,

    resetPassword: (async (req, res) => {
      await service.resetPassword(req.body);
      sendNoContent(res);
    }) satisfies RequestHandler,
  };
}
