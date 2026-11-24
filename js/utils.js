/* =====================================================================
 * GeoRush 60 — utils.js
 * Small, reusable building blocks. Most of them are CLOSURES:
 * a factory function keeps private variables alive and returns only
 * the functions that are allowed to touch them.
 * ===================================================================== */

/**
 * CLOSURE #1 — Countdown timer.
 * `remaining`, `intervalId` and `lastTick` are private: nothing outside
 * can change the clock except through start/pause/resume/add.
 * Uses real elapsed time (performance.now) so the clock stays accurate
 * even if the browser delays the interval.
 */
function createCountdown(totalSeconds, onTick, onEnd) {
  let remaining = totalSeconds;
  let intervalId = null;
  let lastTick = 0;

  function tick() {
    const now = performance.now();
    remaining = Math.max(0, remaining - (now - lastTick) / 1000);
    lastTick = now;
    onTick(remaining, totalSeconds);
    if (remaining <= 0) {
      stop();
      onEnd();
    }
  }
  function stop() {
    clearInterval(intervalId);
    intervalId = null;
  }

  return {
    start() { remaining = totalSeconds; this.resume(); },
    resume() {
      if (intervalId) return;
      lastTick = performance.now();
      intervalId = setInterval(tick, 100);
    },
    pause() { if (intervalId) { tick(); stop(); } },
    stop,
    add(seconds) {                       // bonus (+) or penalty (−) time
      remaining = Math.max(0, Math.min(totalSeconds, remaining + seconds));
      onTick(remaining, totalSeconds);
      if (remaining <= 0) { stop(); onEnd(); }
    },
    get remaining() { return remaining; },
    get running() { return intervalId !== null; }
  };
}

/**
 * CLOSURE #2 — Score keeper.
 * Score, streak and per-question history are hidden inside the closure.
 * The game can only change them through the scoring rules below,
 * so there is exactly one place where points are calculated.
 */
function createScoreKeeper() {
  let score = 0;
  let streak = 0;
  let bestStreak = 0;
  const history = [];   // { name, result: "ok"|"bad"|"skip", time, points }

  const multiplier = () => 1 + 0.25 * Math.min(streak, 4); // ×1.00 … ×2.00

  return {
    correct(name, level, seconds) {
      const base = 100 * level;
      const speedBonus = Math.max(0, Math.round((8 - seconds) * 15)); // fast = up to +120
      const points = Math.round((base + speedBonus) * multiplier());
      score += points;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
      history.push({ name, result: "ok", time: seconds, points });
      return { points, base, speedBonus };
    },
    wrong(name, seconds) {
      streak = 0;
      history.push({ name, result: "bad", time: seconds, points: 0 });
    },
    skip(name, seconds) {
      streak = 0;
      history.push({ name, result: "skip", time: seconds, points: 0 });
    },
    penalty(points) { score = Math.max(0, score - points); },
    get score() { return score; },
    get streak() { return streak; },
    get bestStreak() { return bestStreak; },
    get multiplier() { return multiplier(); },
    get history() { return history.slice(); } // copy → outside code cannot mutate it
  };
}

/**
 * CLOSURE #3 — Leaderboard backed by localStorage.
 * The storage key and the max size are captured once.
 */
function createLeaderboard(storageKey, maxEntries = 5) {
  function read() {
    try { return JSON.parse(localStorage.getItem(storageKey)) || []; }
    catch { return []; }
  }
  function write(list) {
    try { localStorage.setItem(storageKey, JSON.stringify(list)); } catch { /* private mode */ }
  }
  return {
    all: read,
    best() { return read()[0] || null; },
    qualifies(score) {
      const list = read();
      return score > 0 && (list.length < maxEntries || score > list[list.length - 1].score);
    },
    add(name, score, level) {
      const entry = { name, score, level, date: new Date().toISOString().slice(0, 10), id: Date.now() };
      const list = [...read(), entry].sort((a, b) => b.score - a.score).slice(0, maxEntries);
      write(list);
      return entry.id;
    }
  };
}

/** Fisher–Yates shuffle (returns a new array). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Initial bearing from point A to B (degrees) → 8-point compass word. */
function compassWord(from, to) {
  const toRad = d => d * Math.PI / 180;
  const [lon1, lat1, lon2, lat2] = [from[0], from[1], to[0], to[1]].map(toRad);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const words = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return words[Math.round(deg / 45) % 8];
}

/** Escape text before putting it in innerHTML (player names come from user input). */
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const fmt = n => n.toLocaleString("en-US");
