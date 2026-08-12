export type Track = {
  id?: number | string;
  title?: string;
  channel?: string;
  artist?: string;
  album?: string;
  duration?: string;
  thumbnail?: string;
  imageUrl?: string;
  link?: string;
  sourceUrl?: string;
  audioUrl?: string;
  createdAt?: number | string;
};

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
};
