# Forwarder-Bot AI Skills — Reference

## Overview
- Bot ini memantau channel Telegram, mengekstrak CA (Solana/EVM), dan mem-forward ke channel target.
- Mode: `extract` (hanya CA) atau `forward` (pesan utuh).
- Fitur: Manajemen channel interaktif (Start/Pause/Delete), Target forward per-channel, dan Filter pesan.

## Telegram Commands (BotFather)
```
start - Start the bot and show menu
add_channel - Add a new channel to monitor
list_channels - Manage monitored channels (pause/delete)
set_mode - Set processing mode: /set_mode <channel> <extract|forward>
set_target - Set a specific target: /set_target <channel> <target_channel>
```

## Logic
### Extraction
- `extractAddresses(text)`: Menggunakan Regex untuk mencari alamat Solana (Base58) dan EVM (0x).

### Resolution
- `resolveAndJoin(identifier)`: 
  1. Mencoba `client.getEntity(identifier)` (paling aman).
  2. Mencari di `client.getDialogs()` (daftar chat yang diikuti).
  3. Menggunakan `ImportChatInvite` (terakhir, jika perlu).

## Fixing "AUTH_KEY_UNREGISTERED" Error
Error ini berarti `TELEGRAM_SESSION` di `.env` Anda **sudah tidak valid/kedaluwarsa**.

**Cara memperbaiki:**
1. Hapus isi `TELEGRAM_SESSION` di file `.env`.
2. Jalankan skrip generator sesi untuk mendapatkan sesi baru:
   ```bash
   node -e "import { TelegramClient } from 'telegram'; import { StringSession } from 'telegram/sessions/index.js'; import input from 'input'; const apiId = parseInt(process.env.TELEGRAM_API_ID); const apiHash = process.env.TELEGRAM_API_HASH; const client = new TelegramClient(new StringSession(''), apiId, apiHash, {}); await client.start({ phoneNumber: () => input.text('Phone: '), phoneCode: () => input.text('Code: '), password: () => input.text('Pass: ') }); console.log(client.session.save());"
   ```
3. Paste string sesi baru ke `.env`.
4. Restart bot (`node index.js`).
