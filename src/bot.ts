import TelegramBot, { type Message } from 'node-telegram-bot-api';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { addHistory, getHistory, upsertUser } from './db.js';
import { searchMusic, resolveDownload } from './provider.js';
import type { Track } from './types.js';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN is required.');

export const bot = new TelegramBot(token, { polling: String(process.env.BOT_POLLING || 'true').toLowerCase() === 'true' });

const selections = new Map<string, { userId: number; link: string; expiresAt: number }>();
const tempRoot = path.resolve(process.env.TEMP_DIR || './data/tmp');
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const fallbackThumb = path.resolve(thisDir, '../assets/fallback-thumb.jpg');
fs.mkdirSync(tempRoot, { recursive: true });

function safeName(name: string) {
  return String(name || 'music').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'music';
}

function thumbnailUrl(track: Track) {
  if (track.thumbnail || track.imageUrl) return track.thumbnail || track.imageUrl;
  const link = String(track.link || track.sourceUrl || '');
  const id = link.match(/[?&]v=([\w-]{11})/)?.[1] || link.match(/youtu\.be\/([\w-]{11})/)?.[1];
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}

async function downloadToFile(url: string, filePath: string) {
  const response = await fetch(url, { headers: { Accept: '*/*' } });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(filePath));
}

async function prepareTrackFiles(track: Track & { mp3?: string; audioUrl?: string }) {
  const audioUrl = track.mp3 || track.audioUrl;
  if (!audioUrl) throw new Error('No audio file was returned.');
  const base = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const title = safeName(track.title || 'music');
  const audioPath = path.join(tempRoot, `${base}.mp3`);
  const thumbPath = path.join(tempRoot, `${base}.jpg`);
  await downloadToFile(audioUrl, audioPath);

  const remoteThumb = thumbnailUrl(track);
  if (remoteThumb) {
    try {
      await downloadToFile(remoteThumb, thumbPath);
      const stat = await fs.promises.stat(thumbPath);
      if (stat.size > 190 * 1024) fs.copyFileSync(fallbackThumb, thumbPath);
    } catch {
      fs.copyFileSync(fallbackThumb, thumbPath);
    }
  } else {
    fs.copyFileSync(fallbackThumb, thumbPath);
  }

  if (!fs.existsSync(thumbPath) || (await fs.promises.stat(thumbPath)).size === 0) {
    throw new Error('Thumbnail could not be prepared.');
  }

  return { audioPath, thumbPath, filename: `${title}.mp3` };
}

async function cleanupFiles(...files: string[]) {
  for (const file of files) { try { await fs.promises.rm(file, { force: true }); } catch {} }
}

function rememberSelection(userId: number, link: string) {
  const key = crypto.randomBytes(8).toString('hex');
  selections.set(key, { userId, link, expiresAt: Date.now() + 10 * 60 * 1000 });
  return key;
}
function takeSelection(userId: number, key: string) {
  const item = selections.get(key);
  selections.delete(key);
  if (!item || item.userId !== userId || item.expiresAt < Date.now()) return null;
  return item.link;
}
function trackText(track: Track) {
  return [track.title || 'Untitled', track.channel || track.artist || 'Unknown artist', track.duration ? `Duration: ${track.duration}` : ''].filter(Boolean).join('\n');
}

async function sendTrack(chatId: number, userId: number, track: Track & { mp3?: string; audioUrl?: string }) {
  const files = await prepareTrackFiles(track);
  try {
    await bot.sendAudio(chatId, files.audioPath, {
      title: safeName(track.title || 'Music'),
      performer: track.channel || track.artist || 'MDISCOVER',
      caption: trackText(track),
      thumb: files.thumbPath
    }, { filename: files.filename, contentType: 'audio/mpeg' });
    addHistory(userId, track);
  } finally {
    await cleanupFiles(files.audioPath, files.thumbPath);
  }
}

async function openApp(chatId: number) {
  const url = process.env.PUBLIC_WEBAPP_URL;
  if (!url) { await bot.sendMessage(chatId, 'Mini App belum dikonfigurasi. Isi PUBLIC_WEBAPP_URL di .env.'); return; }
  await bot.sendMessage(chatId, 'MDISCOVER siap.', { reply_markup: { inline_keyboard: [[{ text: 'Open MDISCOVER', web_app: { url } }], [{ text: 'Search music', switch_inline_query_current_chat: '' }]] } });
}

bot.onText(/^\/start(?:\s+.*)?$/i, async message => {
  if (message.from) upsertUser({ id: message.from.id, first_name: message.from.first_name, last_name: message.from.last_name, username: message.from.username, language_code: message.from.language_code });
  await openApp(message.chat.id);
});

bot.onText(/^\/help$/i, async message => bot.sendMessage(message.chat.id, 'MDISCOVER commands:\n\n/start — open the Mini App\n/search <query> — search music\n/history — recent activity\n/help — help'));

bot.onText(/^\/history$/i, async message => {
  if (!message.from) return;
  const history = getHistory(message.from.id).slice(0, 8);
  if (!history.length) return void await bot.sendMessage(message.chat.id, 'Belum ada history.');
  const lines = history.map((track, i) => `${i + 1}. ${track.title || 'Untitled'} — ${track.channel || track.artist || 'Unknown'}`);
  await bot.sendMessage(message.chat.id, `Recent history:\n${lines.join('\n')}`);
});

bot.onText(/^\/search\s+(.+)$/i, async (message, match) => {
  if (!message.from || !match?.[1]) return;
  try {
    const results = await searchMusic(match[1].trim());
    if (!results.length) return void await bot.sendMessage(message.chat.id, 'Tidak ada hasil.');
    const rows = results.slice(0, 8).map((track, index) => [{ text: `${index + 1}. ${(track.title || 'Untitled').slice(0, 45)}`, callback_data: `track:${rememberSelection(message.from!.id, track.link || '')}` }]);
    await bot.sendMessage(message.chat.id, `Results for: ${match[1].trim()}`, { reply_markup: { inline_keyboard: rows } });
  } catch (error) { await bot.sendMessage(message.chat.id, `Search failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
});

bot.on('callback_query', async query => {
  const data = query.data || '';
  const message = query.message;
  if (!message || !query.from) return;
  try {
    if (!data.startsWith('track:')) return;
    const link = takeSelection(query.from.id, data.slice(6));
    if (!link) throw new Error('This result has expired. Search again.');
    await bot.answerCallbackQuery(query.id, { text: 'Preparing track...' });
    const resolved = await resolveDownload(link);
    await sendTrack(message.chat.id, query.from.id, resolved);
    await bot.answerCallbackQuery(query.id, { text: 'Track sent.' });
    try {
      await bot.deleteMessage(message.chat.id, message.message_id);
    } catch {
    }
  } catch (error) {
    try { await bot.answerCallbackQuery(query.id, { text: error instanceof Error ? error.message.slice(0, 180) : 'Request failed', show_alert: true }); } catch {}
  }
});

bot.on('inline_query', async query => {
  const q = query.query.trim();
  if (!q) return void await bot.answerInlineQuery(query.id, [], { cache_time: 1 });
  try {
    const results = await searchMusic(q);
    const articles = results.slice(0, 10).map((track, index) => ({ type: 'article' as const, id: `${query.id}-${index}`, title: track.title || 'Untitled', description: track.channel || track.artist || 'Unknown artist', input_message_content: { message_text: `MDISCOVER — ${track.title || 'Untitled'}\n${track.channel || track.artist || ''}\n${track.link || ''}` } }));
    await bot.answerInlineQuery(query.id, articles, { cache_time: 10, is_personal: true });
  } catch { await bot.answerInlineQuery(query.id, [], { cache_time: 1, is_personal: true }); }
});

bot.on('polling_error', error => console.error('Telegram polling error:', error.message));
setInterval(() => { const now = Date.now(); for (const [key, item] of selections) if (item.expiresAt <= now) selections.delete(key); }, 60_000).unref();