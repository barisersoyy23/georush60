/* =====================================================================
 * GeoRush 60 — game.js
 * Find the named country on the map before the 60-second clock runs out.
 * Libraries: Leaflet (map), D3 (spherical geometry), Chart.js (results).
 * ===================================================================== */
(function () {
  "use strict";

  /* ---------------- Configuration ---------------- */
  const GAME_SECONDS = 60;
  const START_LIVES = 3;
  const CORRECT_BONUS_SEC = 2;
  const SKIP_PENALTY_SEC = 3;
  const HINT_COST = 50;
  const CORRECT_PER_LEVEL = 5;

  // Difficulty: each level draws from a different pool of countries (by area, km²)
  const LEVELS = [
    { n: 1, name: "Giants",    test: a => a >= 1_000_000 },
    { n: 2, name: "Large",  test: a => a >= 300_000 },
    { n: 3, name: "Medium",  test: a => a >= 100_000 },
    { n: 4, name: "Everyone",    test: () => true },
    { n: 5, name: "Expert · borders hidden", test: a => a < 150_000 }
  ];

  const COLORS = { land: "#2a3658", hover: "#3b4b78", border: "#0e1630", ok: "#3ddc97", bad: "#ff5c7a", hint: "#5ab0ff" };

  /* ---------------- DOM references ---------------- */
  const $ = id => document.getElementById(id);
  const el = {
    score: $("score"), level: $("level"), streak: $("streak"), lives: $("lives"),
    timerValue: $("timer-value"), timerBar: $("timer-bar"), timer: document.querySelector(".timer"),
    target: $("q-target"), meta: $("q-meta"), clues: $("clues"), log: $("log"), levelTrack: $("level-track"),
    btnHint: $("btn-hint"), btnSkip: $("btn-skip"), btnPause: $("btn-pause"),
    btnStart: $("btn-start"), btnResume: $("btn-resume"), btnRestart: $("btn-restart"),
    screenStart: $("screen-start"), screenPause: $("screen-pause"), screenOver: $("screen-over"),
    toast: $("toast"), bestLine: $("best-line"),
    finalScore: $("final-score"), overReason: $("over-reason"), summary: $("summary"),
    missed: $("missed"), leaderboard: $("leaderboard"), formSave: $("form-save"), playerName: $("player-name")
  };

  /* ---------------- Data ---------------- */
  const countries = window.COUNTRIES_GEOJSON.features;
  // Pre-compute spherical centroids once with D3 (correct on a sphere, unlike a flat average)
  countries.forEach(f => { f.properties.centroid = d3.geoCentroid(f); });

  /* ---------------- Map (Leaflet) ---------------- */
  const map = L.map("map", {
    worldCopyJump: false,
    minZoom: 1.5, maxZoom: 7, zoomSnap: 0.25,
    maxBounds: [[-75, -220], [88, 220]],
    attributionControl: true
  }).fitBounds([[-50, -165], [75, 180]]);

  // No tile basemap on purpose: labels would give the answer away and most tile
  // services need an API key. Instead, a 10° graticule is generated with D3.
  L.geoJSON(d3.geoGraticule10(), {
    interactive: false,
    style: { color: "#24304f", weight: 0.6, opacity: 0.8, dashArray: "2 4" }
  }).addTo(map);
  map.attributionControl.addAttribution('Borders: <a href="https://www.naturalearthdata.com/">Natural Earth</a>');

  const baseStyle = () => ({
    color: state.level === 5 ? COLORS.land : COLORS.border,  // level 5: borders disappear
    weight: 0.8, fillColor: COLORS.land, fillOpacity: 0.95
  });

  const layerById = new Map();
  const countryLayer = L.geoJSON(window.COUNTRIES_GEOJSON, {
    style: () => ({ color: COLORS.border, weight: 0.8, fillColor: COLORS.land, fillOpacity: 0.95 }),
    onEachFeature(feature, layer) {
      layerById.set(feature.properties.id, layer);
      // EVENT HANDLERS #1 — map interaction, created per country by a closure factory
      layer.on(makeCountryHandlers(feature, layer));
    }
  }).addTo(map);

  /**
   * CLOSURE #4 — handler factory.
   * Each returned handler "remembers" its own `feature` and `layer`,
   * so one generic function serves all 172 countries.
   */
  function makeCountryHandlers(feature, layer) {
    return {
      mouseover() {
        if (state.phase !== "playing" || layer._locked) return;
        layer.setStyle({ fillColor: COLORS.hover });
      },
      mouseout() {
        if (layer._locked) return;
        layer.setStyle({ fillColor: COLORS.land });
      },
      click(e) {
        L.DomEvent.stopPropagation(e);
        if (state.phase === "playing") answer(feature, layer);
      }
    };
  }

  map.on("click", () => {
    if (state.phase === "playing") showToast("🌊 That's the ocean — pick a country", "info", 900);
  });

  /* ---------------- Game state ---------------- */
  const leaderboard = createLeaderboard("georush60.leaderboard");
  let scoreKeeper, countdown, timesChart = null;

  const state = {
    phase: "idle",        // idle | playing | feedback | paused | over
    level: 1, lives: START_LIVES,
    correctInLevel: 0, questionNo: 0,
    target: null, askedAt: 0, pausedAt: 0, hintsUsed: 0,
    asked: new Set(), missed: [], lastEntryId: null
  };

  /* ---------------- Game flow ---------------- */
  function startGame() {
    Object.assign(state, {
      phase: "playing", level: 1, lives: START_LIVES, correctInLevel: 0, questionNo: 0,
      target: null, hintsUsed: 0, asked: new Set(), missed: [], lastEntryId: null
    });
    scoreKeeper = createScoreKeeper();
    countdown = createCountdown(GAME_SECONDS, renderTimer, () => endGame("Time's up ⏱"));

    hide(el.screenStart); hide(el.screenOver);
    el.formSave.classList.remove("saved");
    el.log.innerHTML = "";
    restyleAll();
    map.flyToBounds([[-50, -165], [75, 180]], { duration: 0.6 });
    [el.btnHint, el.btnSkip, el.btnPause].forEach(b => (b.disabled = false));

    renderHUD();
    nextQuestion();
    countdown.start();
  }

  function nextQuestion() {
    const lvl = LEVELS[state.level - 1];
    let pool = countries.filter(f => lvl.test(f.properties.area) && !state.asked.has(f.properties.id));
    if (pool.length === 0) pool = countries.filter(f => !state.asked.has(f.properties.id));
    state.target = shuffle(pool)[0];
    state.asked.add(state.target.properties.id);
    state.questionNo += 1;
    state.hintsUsed = 0;
    state.askedAt = performance.now();

    // DOM: update the question card
    el.target.textContent = state.target.properties.name;
    el.target.classList.remove("flash"); void el.target.offsetWidth; el.target.classList.add("flash");
    el.meta.textContent = `Question ${state.questionNo} · Level ${state.level} — ${lvl.name}`;
    el.clues.innerHTML = `<p class="clues-empty">No hints yet. Stuck? Press <kbd>H</kbd> (−${HINT_COST} pts).</p>`;
    el.btnHint.disabled = false;
    state.phase = "playing";
  }

  function answer(feature, layer) {
    const seconds = (performance.now() - state.askedAt) / 1000;
    const target = state.target;
    const isCorrect = feature.properties.id === target.properties.id;

    if (isCorrect) {
      const { points, speedBonus } = scoreKeeper.correct(target.properties.name, state.level, seconds);
      countdown.add(CORRECT_BONUS_SEC);
      flashLayer(layer, COLORS.ok, 450);
      showToast(`✔ +${fmt(points)}${speedBonus ? `  ⚡ speed +${speedBonus}` : ""}`, "ok", 900);
      floatDelta(`+${CORRECT_BONUS_SEC}s`, COLORS.ok);
      addLog(target.properties.name, "ok", `+${fmt(points)}`);
      bump(el.score);

      state.correctInLevel += 1;
      if (state.correctInLevel >= CORRECT_PER_LEVEL && state.level < LEVELS.length) {
        state.level += 1;
        state.correctInLevel = 0;
        restyleAll();
        setTimeout(() => showToast(`⬆ Level ${state.level}: ${LEVELS[state.level - 1].name}`, "info", 1400), 650);
        bump(el.level);
      }
      renderHUD();
      feedbackPause(500);
    } else {
      // Wrong: lose a life, show how far and in which direction the target was (D3 great-circle distance)
      const from = feature.properties.centroid, to = target.properties.centroid;
      const km = Math.round(d3.geoDistance(from, to) * 6371);
      scoreKeeper.wrong(target.properties.name, seconds);
      state.lives -= 1;
      state.missed.push(target.properties.name);
      flashLayer(layer, COLORS.bad, 1300);
      revealTarget(1300);
      showToast(`✖ That's ${feature.properties.name}. Target is ${fmt(km)} km ${compassWord(from, to)}.`, "bad", 1800);
      addLog(target.properties.name, "bad", `${fmt(km)} km`);
      el.lives.classList.add("shake"); setTimeout(() => el.lives.classList.remove("shake"), 300);
      renderHUD();
      if (state.lives <= 0) { state.phase = "feedback"; countdown.pause(); setTimeout(() => endGame("Out of lives 💔"), 1400); return; }
      feedbackPause(1350);
    }
  }

  function skip() {
    if (state.phase !== "playing") return;
    const seconds = (performance.now() - state.askedAt) / 1000;
    scoreKeeper.skip(state.target.properties.name, seconds);
    state.missed.push(state.target.properties.name);
    countdown.add(-SKIP_PENALTY_SEC);
    if (state.phase === "over") return;               // the penalty may have ended the game
    floatDelta(`−${SKIP_PENALTY_SEC}s`, COLORS.bad);
    addLog(state.target.properties.name, "skip", "skipped");
    revealTarget(1000);
    renderHUD();
    feedbackPause(1000);
  }

  function hint() {
    if (state.phase !== "playing" || state.hintsUsed >= 3) return;
    const p = state.target.properties;
    const clues = [
      `<div class="clue"><span class="k">Region</span><span>${p.region} · ${p.subregion}</span></div>`,
      `<div class="clue"><span class="k">Flag</span><img class="flag" src="https://flagcdn.com/h40/${p.iso2.toLowerCase()}.png" alt="${p.flag}" height="28" onerror="this.replaceWith(this.alt)"></div>`,
      `<div class="clue"><span class="k">Capital</span><span>${p.capital}</span></div>`
    ];
    if (state.hintsUsed === 0) el.clues.innerHTML = "";
    el.clues.insertAdjacentHTML("beforeend", clues[state.hintsUsed]);
    state.hintsUsed += 1;
    scoreKeeper.penalty(HINT_COST);
    el.btnHint.disabled = state.hintsUsed >= 3;
    renderHUD();
  }

  /** Freezes the clock while feedback animations play, then asks the next question. */
  function feedbackPause(ms) {
    state.phase = "feedback";
    countdown.pause();
    setTimeout(() => {
      if (state.phase !== "feedback") return;   // game may have ended / been paused meanwhile
      nextQuestion();
      countdown.resume();
    }, ms);
  }

  function togglePause() {
    if (state.phase === "playing") {
      state.phase = "paused";
      state.pausedAt = performance.now();
      countdown.pause();
      show(el.screenPause);
    } else if (state.phase === "paused") {
      state.askedAt += performance.now() - state.pausedAt; // don't count paused time as answer time
      hide(el.screenPause);
      state.phase = "playing";
      countdown.resume();
    }
  }

  function endGame(reason) {
    if (state.phase === "over") return;
    state.phase = "over";
    countdown.stop();
    [el.btnHint, el.btnSkip, el.btnPause].forEach(b => (b.disabled = true));
    hide(el.screenPause);

    const h = scoreKeeper.history;
    const ok = h.filter(x => x.result === "ok");
    const answered = h.filter(x => x.result !== "skip").length;
    const avg = ok.length ? ok.reduce((s, x) => s + x.time, 0) / ok.length : 0;

    el.overReason.textContent = reason;
    el.finalScore.textContent = fmt(scoreKeeper.score);
    el.summary.innerHTML = `
      <div><b>${ok.length}</b><small>CORRECT</small></div>
      <div><b>${answered ? Math.round(ok.length / answered * 100) : 0}%</b><small>ACCURACY</small></div>
      <div><b>${avg.toFixed(1)}s</b><small>AVG. TIME</small></div>
      <div><b>${scoreKeeper.bestStreak}</b><small>BEST STREAK</small></div>`;
    el.missed.innerHTML = state.missed.length
      ? `<b>COUNTRIES TO STUDY</b>${state.missed.map(n => `<span class="chip">${escapeHTML(n)}</span>`).join("")}`
      : "";

    const canSave = leaderboard.qualifies(scoreKeeper.score);
    el.formSave.classList.toggle("saved", !canSave);
    renderLeaderboard();
    drawChart(h);
    show(el.screenOver);
    if (canSave) setTimeout(() => el.playerName.focus(), 50);
  }

  /* ---------------- Rendering (DOM) ---------------- */
  function renderHUD() {
    el.score.textContent = fmt(scoreKeeper.score);
    el.level.textContent = state.level;
    el.streak.textContent = "×" + scoreKeeper.multiplier.toFixed(2);
    el.lives.innerHTML = "♥".repeat(Math.max(0, state.lives)) + `<span class="lost">${"♥".repeat(START_LIVES - Math.max(0, state.lives))}</span>`;
    el.levelTrack.innerHTML = LEVELS.map(l => `<span class="${l.n <= state.level ? "on" : ""}" title="Level ${l.n}: ${l.name}"></span>`).join("");
  }

  function renderTimer(remaining, total) {
    el.timerValue.textContent = remaining.toFixed(1);
    el.timerBar.style.width = (remaining / total * 100) + "%";
    el.timer.classList.toggle("warn", remaining <= 10);
  }

  function addLog(name, cls, right) {
    el.log.insertAdjacentHTML("afterbegin", `<li class="${cls}"><span>${escapeHTML(name)}</span><span class="pts">${right}</span></li>`);
    while (el.log.children.length > 6) el.log.lastElementChild.remove();
  }

  function renderLeaderboard() {
    const list = leaderboard.all();
    el.leaderboard.innerHTML = list.length
      ? list.map(e => `<li class="${e.id === state.lastEntryId ? "me" : ""}">${escapeHTML(e.name)} <small>· Lv ${e.level}</small><span class="s">${fmt(e.score)}</span></li>`).join("")
      : `<li style="list-style:none;color:var(--muted)">No scores yet — be the first!</li>`;
    const best = leaderboard.best();
    el.bestLine.textContent = best ? `🏆 Record: ${best.name} — ${fmt(best.score)}` : "";
  }

  function drawChart(history) {
    if (timesChart) timesChart.destroy();
    const colorOf = r => (r === "ok" ? COLORS.ok : r === "bad" ? COLORS.bad : "#8b95b2");
    timesChart = new Chart($("chart-times"), {
      type: "bar",
      data: {
        labels: history.map((x, i) => `${i + 1}`),
        datasets: [{
          data: history.map(x => +x.time.toFixed(2)),
          backgroundColor: history.map(x => colorOf(x.result)),
          borderRadius: 4
        }]
      },
      options: {
        animation: { duration: 600 },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: items => history[items[0].dataIndex].name, label: i => `${i.raw} s · ${history[i.dataIndex].points} pts` } }
        },
        scales: {
          x: { ticks: { color: "#8b95b2" }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: "#8b95b2" }, grid: { color: "#26314f" } }
        }
      }
    });
  }

  /* ---------------- Map effects ---------------- */
  function restyleAll() {
    countryLayer.eachLayer(l => { l._locked = false; l.setStyle(baseStyle()); });
  }

  function flashLayer(layer, color, ms) {
    layer._locked = true;
    layer.setStyle({ fillColor: color });
    setTimeout(() => { layer._locked = false; layer.setStyle(baseStyle()); }, ms);
  }

  function revealTarget(ms) {
    const layer = layerById.get(state.target.properties.id);
    flashLayer(layer, COLORS.ok, ms);
    const [lon, lat] = state.target.properties.centroid;
    const marker = L.marker([lat, lon], {
      icon: L.divIcon({ className: "", html: '<div class="answer-pulse"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      interactive: false
    }).addTo(map);
    if (!map.getBounds().contains([lat, lon])) map.panTo([lat, lon], { animate: true });
    setTimeout(() => marker.remove(), ms);
  }

  /* ---------------- Small UI helpers ---------------- */
  let toastTimer;
  function showToast(text, kind, ms) {
    el.toast.textContent = text;
    el.toast.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
  }
  function floatDelta(text, color) {
    const s = document.createElement("span");
    s.className = "delta"; s.textContent = text; s.style.color = color;
    el.timerValue.style.position = "relative";
    el.timerValue.appendChild(s);
    setTimeout(() => s.remove(), 1000);
  }
  function bump(node) { node.classList.add("bump"); setTimeout(() => node.classList.remove("bump"), 160); }
  function show(n) { n.classList.remove("hidden"); }
  function hide(n) { n.classList.add("hidden"); }

  /* ---------------- EVENT HANDLERS ---------------- */
  // #2 — Buttons (click)
  el.btnStart.addEventListener("click", startGame);
  el.btnRestart.addEventListener("click", startGame);
  el.btnHint.addEventListener("click", hint);
  el.btnSkip.addEventListener("click", skip);
  el.btnPause.addEventListener("click", togglePause);
  el.btnResume.addEventListener("click", togglePause);

  // #3 — Keyboard shortcuts (keydown)
  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;          // typing a name — don't trigger shortcuts
    const k = e.key.toLowerCase();
    if (k === "enter" && (state.phase === "idle" || state.phase === "over")) { e.preventDefault(); startGame(); }
    else if (k === "h") hint();
    else if (k === "s") skip();
    else if (k === "p" || k === "escape") togglePause();
  });

  // #4 — Save to leaderboard (form submit)
  el.formSave.addEventListener("submit", e => {
    e.preventDefault();
    const name = el.playerName.value.trim();
    if (!name) return;
    state.lastEntryId = leaderboard.add(name, scoreKeeper.score, state.level);
    el.formSave.classList.add("saved");
    el.playerName.value = "";
    renderLeaderboard();
  });

  // #5 — Auto-pause when the player switches tabs (visibilitychange)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.phase === "playing") togglePause();
  });

  /* ---------------- Init ---------------- */
  renderLeaderboard();
  scoreKeeper = createScoreKeeper();
  renderHUD();
  renderTimer(GAME_SECONDS, GAME_SECONDS);
})();
