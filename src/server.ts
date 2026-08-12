import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { upsertUser, addHistory, getHistory, getFavorites, toggleFavorite, clearHistory as dbClearHistory } from './db.js';
import { validateTelegramInitData } from './telegram-auth.js';
import { resolveDownload, searchMusic } from './provider.js';
import type { TelegramUser, Track } from './types.js';
import { bot } from './bot.js';

const app = express();
const port = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const configuredOrigins = String(process.env.CORS_ORIGIN || '*').split(',').map(x => x.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.includes('*') || configuredOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed.'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'Accept'],
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));

type AuthedRequest = Request & { telegramUser?: TelegramUser };

function auth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const token = process.env.BOT_TOKEN;
    if (!token) return res.status(500).json({ error: 'BOT_TOKEN is not configured.' });
    const initData = String(req.header('X-Telegram-Init-Data') || '');
    const user = validateTelegramInitData(initData, token);
    upsertUser(user);
    req.telegramUser = user;
    next();
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : 'Unauthorized' });
  }
}

app.get('/api/health', (_req, res) => res.json({ status: true, api: 'online' }));

app.get('/api/config', (_req, res) => res.json({ status: true, telegramMiniApp: true, publicWebAppUrl: process.env.PUBLIC_WEBAPP_URL || null }));

app.get('/api/search', auth, async (req: AuthedRequest, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ result: [] });
    const result = await searchMusic(query);
    res.json({ result: result.slice(0, 30) });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Search failed.' });
  }
});

app.get('/api/me', auth, async (req: AuthedRequest, res) => {
  const user = req.telegramUser!;
  let profilePhotoUrl = user.photo_url;
  try {
    const photos = await bot.getUserProfilePhotos(user.id, { limit: 1 });
    const photo = photos.photos?.[0]?.at(-1);
    if (photo?.file_id) profilePhotoUrl = await bot.getFileLink(photo.file_id);
  } catch {}
  res.json({ user, profilePhotoUrl });
});

app.get('/api/history', auth, (req: AuthedRequest, res) => res.json({ result: getHistory(req.telegramUser!.id) }));
app.delete('/api/history', auth, (req: AuthedRequest, res) => { dbClearHistory(req.telegramUser!.id); res.json({ ok: true }); });
app.post('/api/history', auth, (req: AuthedRequest, res) => {
  const track = req.body?.track as Track;
  if (!track?.link && !track?.sourceUrl) return res.status(400).json({ error: 'Track link is required.' });
  addHistory(req.telegramUser!.id, track);
  res.json({ ok: true });
});

app.get('/api/favorites', auth, (req: AuthedRequest, res) => res.json({ result: getFavorites(req.telegramUser!.id) }));
app.post('/api/favorites', auth, (req: AuthedRequest, res) => {
  const track = req.body?.track as Track;
  if (!track?.link && !track?.sourceUrl) return res.status(400).json({ error: 'Track link is required.' });
  res.json({ added: toggleFavorite(req.telegramUser!.id, track) });
});

app.get('/api/resolve', auth, async (req: AuthedRequest, res) => {
  try {
    const sourceUrl = String(req.query.url || '');
    if (!sourceUrl) return res.status(400).json({ error: 'Track URL is required.' });
    const meta = await resolveDownload(sourceUrl);
    if (!meta.mp3 && !meta.audioUrl) return res.status(502).json({ error: 'Provider returned no audio file.' });
    res.json({ result: { ...meta, sourceUrl } });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Resolve failed.' });
  }
});

app.get('/api/download', auth, async (req: AuthedRequest, res) => {
  try {
    const sourceUrl = String(req.query.url || '');
    if (!sourceUrl) return res.status(400).json({ error: 'Track URL is required.' });
    const meta = await resolveDownload(sourceUrl);
    const remoteUrl = meta.mp3 || meta.audioUrl;
    if (!remoteUrl) return res.status(502).json({ error: 'Provider returned no audio file.' });
    const response = await fetch(remoteUrl);
    if (!response.ok || !response.body) return res.status(502).json({ error: 'Audio source could not be fetched.' });
    const title = String(meta.title || 'music').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'music';
    res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/"/g, '')}.mp3"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const reader = response.body.getReader();
    res.on('close', () => reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once('drain', resolve));
    }
    res.end();
    addHistory(req.telegramUser!.id, meta);
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: error instanceof Error ? error.message : 'Download failed.' });
    else res.end();
  }
});

export { app };
export async function startServer() {
  return new Promise<void>(resolve => app.listen(port, () => { console.log(`MDISCOVER API listening on :${port}`); resolve(); }));
}
