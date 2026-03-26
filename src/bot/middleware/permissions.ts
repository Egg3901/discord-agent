import { config } from '../../config.js';

export function isAdmin(userId: string): boolean {
  return config.ADMIN_USER_IDS.includes(userId);
}
