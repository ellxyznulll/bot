import path from 'node:path';
import fs from 'node:fs';
import type { TelegramUser, Track } from './types.js';

type StoredUser = TelegramUser & { created_at: number; updated_at: number };
type StoredItem = { telegram_id: number; track: Track; created_at: number };
type Store = { users: Record<string, StoredUser>; history: StoredItem[]; favorites: StoredItem[] };

const dbPath = process.env.DATABASE_PATH || './data/mdiscover.json';
const absolute = path.resolve(dbPath);
fs.mkdirSync(path.dirname(absolute), { recursive: true });

const emptyStore = (): Store => ({ users: {}, history: [], favorites: [] });

function load(): Store {
  try {
    if (!fs.existsSync(absolute)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8')) as Partial<Store>;
    return {
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : []
    };
  } catch {
    const backup = `${absolute}.broken-${Date.now()}`;
    try { fs.renameSync(absolute, backup); } catch {}
    return emptyStore();
  }
}

let store = load();

function save() {
  const temp = `${absolute}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store), 'utf8');
  fs.renameSync(temp, absolute);
}

export function upsertUser(user: TelegramUser) {
  const key = String(user.id);
  const now = Date.now();
  const previous = store.users[key];
  store.users[key] = {
    ...previous,
    ...user,
    created_at: previous?.created_at ?? now,
    updated_at: now
  };
  save();
}

function sameTrack(a: Track, b: Track) {
  const ak = a.link || a.sourceUrl || String(a.id || '');
  const bk = b.link || b.sourceUrl || String(b.id || '');
  return Boolean(ak && bk && ak === bk);
}

export function addHistory(telegramId: number, track: Track) {
  store.history = store.history.filter(item => !(item.telegram_id === telegramId && sameTrack(item.track, track)));
  store.history.unshift({ telegram_id: telegramId, track, created_at: Date.now() });
  const own = store.history.filter(item => item.telegram_id === telegramId).slice(0, 100);
  const other = store.history.filter(item => item.telegram_id !== telegramId);
  store.history = [...own, ...other];
  save();
}

export function getHistory(telegramId: number): Track[] {
  return store.history
    .filter(item => item.telegram_id === telegramId)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 100)
    .map(item => item.track);
}

export function toggleFavorite(telegramId: number, track: Track) {
  const index = store.favorites.findIndex(item => item.telegram_id === telegramId && sameTrack(item.track, track));
  if (index >= 0) {
    store.favorites.splice(index, 1);
    save();
    return false;
  }
  store.favorites.unshift({ telegram_id: telegramId, track, created_at: Date.now() });
  const own = store.favorites.filter(item => item.telegram_id === telegramId).slice(0, 100);
  const other = store.favorites.filter(item => item.telegram_id !== telegramId);
  store.favorites = [...own, ...other];
  save();
  return true;
}

export function getFavorites(telegramId: number): Track[] {
  return store.favorites
    .filter(item => item.telegram_id === telegramId)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 100)
    .map(item => item.track);
}

export function clearHistory(telegramId: number) {
  store.history = store.history.filter(item => item.telegram_id !== telegramId);
  save();
}
