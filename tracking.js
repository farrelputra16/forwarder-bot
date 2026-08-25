import fs from 'fs';
import { fetchDexScreenerInfo, forwardMessage } from './scraper.js';

const DB_FILE = './tracking.json';

let trackings = {};
let checkTimer = null;

function flatMC(n) {
  if (!n || isNaN(n)) return '?';
  return n >= 1_000_000_000 ? '$' + (n / 1_000_000_000).toFixed(1) + 'B' :
         n >= 1_000_000 ? '$' + (n / 1_000_000).toFixed(1) + 'M' :
         n >= 1_000 ? '$' + (n / 1_000).toFixed(1) + 'K' :
         '$' + Number(n).toFixed(2);
}

function load() {
  if (fs.existsSync(DB_FILE)) {
    trackings = JSON.parse(fs.readFileSync(DB_FILE));
  }
}

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(trackings, null, 2));
}

export function initTrackings() {
  load();
  if (Object.keys(trackings).length) startChecker();
}

export function addTracking({ ca, chain, calledAtPrice, calledAtMC, symbol, target, owner, multipliers, alertInterval, periodic, xAlerts }) {
  const key = `${chain}_${ca}`;
  if (trackings[key]) return;
  trackings[key] = {
    ca, chain, calledAtPrice, calledAtMC, symbol,
    target,
    owner: owner ? String(owner) : '',
    multipliers: multipliers || [2, 3, 5, 10],
    alertInterval: (alertInterval || 3600) * 1000,
    lastAlertIdx: -1,
    lastUpdate: Date.now(),
    createdAt: Date.now(),
    periodic: periodic || 'on',
    xAlerts: xAlerts || 'on',
  };
  save();
  startChecker();
}

export function removeTracking(ca, chain) {
  delete trackings[`${chain}_${ca}`];
  save();
  if (!Object.keys(trackings).length && checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

export function getActiveCount() {
  return Object.keys(trackings).length;
}

function startChecker() {
  if (checkTimer) return;
  checkTimer = setInterval(checkAll, 60_000);
}

async function checkAll() {
  for (const [key, t] of Object.entries(trackings)) {
    try {
      const dexInfo = await fetchDexScreenerInfo(t.ca);
      if (!dexInfo) continue;

      const curPrice = parseFloat(dexInfo.price);
      if (!curPrice || curPrice === 0) continue;

      const mult = curPrice / t.calledAtPrice;
      const pct = (mult - 1) * 100;
      const changeStr = mult >= 2 ? `${mult.toFixed(1)}X` : `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;

      // multiplier alerts
      if (t.xAlerts !== 'paused' && t.xAlerts !== 'off') {
        for (let i = t.lastAlertIdx + 1; i < t.multipliers.length; i++) {
          const threshold = t.multipliers[i];
          if (mult >= threshold) {
            const mc = flatMC(dexInfo.marketCap);
            const label = t.symbol || t.ca.slice(0, 6) + '...' + t.ca.slice(-4);
            const msg =
`🚀 ${threshold}X MULTIPLIER 🚀
━━━━━━━━━━━━━━━━━━━━
${label}
⚡ ${t.calledAtMC}  →  💰 ${mc}

${t.ca}
━━━━━━━━━━━━━━━━━━━━`;
            await forwardMessage(t.target, msg, 'html', t.owner || undefined);
            t.lastAlertIdx = i;
          }
        }
      }

      // periodic update
      if (t.periodic !== 'paused' && t.periodic !== 'off') {
        if (Date.now() - t.lastUpdate >= t.alertInterval) {
          const mc = flatMC(dexInfo.marketCap);
          const label = t.symbol || t.ca.slice(0, 6) + '...' + t.ca.slice(-4);
          const msg =
`🔄 PRICE UPDATE
━━━━━━━━━━━━━━━━━━━━
${label}
⚡ ${t.calledAtMC}  →  💰 ${mc}
📈 ${changeStr} from call

${t.ca}
━━━━━━━━━━━━━━━━━━━━`;
          await forwardMessage(t.target, msg, 'html', t.owner || undefined);
          t.lastUpdate = Date.now();
        }
      }
    } catch (e) {
      console.log(`[Tracking] check failed ${key}: ${e.message}`);
    }
  }
  save();
}

export function updateTrackingPeriodicStatus(targetList, status, owner) {
  load();
  let changed = false;
  for (const t of Object.values(trackings)) {
    if (targetList.includes(t.target) && (!owner || !t.owner || t.owner === String(owner))) {
      t.periodic = status;
      changed = true;
    }
  }
  if (changed) save();
}

export function updateTrackingXStatus(targetList, status, owner) {
  load();
  let changed = false;
  for (const t of Object.values(trackings)) {
    if (targetList.includes(t.target) && (!owner || !t.owner || t.owner === String(owner))) {
      t.xAlerts = status;
      changed = true;
    }
  }
  if (changed) save();
}
