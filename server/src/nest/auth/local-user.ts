import { randomBytes } from 'node:crypto';
import { db } from '../../db/database';
import type { User } from '../../types';
import { readEnv } from '../../app-config';

export function isLocalSingleUser(): boolean {
  return readEnv().agent.localSingleUser;
}

/** A real ownership row, without issuing or requiring credentials. */
export function localUser(): User | null {
  if (!isLocalSingleUser()) return null;
  const email = 'local@travel-agent.invalid';
  db.prepare('INSERT OR IGNORE INTO users (username, email, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 0)')
    .run('travel-agent', email, randomBytes(32).toString('hex'), 'admin');
  return db.prepare('SELECT id, username, email, role FROM users WHERE email = ?').get(email) as User;
}
