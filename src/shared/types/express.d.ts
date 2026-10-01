// Perluasan Request Express. `user` diisi middleware authenticate dari klaim JWT `sub`;
// tidak pernah dari body, query, atau params.

export interface AuthUser {
  id: string;
  email?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
