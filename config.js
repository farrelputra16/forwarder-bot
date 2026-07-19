import dotenv from 'dotenv';
dotenv.config();

export const config = {
  telegram: {
    apiId: parseInt(process.env.TELEGRAM_API_ID),
    apiHash: process.env.TELEGRAM_API_HASH,
    session: process.env.TELEGRAM_SESSION || '',
  },
  botToken: process.env.BOT_TOKEN,
  targetChannel: 'https://t.me/fnfonchain'
};
