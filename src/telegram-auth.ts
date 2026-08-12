import crypto from 'node:crypto';
import type { TelegramUser } from './types.js';

function checkString(data: string, botToken: string): boolean {
  const params = new URLSearchParams(data);
  const receivedHash = params.get('hash');
  if (!receivedHash) return false;

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  });
  pairs.sort();

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculated = crypto
    .createHmac('sha256', secret)
    .update(pairs.join('\n'))
    .digest('hex');

  return calculated.length === receivedHash.length &&
    crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(receivedHash));
}

export function validateTelegramInitData(initData: string, botToken: string): TelegramUser {
  if (!initData) throw new Error('Telegram Mini App authorization is required.');
  if (!checkString(initData, botToken)) throw new Error('Invalid Telegram authorization data.');

  const params = new URLSearchParams(initData);
  const authDate = Number(params.get('auth_date') || 0);
  const maxAge = 24 * 60 * 60;
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAge) {
    throw new Error('Telegram authorization data has expired.');
  }

  const rawUser = params.get('user');
  if (!rawUser) throw new Error('Telegram user data is missing.');

  const user = JSON.parse(rawUser) as TelegramUser;
  if (!user?.id || !user.first_name) throw new Error('Invalid Telegram user.');
  return user;
}
