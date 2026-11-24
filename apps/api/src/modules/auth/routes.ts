import { Router } from 'express';
import { z } from 'zod';
import { USERNAME_PATTERN } from '@relay/shared';
import { config } from '../../config';
import { unauthorized } from '../../lib/errors';
import { asyncHandler, currentUser } from '../../lib/http';
import { requireAuth, signToken } from '../../middleware/auth';
import { clientIp, rateLimit } from '../../middleware/rateLimit';
import { getUser, login, signup } from './service';

const signupSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_PATTERN, 'use 3-32 lowercase letters, digits or underscores'),
  email: z.string().trim().toLowerCase().email().max(254),
  // bcrypt only reads the first 72 bytes, so longer passwords are rejected rather than silently truncated.
  password: z.string().min(8, 'must be at least 8 characters').max(72),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(72),
});

// Password endpoints are the obvious target for guessing attacks: limit by IP.
const authLimiter = rateLimit({
  name: 'auth',
  limit: config.authRateLimitPerMinute,
  windowMs: 60_000,
  key: clientIp,
});

export const authRouter = Router();

authRouter.post(
  '/auth/signup',
  authLimiter,
  asyncHandler(async (req, res) => {
    const user = await signup(signupSchema.parse(req.body));
    res.status(201).json({ token: signToken(user), user });
  }),
);

authRouter.post(
  '/auth/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await login(email, password);
    res.json({ token: signToken(user), user });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await getUser(currentUser(req).id);
    // A valid token for a user that no longer exists.
    if (!user) throw unauthorized();
    res.json(user);
  }),
);
