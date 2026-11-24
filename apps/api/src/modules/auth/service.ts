import bcrypt from 'bcryptjs';
import type { PublicUser } from '@relay/shared';
import { pool } from '../../db/pool';
import { conflict, isUniqueViolation, unauthorized } from '../../lib/errors';

// bcrypt cost factor. Each +1 doubles the time to hash - and the time an
// attacker needs per guess. 10 is roughly 50-100 ms on a laptop.
const BCRYPT_ROUNDS = 10;

// Compared against when the email does not exist, so a login attempt takes the
// same time whether or not the account exists (no user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export interface SignupInput {
  username: string;
  email: string;
  password: string;
}

export async function signup(input: SignupInput): Promise<PublicUser> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username`,
      [input.username, input.email, passwordHash],
    );
    return { id: rows[0].id, username: rows[0].username };
  } catch (err) {
    // Let the database enforce uniqueness. Checking first with a SELECT would
    // leave a race between two simultaneous signups.
    if (isUniqueViolation(err)) throw conflict('That username or email is already taken');
    throw err;
  }
}

export async function login(email: string, password: string): Promise<PublicUser> {
  const { rows } = await pool.query(
    'SELECT id, username, password_hash FROM users WHERE email = $1',
    [email],
  );
  const row = rows[0] as { id: string; username: string; password_hash: string } | undefined;
  const matches = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !matches) throw unauthorized('Wrong email or password');
  return { id: row.id, username: row.username };
}

export async function getUser(userId: string): Promise<PublicUser | null> {
  const { rows } = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
  return rows[0] ? { id: rows[0].id, username: rows[0].username } : null;
}
