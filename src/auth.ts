import type { NextFunction, Request, Response } from 'express';
import type { User } from '@supabase/supabase-js';
import { supabase } from './db.js';

export interface AuthedRequest extends Request {
  authUser: User;
}

/**
 * Verifies the Supabase session JWT (Authorization: Bearer <token>).
 * The dashboard signs in with Supabase Auth; the token it gets is
 * checked here via supabase.auth.getUser().
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  (req as AuthedRequest).authUser = data.user;
  next();
}