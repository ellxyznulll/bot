import type { Track } from './types.js';

const base = process.env.MUSIC_API_BASE || 'https://music-xyz-1.vercel.app/api';
const timeoutMs = Number(process.env.MUSIC_API_TIMEOUT || 30000);

async function getJson(path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Provider error ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchMusic(query: string): Promise<Track[]> {
  const body = await getJson(`/search?q=${encodeURIComponent(query)}`);
  return Array.isArray(body?.result) ? body.result : [];
}

/**
 * This adapter keeps the provider server-side. The returned source is only used
 * by the backend and is never exposed as the browser's direct audio URL.
 * Use it with sources you are authorized to download.
 */
export async function resolveDownload(sourceUrl: string): Promise<Track & { mp3?: string }> {
  const body = await getJson(`/download?url=${encodeURIComponent(sourceUrl)}`);
  if (!body?.result) throw new Error('Provider did not return a downloadable track.');
  return body.result as Track & { mp3?: string };
}
