# GMGN AI Skills — Reference

## Repository
- GitHub: https://github.com/GMGNAI/gmgn-skills
- Docs: https://gmgn.ai/ai
- Skills JSON: https://gmgn.ai/static/opstatic/skills.json (403 without auth)

## Install All Skills
```sh
npx skills add GMGNAI/gmgn-skills
```

## Install gmgn-cli
```sh
npm install -g gmgn-cli
```

## Configure API Key
```sh
mkdir -p ~/.config/gmgn
# Create API Key at https://gmgn.ai/ai → paste below
echo 'GMGN_API_KEY=your_key_here' > ~/.config/gmgn/.env
chmod 600 ~/.config/gmgn/.env
```

Verify:
```sh
gmgn-cli config --check
```
Or test with public key:
```sh
GMGN_API_KEY=gmgn_solbscbaseethmonadtron gmgn-cli market trending --chain sol --interval 1h --limit 3
```

## Installed Skills (6)

| Skill | Function | Install |
|-------|----------|---------|
| `gmgn-token` | Token info, security, pool, holders, traders | Already in skill list |
| `gmgn-market` | K-line, trending, trenches, signal, hot-searches | Already in skill list |
| `gmgn-portfolio` | Wallet holdings, P&L, win rate, stats | Already in skill list |
| `gmgn-track` | Smart Money/KOL trades, followed tokens | Already in skill list |
| `gmgn-swap` | Buy/sell, limit orders, TP/SL, batch trading | Already in skill list |
| `gmgn-cooking` | One-command launch + TP/SL flow | Already in skill list |

## Quick Command Reference

```
gmgn-cli token info --chain sol --address <CA>
gmgn-cli token security --chain sol --address <CA>
gmgn-cli token holders --chain sol --address <CA> --tag smart_degen
gmgn-cli token traders --chain sol --address <CA> --tag smart_degen
gmgn-cli market trending --chain sol --interval 1h --order-by volume --limit 20
gmgn-cli market kline --chain sol --address <CA> --resolution 1h --from <ts> --to <ts>
gmgn-cli market trenches --chain sol --type new_creation --filter-preset safe
```

## How to Search for a Specific Skill
Tell the agent what you need (e.g., "I need to check if a token is a honeypot"), and the agent will search the installed skills and recommend `gmgn-token` or whichever matches.

## Bot Integration (forwarder-bot)

### Extract CA from text
- `extractAddresses(text)` — finds Solana addresses (base58, 32 bytes)
- `extractEVMAddresses(text)` — finds EVM addresses (`0x` + 40 hex)
- `extractCAFromDexScreener(text)` — finds DexScreener URLs, resolves via DexScreener API → returns `{ca, chain}`

### Chain Resolution
- `resolveChain(ca)` — uses DexScreener search API to find which chain a CA belongs to
- For DexScreener URLs: chain extracted from URL path
- For Solana raw addresses: chain = `sol`
- For EVM raw addresses: resolved via `resolveChain`

### Token Info (GMGN)
After forwarding each CA, bot calls `gmgn-cli token info --chain <chain> --address <ca> --raw` and forwards a formatted summary:

```
🪙 $SYMBOL — Name
🏭 Pump.fun · 2h ago
💵 $0.000042  📈 +15.2%
💰 MC $42.7K  │  💧 Liq $17.1K  │  👥 1,234
🧠 SM 5  │  🏆 KOL 2
📊 1h Vol $18  │  24h Vol $2.5K
🐦 @twitter  │  💬 TG  │  🌐 Web
```

### APIs used
| API | Endpoint | Purpose |
|-----|----------|---------|
| DexScreener | `GET /latest/dex/search?q=<pairOrCA>` | Resolve pair → CA, or CA → chain |
| GMGN CLI | `gmgn-cli token info --chain <chain> --address <ca> --raw` | Token info |

### Telegram Commands (BotFather)
```
start - Start the bot and show menu
add_channel - Add a new channel to monitor
list_channels - Manage monitored channels (pause/delete)
set_mode - Set processing mode: /set_mode <channel> <extract|forward>
set_target - Set a specific target: /set_target <channel> <target_channel>
refresh - Refresh token info: /refresh <CA> [chain]
```

### Output Format (extract mode)
1. **CA** (fast, via MTProto)
2. **Token Summary + SM/KOL counts + inline buttons** (via Bot API)
   - 🧠 SM 5 button → tap to see Smart Money wallets
   - 🏆 KOL 2 button → tap to see KOL wallets

### Summary with Buttons
```
🪙 $HOODBIRD — Hoodbird
⛓️ ROBINHOOD · uniswap
💵 $0.000014  📉 -19.4%
💰 MC $14.1K  │  💧 Liq $8.2K
👥 1,234  │  🧠 SM 0  │  🏆 KOL 0
📊 1h Vol $1.1K  │  24h Vol $10.4K
🐦 X  │  💬 TG

🧠 SM 5  🏆 KOL 2
[ 🧠 Show Smart Money (5) ]
[ 🏆 Show KOL (2) ]
```

### Wallet Preview (via button tap)
```
🧠 Smart Money Top 5:
🥇 ABC...xyz — +$12.5K · 5.2%
   https://gmgn.ai/sol/address/...
🥈 DEF...uvw — +$8.1K · 3.1%
   https://gmgn.ai/sol/address/...
🏆 KOL Top 5:
🥇 GHI...rst — +$2.3K · 1.2%
   https://gmgn.ai/sol/address/...
```

### Telegram Commands (BotFather)
