import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { rateLimit } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { createAuthController } from './auth.controller.js';
import {
  forgotPasswordBodySchema,
  googleBodySchema,
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
} from './auth.schema.js';
import type { AuthService } from './auth.service.js';

/** `verifyAuth` bisa disuntik di test; bawaannya middleware authenticate yang asli. */
export function createAuthRouter(service: AuthService, verifyAuth: RequestHandler = authenticate): Router {
  const controller = createAuthController(service);
  const router = Router();

  // Satu instance dipakai bersama: login password dan Google berbagi hitungan 5 / 15 menit / IP.
  const loginLimiter = rateLimit('login');

  router.post('/register', rateLimit('register'), validate({ body: registerBodySchema }), asyncHandler(controller.register));
  router.post('/login', loginLimiter, validate({ body: loginBodySchema }), asyncHandler(controller.login));
  router.post('/google', loginLimiter, validate({ body: googleBodySchema }), asyncHandler(controller.google));
  router.post('/refresh', validate({ body: refreshBodySchema }), asyncHandler(controller.refresh));
  router.post('/logout', verifyAuth, asyncHandler(controller.logout));
  router.post('/forgot-password', validate({ body: forgotPasswordBodySchema }), asyncHandler(controller.forgotPassword));
  router.post('/reset-password', validate({ body: resetPasswordBodySchema }), asyncHandler(controller.resetPassword));

  return router;
}
