// Ville — browser client. Talks to the server over SSE (/api/events) and a few JSON endpoints.
import { MapView } from '/map.js';
import { SoundFX } from '/sound.js';

const $ = (sel) => document.querySelector(sel);
const sfx = new SoundFX();

const state = {
  house: null,
  editor: { residents: [], objectKinds: [] },
  rooms: new Map(),
  residents: new Map(),
  human: null,
  time: { day: 1, hour: 8, minute: 0 },
  running: true,
  speed: 1,
  llm: { calls: 0, errors: 0, totalMs: 0, requests: 0, demoCalls: 0, skipped: 0 },
  lastDay: 0,
  openDrawer: null,
  modalMode: null,
  relFocus: null,
  studioTab: 'residents',
  studioTarget: null,
};

const els = {
  houseName: $('#house-name'),
  feed: $('#feed'),
  clockTime: $('#clock-time'),
  clockDay: $('#clock-day'),
  clockIcon: $('#clock-icon'),
  play: $('#btn-play'),
  step: $('#btn-step'),
  speed: $('#speed'),
  thoughts: $('#show-thoughts'),
  sound: $('#btn-sound'),
  rels: $('#btn-rels'),
  studio: $('#btn-studio'),
  stats: $('#llm-stats'),
  systemNotice: $('#system-notice'),
  conn: $('#conn'),
  humanName: $('#human-name'),
  humanEmoji: $('#human-emoji'),
  humanRoom: $('#human-room'),
  humanTo: $('#human-to'),
  humanText: $('#human-text'),
  sayForm: $('#say-form'),
  drawer: $('#drawer'),
  drawerBody: $('#drawer-body'),
  drawerClose: $('#drawer-close'),
  modal: $('#modal'),
  modalTitle: $('#modal-title'),
  modalBody: $('#modal-body'),
  modalClose: $('#modal-close'),
};

const map = new MapView($('#canvas'), $('#overlay'), {
  onMoverClick: (name) => openDrawer(name),
  onTileClick: (x, y) => post('/api/human/walk', { x, y }).catch(() => {}),
});

// ── helpers ──────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => `${pad(t.hour)}:${pad(t.minute)}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function colorOf(name) {
  if (state.human && name === state.human.name) return state.human.color;
  return state.residents.get(name)?.color ?? '#cfd3dc';
}

function roomName(id) {
  return state.rooms.get(id)?.name ?? id;
}

function who(name) {
  return `<b style="color:${esc(colorOf(name))}">${esc(name)}</b>`;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function partOfDay(h) {
  if (h < 5) return 'late night';
  if (h < 9) return 'early morning';
  if (h < 12) return 'morning';
  if (h < 14) return 'midday';
  if (h < 18) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

// ── snapshot & SSE ───────────────────────────────────────────────────────────

function applySnapshot(snap) {
  state.house = snap.house;
  if (snap.editor) state.editor = snap.editor;
  state.rooms = new Map(snap.house.rooms.map((r) => [r.id, r]));
  state.residents = new Map(snap.residents.map((r) => [r.name, r]));
  state.human = snap.human;
  state.time = snap.time;
  state.running = snap.running;
  state.speed = snap.speed;
  state.llm = { requests: 0, demoCalls: 0, skipped: 0, ...snap.llm };
  state.lastDay = 0;

  els.houseName.textContent = snap.house.name;
  document.title = `Ville — ${snap.house.name}`;
  els.speed.value = String(snap.speed);
  els.humanEmoji.textContent = snap.human.emoji;
  if (document.activeElement !== els.humanName) els.humanName.value = snap.human.name;

  map.time = snap.time;
  map.setHouse(snap.house);
  const seen = new Set();
  for (const r of snap.residents) {
    map.setMover(r);
    seen.add(r.name);
  }
  map.setMover({ ...snap.human, human: true });
  seen.add(snap.human.name);
  for (const name of [...map.movers.keys()]) if (!seen.has(name)) map.removeMover(name);

  renderClock();
  renderControls();
  renderStats();
  renderHumanBar();

  els.feed.innerHTML = '';
  for (const ev of snap.events) addFeedItem(ev, false);
  scrollFeed(true);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    applySnapshot(JSON.parse(e.data));
    els.conn.classList.remove('off');
  });
  es.addEventListener('ville', (e) => handleEvent(JSON.parse(e.data)));
  es.onerror = () => els.conn.classList.add('off');
}

function moverOf(ev) {
  if (ev.human || (state.human && ev.who === state.human.name)) return { human: true, view: state.human };
  const r = state.residents.get(ev.who);
  return r ? { human: false, view: r } : null;
}

function handleEvent(ev) {
  const r = ev.who ? state.residents.get(ev.who) : undefined;
  const mv = ev.who ? moverOf(ev) : null;

  switch (ev.type) {
    case 'clock':
      state.time = ev.t;
      map.time = ev.t;
      renderClock();
      break;
    case 'walk':
      map.startWalk(ev.who, ev.path, ev.tileMs);
      break;
    case 'pos': {
      map.setPos(ev.who, ev.x, ev.y, ev.facing);
      if (mv?.view) {
        const changedRoom = mv.view.room !== ev.room;
        mv.view.room = ev.room;
        mv.view.x = ev.x;
        mv.view.y = ev.y;
        const m = map.movers.get(ev.who);
        if (m) m.room = ev.room;
        if (changedRoom) renderHumanBar();
      }
      break;
    }
    case 'say':
      map.bubble(ev.who, ev.text, false);
      sfx.playSay(ev.who, !!ev.human);
      addFeedItem(ev);
      if (state.modalMode === 'rels') renderRelsModal();
      break;
    case 'move':
      if (r) r.activity = ev.text || 'on the move';
      sfx.playMove();
      addFeedItem(ev);
      break;
    case 'do':
    case 'rest':
      if (r) r.activity = ev.text;
      addFeedItem(ev);
      break;
    case 'sleep':
      if (r) {
        r.awake = !ev.asleep;
        r.activity = ev.asleep ? 'sleeping' : 'just woke up';
        const m = map.movers.get(ev.who);
        if (m) m.awake = r.awake;
      }
      sfx.playSleep(ev.asleep);
      addFeedItem(ev);
      renderHumanBar();
      break;
    case 'thought':
      if (els.thoughts.checked) map.bubble(ev.who, ev.text, true);
      addFeedItem(ev);
      break;
    case 'mood':
      if (r) {
        r.mood = ev.mood;
        r.energy = ev.energy;
        r.activity = ev.activity;
        const m = map.movers.get(ev.who);
        if (m) Object.assign(m, { mood: ev.mood, energy: ev.energy, activity: ev.activity });
      }
      refreshDrawerIf(ev.who);
      break;
    case 'goal':
      if (r) {
        if (!Array.isArray(r.goalsState)) r.goalsState = (r.goals || []).map((g) => ({ text: g, progress: 0 }));
        const existing = r.goalsState.find((g) => g.text === ev.goal);
        if (existing) {
          existing.progress = ev.progress;
          existing.done = ev.done;
        } else {
          r.goalsState.push({ text: ev.goal, progress: ev.progress, done: ev.done });
        }
      }
      sfx.playChime();
      addFeedItem(ev);
      refreshDrawerIf(ev.who);
      break;
    case 'reflection':
      sfx.playChime();
      addFeedItem(ev);
      refreshDrawerIf(ev.who);
      break;
    case 'plan':
      addFeedItem(ev);
      refreshDrawerIf(ev.who);
      break;
    case 'system':
      addFeedItem(ev);
      break;
    case 'llm':
      state.llm.requests += ev.requests || 0;
      if (ev.skipped) state.llm.skipped++;
      else if (ev.mode === 'demo') state.llm.demoCalls++;
      else if (ev.mode === 'live') {
        state.llm.calls++;
        state.llm.totalMs += ev.ms;
        if (!ev.ok) state.llm.errors++;
      }
      if (r) {
        Object.assign(r, {
          mode: ev.mode, status: ev.status, online: ev.online,
          note: ev.note, retryAt: ev.retryAt,
          canComplete: ev.status === 'ready' || ev.status === 'unverified' || ev.mode === 'demo',
        });
        refreshDrawerIf(ev.who);
      }
      renderStats();
      renderHumanBar();
      break;
  }
}

// ── rendering: chrome ────────────────────────────────────────────────────────

function renderClock() {
  const t = state.time;
  els.clockTime.textContent = hhmm(t);
  els.clockDay.textContent = `Day ${t.day} · ${partOfDay(t.hour)}`;
  els.clockIcon.textContent = t.hour >= 6 && t.hour < 18 ? '☀️' : t.hour < 21 && t.hour >= 18 ? '🌇' : '🌙';
}

function renderControls() {
  els.play.textContent = state.running ? '⏸' : '▶';
  els.play.title = state.running ? 'Pause time' : 'Resume time';
  els.step.disabled = state.running;
}

function renderStats() {
  const residents = [...state.residents.values()];
  const ready = residents.filter((r) => r.status === 'ready').length;
  const needsSetup = residents.filter((r) => r.status === 'unavailable').length;
  const failed = residents.filter((r) => r.status === 'cooldown').length;
  const demos = residents.filter((r) => r.mode === 'demo').length;
  els.stats.textContent = `System · ${ready}/${residents.length} models ready`;
  els.stats.classList.toggle('needs-attention', ready === 0 || needsSetup + failed > 0);
  els.stats.title = `${state.llm.calls} model calls · ${state.llm.requests} HTTP requests · ${state.llm.errors} errors · ${state.llm.demoCalls} demo completions (this session)`;
  els.systemNotice.hidden = ready > 0 && needsSetup + failed + demos === 0;
  els.systemNotice.textContent = ready === 0
    ? 'No resident has a verified model connection. Open System to check setup and connection status.'
    : `${needsSetup + failed + demos} residents need attention. Open System for details.`;
  if (state.modalMode === 'system') renderSystemModal();
}

function providerStatus(r) {
  return ({ ready: 'Connected', unverified: 'Not checked yet', cooldown: 'Connection failed', unavailable: 'Needs setup', demo: 'Scripted demo' })[r.status] || 'Unknown';
}

function openSystemModal() {
  state.modalMode = 'system';
  els.modalTitle.textContent = 'System · Resident models';
  els.modal.hidden = false;
  renderSystemModal();
}

function renderSystemModal() {
  const { calls, errors, totalMs, requests, demoCalls, skipped } = state.llm;
  const avg = calls ? (totalMs / calls / 1000).toFixed(1) : '0.0';
  els.modalBody.innerHTML = `
    <p class="system-summary">Residents need a working model to make decisions and hold conversations. A missing connection pauses their decisions. Scripted demo runs only when explicitly selected in Studio.</p>
    <div class="system-residents">${[...state.residents.values()].map((r) => `
      <article class="system-resident">
        <div class="system-resident-head"><strong>${esc(r.emoji)} ${esc(r.name)}</strong><span class="pill ${r.status === 'ready' ? 'online' : 'offline'}">${esc(providerStatus(r))}</span></div>
        <p>${esc(r.provider)} · ${esc(r.model)}</p>
        ${r.note ? `<p>${esc(r.note)}</p>` : ''}
        ${r.retryAt ? `<p>Automatic retry after ${esc(new Date(r.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))} while the simulation is running.</p>` : ''}
      </article>`).join('')}</div>
    <div class="system-counts"><span>${calls} model calls</span><span>${requests} HTTP requests</span><span>${errors} errors</span><span>${avg}s average</span><span>${demoCalls} demo completions</span><span>${skipped} blocked attempts</span></div>
    <p class="system-summary">Counts cover this server session. Demo completions are separate from model calls. A connection is marked connected only after a successful response.</p>
    <p class="system-summary">For setup, put a Hugging Face token in HF_TOKEN (or the selected provider’s key) in the project’s .env, or start the selected local model server, then restart Ville. Provider and model choices are in Studio.</p>`;
}

function residentsIn(roomId) {
  return [...state.residents.values()].filter((r) => r.room === roomId).sort((a, b) => a.name.localeCompare(b.name));
}

function renderHumanBar() {
  if (!state.human) return;
  els.humanRoom.innerHTML = [...state.rooms.values()]
    .map((r) => `<option value="${esc(r.id)}">${esc(r.emoji)} ${esc(r.name)}</option>`)
    .join('');
  els.humanRoom.value = state.human.room;

  const here = residentsIn(state.human.room);
  const prevTo = els.humanTo.value;
  els.humanTo.innerHTML =
    `<option value="everyone">everyone here</option>` +
    here.map((r) => `<option value="${esc(r.name)}">${esc(r.emoji)} ${esc(r.name)}${!r.awake ? ' (asleep)' : r.status === 'unavailable' || r.status === 'cooldown' || r.mode === 'demo' ? ` (${esc(providerStatus(r).toLowerCase())})` : ''}</option>`).join('');
  if ([...els.humanTo.options].some((o) => o.value === prevTo)) els.humanTo.value = prevTo;

  const awake = here.filter((r) => r.awake);
  const available = awake.filter((r) => r.mode === 'demo' || r.status === 'ready' || r.status === 'unverified');
  els.humanText.placeholder = awake.length && !available.length
    ? 'Residents here need a model connection. Open System for details.'
    : awake.length
    ? `Say something to ${awake.map((r) => r.name).join(', ')}…`
    : here.length
      ? `Everyone in the ${roomName(state.human.room)} is asleep…`
      : `Nobody is in the ${roomName(state.human.room)}. Click the floor to walk somewhere else.`;
}

// ── feed ─────────────────────────────────────────────────────────────────────

function addFeedItem(ev, autoscroll = true) {
  if (ev.t && ev.t.day !== state.lastDay) {
    state.lastDay = ev.t.day;
    const sep = document.createElement('li');
    sep.className = 'day-sep';
    sep.textContent = `Day ${ev.t.day}`;
    els.feed.appendChild(sep);
  }

  const html = feedHtml(ev);
  if (!html) return;
  const li = document.createElement('li');
  li.className = html.cls;
  li.innerHTML = `<span class="t">${esc(hhmm(ev.t))}</span><span class="body">${html.body}</span>`;
  els.feed.appendChild(li);
  while (els.feed.children.length > 350) els.feed.firstElementChild.remove();
  if (autoscroll) scrollFeed(false);
}

function feedHtml(ev) {
  switch (ev.type) {
    case 'say': {
      const human = ev.human || ev.who === state.human?.name;
      const to = ev.to && ev.to !== 'everyone' ? `<span class="arrow">→</span>${who(ev.to)}` : '';
      return { cls: `ev ev-say${human ? ' human' : ''}`, body: `${who(ev.who)}${to}: <span class="quote">${esc(ev.text)}</span>` };
    }
    case 'move': {
      const human = ev.human || ev.who === state.human?.name;
      return {
        cls: `ev ev-move${human ? ' human' : ''}`,
        body: `${who(ev.who)} <span class="arrow">${esc(roomName(ev.fromRoom))} → ${esc(roomName(ev.toRoom))}</span>${
          ev.text ? ` <span class="quote">${esc(ev.text)}</span>` : ''
        }`,
      };
    }
    case 'do':
      return { cls: 'ev ev-do', body: `${who(ev.who)} is <span class="quote">${esc(ev.text)}</span>` };
    case 'rest':
      return { cls: 'ev ev-rest', body: `${who(ev.who)} is <span class="quote">${esc(ev.text)}</span>` };
    case 'sleep':
      return { cls: 'ev ev-sleep', body: ev.asleep ? `💤 ${who(ev.who)} went to bed` : `🌅 ${who(ev.who)} woke up` };
    case 'thought':
      return { cls: 'ev ev-thought', body: `💭 ${who(ev.who)}: ${esc(ev.text)}` };
    case 'reflection':
      return {
        cls: 'ev ev-reflection',
        body: `✨ ${who(ev.who)} realised:<ul>${ev.insights.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`,
      };
    case 'goal':
      return {
        cls: 'ev ev-goal',
        body: ev.done
          ? `🏆 ${who(ev.who)} completed a goal: <span class="quote">${esc(ev.goal)}</span>!`
          : ev.progress === 0
            ? `🌱 ${who(ev.who)} set a new goal: <span class="quote">${esc(ev.goal)}</span>`
            : `🎯 ${who(ev.who)} made progress on <span class="quote">${esc(ev.goal)}</span> (${ev.progress}%)`,
      };
    case 'plan':
      return {
        cls: 'ev ev-plan',
        body: `📝 ${who(ev.who)} <details><summary>made a plan for the day (${ev.plan.length} items)</summary><ul>${ev.plan
          .map((p) => `<li>${esc(p.time)} — ${esc(p.activity)}</li>`)
          .join('')}</ul></details>`,
      };
    case 'system':
      return { cls: `ev ev-system ${esc(ev.level)}`, body: `🏡 ${esc(ev.text)}` };
    default:
      return null;
  }
}

function scrollFeed(force) {
  const f = els.feed;
  const nearBottom = f.scrollHeight - f.scrollTop - f.clientHeight < 160;
  if (force || nearBottom) f.scrollTop = f.scrollHeight;
}

// ── drawer ───────────────────────────────────────────────────────────────────

let drawerRefreshTimer = null;

async function openDrawer(name) {
  state.openDrawer = name;
  map.focused = name;
  els.drawer.hidden = false;
  els.drawerBody.innerHTML = '<p class="muted">Loading…</p>';
  await loadDrawer();
}

function closeDrawer() {
  state.openDrawer = null;
  map.focused = null;
  els.drawer.hidden = true;
}

function refreshDrawerIf(name) {
  if (!state.openDrawer || state.openDrawer !== name) return;
  clearTimeout(drawerRefreshTimer);
  drawerRefreshTimer = setTimeout(loadDrawer, 800);
}

async function loadDrawer() {
  const name = state.openDrawer;
  if (!name) return;
  try {
    const res = await fetch(`/api/resident/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(res.statusText);
    const d = await res.json();
    if (state.openDrawer !== name) return;
    const scroll = els.drawerBody.scrollTop;
    els.drawerBody.innerHTML = drawerHtml(d);
    els.drawerBody.scrollTop = scroll;
    const editBtn = els.drawerBody.querySelector('[data-edit-resident]');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        closeDrawer();
        openStudioModal('residents', d.name);
      });
    }
  } catch (err) {
    els.drawerBody.innerHTML = `<p class="muted">Couldn't load ${esc(name)}: ${esc(err.message)}</p>`;
  }
}

function drawerHtml(d) {
  const nowMin = state.time.hour * 60 + state.time.minute;
  let currentIdx = -1;
  d.plan.forEach((p, i) => {
    const [h, m] = p.time.split(':').map(Number);
    if (h * 60 + (m || 0) <= nowMin) currentIdx = i;
  });
  const rels = Object.entries(d.relationships || {}).sort((a, b) => b[1].interactions - a[1].interactions);
  const kindIcon = { conversation: '💬', observation: '👀', action: '🔸', thought: '💭', reflection: '✨', plan: '📝' };
  const goalsList = Array.isArray(d.goalsState) && d.goalsState.length
    ? d.goalsState
    : (d.goals || []).map((g) => ({ text: g, progress: 0 }));

  return `
    <div class="d-head">
      <div class="d-avatar" style="--c:${esc(d.color)}">${esc(d.emoji)}</div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="d-name">${esc(d.name)}${d.age ? `<span class="muted" style="font-weight:400;font-size:14px"> · ${d.age}</span>` : ''}</div>
          <button class="btn" style="font-size:11px;padding:3px 8px;margin-right:28px" data-edit-resident="${esc(d.name)}">🛠️ Edit</button>
        </div>
        <div class="d-sub">${d.awake ? esc(d.activity || 'idle') : 'asleep'} · in the ${esc(roomName(d.room))}</div>
        <div style="margin-top:6px">
          <span class="pill ${d.status === 'ready' ? 'online' : 'offline'}">${esc(providerStatus(d))} · ${esc(d.provider)} · ${esc(d.model)}</span>
          ${d.note ? `<span class="pill offline">${esc(d.note)}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="bars">
      <span class="muted">Mood</span><span>${esc(d.mood)}</span><span></span>
      <span class="muted">Energy</span><div class="bar"><i style="width:${Math.max(0, Math.min(100, d.energy))}%"></i></div><span>${d.energy}</span>
    </div>

    <div class="d-section"><h4>About</h4><p>${esc(d.bio)}</p></div>
    <div class="d-section"><h4>Personality</h4><div class="chips">${d.traits.map((t) => `<span>${esc(t)}</span>`).join('')}</div></div>
    <div class="d-section"><h4>Goals &amp; Progress</h4>
      <div class="goal-list">
        ${goalsList
          .map(
            (g) => `
          <div class="goal-row ${g.done || g.progress >= 100 ? 'done' : ''}">
            <div class="goal-top">
              <span>${esc(g.text)}</span>
              <span class="goal-pct">${g.done || g.progress >= 100 ? '✓ Done' : `${g.progress || 0}%`}</span>
            </div>
            <div class="bar"><i style="width:${Math.max(0, Math.min(100, g.progress || 0))}%"></i></div>
          </div>`,
          )
          .join('')}
      </div>
    </div>

    <div class="d-section"><h4>Today's plan</h4>
      ${
        d.plan.length
          ? `<ol class="plan">${d.plan
              .map((p, i) => `<li class="${i === currentIdx ? 'now' : ''}"><span class="pt">${esc(p.time)}</span><span>${esc(p.activity)}</span></li>`)
              .join('')}</ol>`
          : '<p class="empty">No plan yet — still waking up.</p>'
      }
    </div>

    <div class="d-section"><h4>Relationships</h4>
      ${
        rels.length
          ? `<div class="rel">${rels
              .map(
                ([n, r]) =>
                  `<div class="r"><span class="who" style="color:${esc(colorOf(n))}">${esc(n)}</span><span class="aff">${affinityWord(r.affinity)} · ${r.interactions} chats</span>${
                    r.impression ? `<div class="imp">${esc(r.impression)}</div>` : ''
                  }</div>`,
              )
              .join('')}</div>`
          : '<p class="empty">Hasn\'t really talked to anyone yet.</p>'
      }
    </div>

    <div class="d-section"><h4>Reflections</h4>
      ${
        d.reflections.length
          ? `<ul class="mem">${d.reflections.map((m) => `<li class="reflection"><span>✨</span><span>${esc(m.text)}<div class="mt">Day ${m.t.day} ${hhmm(m.t)}</div></span></li>`).join('')}</ul>`
          : '<p class="empty">Nothing yet. Reflections form after enough has happened.</p>'
      }
    </div>

    <div class="d-section"><h4>Recent memories</h4>
      <ul class="mem">${d.memories
        .filter((m) => m.kind !== 'reflection')
        .slice(0, 40)
        .map((m) => `<li><span>${kindIcon[m.kind] || '•'}</span><span>${esc(m.text)}<div class="mt">Day ${m.t.day} ${hhmm(m.t)} · importance ${m.importance}</div></span></li>`)
        .join('')}</ul>
    </div>`;
}

function affinityWord(a) {
  if (a >= 3) return 'close';
  if (a >= 1) return 'warm';
  if (a <= -3) return 'strained';
  if (a <= -1) return 'cool';
  return 'neutral';
}

function affinityColor(a) {
  if (a >= 3) return '#7bc47f';
  if (a >= 1) return '#f5b942';
  if (a <= -3) return '#ff7a6e';
  if (a <= -1) return '#ff9f68';
  return '#5b667d';
}

// ── modals: relationship web & studio editor ─────────────────────────────────

function closeModal() {
  state.modalMode = null;
  els.modal.hidden = true;
}

function openRelsModal(focus = null) {
  state.modalMode = 'rels';
  state.relFocus = focus;
  els.modalTitle.textContent = '🕸️ House Relationship Web';
  els.modal.hidden = false;
  renderRelsModal();
}

function renderRelsModal() {
  if (state.modalMode !== 'rels') return;
  const residents = [...state.residents.values()];
  const humanHasRels = state.human && residents.some((r) => r.relationships?.[state.human.name]?.interactions > 0);
  const nodes = [
    ...residents.map((r) => ({ name: r.name, emoji: r.emoji, color: r.color, mood: r.mood, human: false })),
    ...(humanHasRels ? [{ name: state.human.name, emoji: state.human.emoji, color: state.human.color, mood: 'visiting', human: true }] : []),
  ];

  const cx = 200;
  const cy = 190;
  const radius = 135;
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
    n.x = cx + Math.cos(angle) * radius;
    n.y = cy + Math.sin(angle) * radius;
  });
  const byName = new Map(nodes.map((n) => [n.name, n]));

  // Build undirected pairs with both directional impressions
  const pairs = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const ra = state.residents.get(a.name)?.relationships?.[b.name];
      const rb = state.residents.get(b.name)?.relationships?.[a.name];
      const interactions = Math.max(ra?.interactions ?? 0, rb?.interactions ?? 0);
      const avgAff = ((ra?.affinity ?? 0) + (rb?.affinity ?? 0)) / (ra && rb ? 2 : 1);
      if (interactions > 0 || ra?.impression || rb?.impression) {
        pairs.push({ a, b, ra, rb, interactions, avgAff });
      }
    }
  }
  pairs.sort((p, q) => q.interactions - p.interactions || Math.abs(q.avgAff) - Math.abs(p.avgAff));

  const focus = state.relFocus;
  const edgesSvg = pairs
    .map((p) => {
      const dim = focus && p.a.name !== focus && p.b.name !== focus;
      const mx = (p.a.x + p.b.x) / 2;
      const my = (p.a.y + p.b.y) / 2;
      const dx = mx - cx;
      const dy = my - cy;
      const qx = mx - dx * 0.25;
      const qy = my - dy * 0.25;
      const stroke = affinityColor(Math.round(p.avgAff));
      const width = Math.min(6, 1.8 + p.interactions * 0.45);
      return `<path d="M ${p.a.x.toFixed(1)} ${p.a.y.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${p.b.x.toFixed(1)} ${p.b.y.toFixed(1)}"
        fill="none" stroke="${stroke}" stroke-width="${width.toFixed(1)}" stroke-linecap="round" opacity="${dim ? 0.18 : 0.85}" />`;
    })
    .join('');

  const nodesSvg = nodes
    .map((n) => {
      const isFocused = focus === n.name;
      const dim = focus && !isFocused && !pairs.some((p) => (p.a.name === focus && p.b.name === n.name) || (p.b.name === focus && p.a.name === n.name));
      return `
        <g class="node" data-rel-node="${esc(n.name)}" opacity="${dim ? 0.4 : 1}">
          <circle class="ring" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${isFocused ? 26 : 22}" fill="#161920" stroke="${esc(n.color)}" stroke-width="${isFocused ? 3.5 : 2.5}" />
          <text x="${n.x.toFixed(1)}" y="${(n.y + 6).toFixed(1)}" text-anchor="middle" font-size="19">${esc(n.emoji)}</text>
          <text x="${n.x.toFixed(1)}" y="${(n.y + 36).toFixed(1)}" text-anchor="middle" fill="#e8e9ec" font-size="12" font-weight="600">${esc(n.name)}</text>
        </g>`;
    })
    .join('');

  const filteredPairs = focus ? pairs.filter((p) => p.a.name === focus || p.b.name === focus) : pairs;

  els.modalBody.innerHTML = `
    <div class="rel-layout">
      <div class="rel-graph-box">
        <svg class="rel-svg" viewBox="0 0 400 385">
          ${edgesSvg}
          ${nodesSvg}
        </svg>
        <div class="rel-legend">
          <span><i style="background:#7bc47f"></i> close</span>
          <span><i style="background:#f5b942"></i> warm</span>
          <span><i style="background:#5b667d"></i> neutral</span>
          <span><i style="background:#ff9f68"></i> cool</span>
          <span><i style="background:#ff7a6e"></i> strained</span>
        </div>
        <div class="muted" style="font-size:11px;margin-top:6px">
          ${focus ? `Filtering by <b>${esc(focus)}</b> · <a href="#" id="rel-clear" style="color:var(--accent)">show all</a>` : 'Click any person to filter their relationships'}
        </div>
      </div>

      <div>
        <div class="rel-pairs">
          ${
            filteredPairs.length
              ? filteredPairs
                  .map(
                    (p) => `
                  <div class="rel-pair-card">
                    <div class="rel-pair-head">
                      <span>${who(p.a.name)} <span class="muted">↔</span> ${who(p.b.name)}</span>
                      <span class="pill" style="margin:0">${p.interactions} interaction${p.interactions === 1 ? '' : 's'}</span>
                    </div>
                    ${
                      p.ra
                        ? `<div class="rel-dir" style="border-color:${affinityColor(p.ra.affinity)}">
                            <b>${esc(p.a.name)} → ${esc(p.b.name)}</b> <span class="muted">(${affinityWord(p.ra.affinity)})</span>:
                            ${p.ra.impression ? esc(p.ra.impression) : '<span class="muted">no specific impression yet</span>'}
                          </div>`
                        : ''
                    }
                    ${
                      p.rb
                        ? `<div class="rel-dir" style="border-color:${affinityColor(p.rb.affinity)}">
                            <b>${esc(p.b.name)} → ${esc(p.a.name)}</b> <span class="muted">(${affinityWord(p.rb.affinity)})</span>:
                            ${p.rb.impression ? esc(p.rb.impression) : '<span class="muted">no specific impression yet</span>'}
                          </div>`
                        : ''
                    }
                  </div>`,
                  )
                  .join('')
              : `<p class="empty">No conversations recorded yet${focus ? ` for ${esc(focus)}` : ''}. Let the house run for a tick or two!</p>`
          }
        </div>
      </div>
    </div>`;

  for (const g of els.modalBody.querySelectorAll('[data-rel-node]')) {
    g.addEventListener('click', () => {
      const name = g.dataset.relNode;
      state.relFocus = state.relFocus === name ? null : name;
      renderRelsModal();
    });
  }
  const clear = els.modalBody.querySelector('#rel-clear');
  if (clear) {
    clear.addEventListener('click', (e) => {
      e.preventDefault();
      state.relFocus = null;
      renderRelsModal();
    });
  }
}

function openStudioModal(tab = 'residents', target = null) {
  state.modalMode = 'studio';
  state.studioTab = tab;
  state.studioTarget = target;
  els.modalTitle.textContent = '🛠️ House & Resident Studio';
  els.modal.hidden = false;
  renderStudioModal();
}

function renderStudioModal() {
  if (state.modalMode !== 'studio') return;
  const tab = state.studioTab;
  const allRes = state.editor.residents?.length ? state.editor.residents : [...state.residents.values()];
  const rooms = [...state.rooms.values()];

  if (tab === 'residents') {
    const selectedName = state.studioTarget ?? allRes[0]?.name ?? '__new__';
    const isNew = selectedName === '__new__';
    const r = isNew
      ? {
          name: '',
          emoji: '🦊',
          color: '#6ec6ff',
          enabled: true,
          provider: 'huggingface',
          model: 'Qwen/Qwen2.5-7B-Instruct:fastest',
          age: 29,
          bio: '',
          traits: ['curious', 'warm', 'observant'],
          style: 'Conversational, grounded and witty.',
          goals: ['get to know everyone in the house'],
          homeRoom: 'bedrooms',
          wakeHour: 8,
          sleepHour: 23,
        }
      : allRes.find((x) => x.name === selectedName) || allRes[0];

    els.modalBody.innerHTML = `
      <div class="studio-tabs">
        <button class="btn active" data-studio-tab="residents">🧑 Residents (${allRes.length})</button>
        <button class="btn" data-studio-tab="rooms">🛋️ Rooms &amp; Furniture (${rooms.length})</button>
      </div>
      <div class="studio-grid">
        <div class="studio-list">
          ${allRes
            .map((item) => {
              const enabled = item.enabled !== false;
              return `
              <div class="studio-item ${!isNew && r?.name === item.name ? 'active' : ''}" data-select-res="${esc(item.name)}">
                <div>
                  <span style="font-size:16px">${esc(item.emoji)}</span>
                  <b style="color:${esc(item.color)};margin-left:4px">${esc(item.name)}</b>
                  <div class="muted" style="font-size:11px">${esc(item.provider)} · ${enabled ? 'in house' : 'away'}</div>
                </div>
                <button class="btn" style="font-size:11px;padding:3px 8px" data-toggle-res="${esc(item.name)}">${enabled ? 'Disable' : 'Enable'}</button>
              </div>`;
            })
            .join('')}
          <button class="btn primary" id="btn-new-res" style="width:100%;margin-top:4px">+ Add New Resident</button>
        </div>

        <form class="studio-form" id="res-form">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h4 style="margin:0">${isNew ? 'Create New Resident' : `Editing ${esc(r.name)}`}</h4>
            <label class="toggle"><input type="checkbox" name="enabled" ${r.enabled !== false ? 'checked' : ''} /> <span>Active in house</span></label>
          </div>
          <div class="form-row">
            <label class="field">Name
              <input name="name" value="${esc(r.name)}" placeholder="e.g. Clara" required ${isNew ? '' : 'readonly'} />
            </label>
            <label class="field">Emoji
              <input name="emoji" value="${esc(r.emoji)}" maxlength="4" required />
            </label>
            <label class="field">Color
              <input name="color" type="color" value="${esc(r.color || '#6ec6ff')}" style="height:34px;padding:2px" />
            </label>
            <label class="field">Age
              <input name="age" type="number" min="18" max="105" value="${esc(r.age ?? 30)}" />
            </label>
          </div>
          <div class="form-row">
            <label class="field">LLM Provider
              <select name="provider">
                ${['huggingface', 'openai', 'anthropic', 'openai-compatible', 'offline']
                  .map((p) => `<option value="${p}" ${r.provider === p ? 'selected' : ''}>${p}</option>`)
                  .join('')}
              </select>
            </label>
            <label class="field">Model
              <input name="model" value="${esc(r.model || '')}" placeholder="provider default" />
            </label>
            <label class="field">Home Room
              <select name="homeRoom">
                ${rooms.map((rm) => `<option value="${esc(rm.id)}" ${(r.homeRoom || 'bedrooms') === rm.id ? 'selected' : ''}>${esc(rm.name)}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="form-row">
            <label class="field">Wake Hour (0–23)
              <input name="wakeHour" type="number" min="0" max="23" value="${esc(r.wakeHour ?? 8)}" />
            </label>
            <label class="field">Sleep Hour (0–23)
              <input name="sleepHour" type="number" min="0" max="23" value="${esc(r.sleepHour ?? 23)}" />
            </label>
          </div>
          <label class="field">Bio
            <textarea name="bio" required>${esc(r.bio || '')}</textarea>
          </label>
          <div class="form-row">
            <label class="field">Traits (comma-separated)
              <input name="traits" value="${esc((r.traits || []).join(', '))}" />
            </label>
            <label class="field">Speaking Style
              <input name="style" value="${esc(r.style || '')}" />
            </label>
          </div>
          <label class="field">Goals (one per line)
            <textarea name="goals">${esc((r.goals || []).join('\n'))}</textarea>
          </label>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
            <label class="toggle"><input type="checkbox" name="persist" /> <span>Also write to config/house.json</span></label>
            <button class="btn primary" type="submit">${isNew ? 'Move Into House' : 'Save Changes'}</button>
          </div>
        </form>
      </div>`;

    bindStudioTabs();
    for (const el of els.modalBody.querySelectorAll('[data-select-res]')) {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-toggle-res]')) return;
        state.studioTarget = el.dataset.selectRes;
        renderStudioModal();
      });
    }
    for (const btn of els.modalBody.querySelectorAll('[data-toggle-res]')) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.toggleRes;
        const target = allRes.find((x) => x.name === name);
        if (!target) return;
        try {
          const snap = await post('/api/residents/save', {
            resident: { name, enabled: target.enabled === false },
            persist: false,
          });
          applySnapshot(snap);
          renderStudioModal();
        } catch (err) {
          alert(err.message);
        }
      });
    }
    els.modalBody.querySelector('#btn-new-res')?.addEventListener('click', () => {
      state.studioTarget = '__new__';
      renderStudioModal();
    });
    els.modalBody.querySelector('#res-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const resident = {
        name: String(fd.get('name') || '').trim(),
        emoji: String(fd.get('emoji') || '🧑').trim(),
        color: String(fd.get('color') || '#6ec6ff'),
        enabled: fd.get('enabled') === 'on',
        provider: String(fd.get('provider') || 'huggingface'),
        model: String(fd.get('model') || '').trim() || undefined,
        homeRoom: String(fd.get('homeRoom') || 'bedrooms'),
        age: Number(fd.get('age')) || 30,
        wakeHour: Number(fd.get('wakeHour') ?? 8),
        sleepHour: Number(fd.get('sleepHour') ?? 23),
        bio: String(fd.get('bio') || '').trim(),
        traits: String(fd.get('traits') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        style: String(fd.get('style') || '').trim(),
        goals: String(fd.get('goals') || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      try {
        const snap = await post('/api/residents/save', { resident, persist: fd.get('persist') === 'on' });
        applySnapshot(snap);
        state.studioTarget = resident.name;
        renderStudioModal();
      } catch (err) {
        alert(err.message);
      }
    });
  } else {
    const selectedRoomId = state.studioTarget && state.rooms.has(state.studioTarget) ? state.studioTarget : rooms[0]?.id;
    const room = state.rooms.get(selectedRoomId) || rooms[0];
    const roomObjects = (state.house?.objects || []).filter((o) => o.room === room.id);
    const kinds = state.editor.objectKinds?.length
      ? state.editor.objectKinds
      : ['sofa', 'armchair', 'chair', 'table', 'deskpc', 'shelf', 'plant', 'lamp', 'rug', 'easel', 'guitar', 'chess', 'telescope', 'box'];

    els.modalBody.innerHTML = `
      <div class="studio-tabs">
        <button class="btn" data-studio-tab="residents">🧑 Residents (${allRes.length})</button>
        <button class="btn active" data-studio-tab="rooms">🛋️ Rooms &amp; Furniture (${rooms.length})</button>
      </div>
      <div class="studio-grid">
        <div class="studio-list">
          ${rooms
            .map(
              (rm) => `
            <div class="studio-item ${rm.id === room.id ? 'active' : ''}" data-select-room="${esc(rm.id)}">
              <div>
                <span>${esc(rm.emoji)}</span> <b>${esc(rm.name)}</b>
                <div class="muted" style="font-size:11px">${rm.w}×${rm.h} tiles · ${esc(rm.floor)}</div>
              </div>
            </div>`,
            )
            .join('')}
        </div>

        <div class="studio-form">
          <h4 style="margin:0">${esc(room.emoji)} ${esc(room.name)} (${room.w}×${room.h} tiles)</h4>
          <form id="room-desc-form" style="display:grid;gap:8px">
            <label class="field">Room Description (seen by residents in their prompt)
              <div style="display:flex;gap:8px">
                <input name="description" value="${esc(room.description)}" style="flex:1" required />
                <button class="btn" type="submit">Update</button>
              </div>
            </label>
          </form>

          <div>
            <div class="field">Furniture &amp; Objects in ${esc(room.name)} (${roomObjects.length})</div>
            <div class="obj-list">
              ${roomObjects
                .map(
                  (o, idx) => `
                <span class="obj-chip">
                  <b>${esc(o.name)}</b> <span class="muted">(${esc(o.kind)} @ ${o.x - room.x},${o.y - room.y})</span>
                  <button type="button" title="Remove object" data-remove-obj="${idx}">✕</button>
                </span>`,
                )
                .join('')}
            </div>
          </div>

          <form id="add-obj-form" style="border-top:1px solid var(--border);padding-top:12px;display:grid;gap:10px">
            <div style="font-weight:600;font-size:13px">+ Place New Furniture in ${esc(room.name)}</div>
            <div class="form-row">
              <label class="field">Object Name (used by agents)
                <input name="name" placeholder="e.g. vintage arcade cabinet" required />
              </label>
              <label class="field">Sprite Kind
                <select name="kind">
                  ${kinds.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}
                </select>
              </label>
            </div>
            <div class="form-row">
              <label class="field">Tile X (0 to ${room.w - 1}, or blank for auto)
                <input name="x" type="number" min="0" max="${room.w - 1}" placeholder="auto" />
              </label>
              <label class="field">Tile Y (0 to ${room.h - 1}, or blank for auto)
                <input name="y" type="number" min="0" max="${room.h - 1}" placeholder="auto" />
              </label>
              <label class="field">Facing
                <select name="facing">
                  <option value="down">down</option>
                  <option value="up">up</option>
                  <option value="left">left</option>
                  <option value="right">right</option>
                </select>
              </label>
            </div>
            <div style="display:flex;justify-content:flex-end">
              <button class="btn primary" type="submit">Add to ${esc(room.name)}</button>
            </div>
          </form>
        </div>
      </div>`;

    bindStudioTabs();
    for (const el of els.modalBody.querySelectorAll('[data-select-room]')) {
      el.addEventListener('click', () => {
        state.studioTarget = el.dataset.selectRoom;
        renderStudioModal();
      });
    }
    els.modalBody.querySelector('#room-desc-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const snap = await post('/api/rooms/object', {
          room: room.id,
          action: 'description',
          description: String(fd.get('description') || ''),
        });
        applySnapshot(snap);
        renderStudioModal();
      } catch (err) {
        alert(err.message);
      }
    });
    for (const btn of els.modalBody.querySelectorAll('[data-remove-obj]')) {
      btn.addEventListener('click', async () => {
        const index = Number(btn.dataset.removeObj);
        try {
          const snap = await post('/api/rooms/object', { room: room.id, action: 'remove', index });
          applySnapshot(snap);
          renderStudioModal();
        } catch (err) {
          alert(err.message);
        }
      });
    }
    els.modalBody.querySelector('#add-obj-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const xRaw = String(fd.get('x') ?? '').trim();
      const yRaw = String(fd.get('y') ?? '').trim();
      const name = String(fd.get('name') || '').trim();
      const kind = String(fd.get('kind') || 'box');
      const facing = String(fd.get('facing') || 'down');
      const object =
        xRaw !== '' && yRaw !== ''
          ? { name, kind, x: Number(xRaw), y: Number(yRaw), facing }
          : { name, kind, facing };
      try {
        const snap = await post('/api/rooms/object', { room: room.id, action: 'add', object });
        applySnapshot(snap);
        renderStudioModal();
      } catch (err) {
        alert(err.message);
      }
    });
  }
}

function bindStudioTabs() {
  for (const btn of els.modalBody.querySelectorAll('[data-studio-tab]')) {
    btn.addEventListener('click', () => {
      state.studioTab = btn.dataset.studioTab;
      state.studioTarget = null;
      renderStudioModal();
    });
  }
}

els.play.addEventListener('click', async () => {
  const res = await post('/api/control', { action: state.running ? 'pause' : 'play' });
  state.running = res.running;
  renderControls();
});

els.step.addEventListener('click', () => post('/api/control', { action: 'step' }));

els.speed.addEventListener('change', async () => {
  const res = await post('/api/control', { action: 'speed', value: Number(els.speed.value) });
  state.speed = res.speed;
});

els.thoughts.addEventListener('change', () => {
  els.feed.classList.toggle('hide-thought', !els.thoughts.checked);
  localStorage.setItem('ville.thoughts', els.thoughts.checked ? '1' : '0');
  scrollFeed(true);
});

for (const cb of document.querySelectorAll('[data-filter]')) {
  cb.addEventListener('change', () => els.feed.classList.toggle(`hide-${cb.dataset.filter}`, !cb.checked));
}

els.humanRoom.addEventListener('change', () => post('/api/human/move', { room: els.humanRoom.value }).catch(() => {}));

els.humanName.addEventListener('change', async () => {
  const name = els.humanName.value.trim();
  if (!name) return;
  localStorage.setItem('ville.name', name);
  await post('/api/human/name', { name });
});

els.sayForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.humanText.value.trim();
  if (!text) return;
  els.humanText.value = '';
  try {
    await post('/api/human/say', { text, to: els.humanTo.value });
  } catch (err) {
    addFeedItem({ type: 'system', level: 'error', t: state.time, text: `Couldn't send that: ${err.message}` });
  }
});

els.drawerClose.addEventListener('click', closeDrawer);
els.modalClose.addEventListener('click', closeModal);
els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal) closeModal();
});
els.rels.addEventListener('click', () => openRelsModal());
els.studio.addEventListener('click', () => openStudioModal('residents'));
els.stats.addEventListener('click', openSystemModal);
els.systemNotice.addEventListener('click', openSystemModal);

function renderSoundBtn() {
  els.sound.textContent = sfx.enabled ? '🔊' : '🔇';
  els.sound.title = sfx.enabled ? 'Sound effects on (click to mute)' : 'Sound effects muted (click to enable)';
}
els.sound.addEventListener('click', () => {
  sfx.toggle();
  renderSoundBtn();
});
renderSoundBtn();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeDrawer();
  }
});

// ── boot ─────────────────────────────────────────────────────────────────────

els.thoughts.checked = localStorage.getItem('ville.thoughts') === '1';
els.feed.classList.toggle('hide-thought', !els.thoughts.checked);

const savedName = localStorage.getItem('ville.name');
if (savedName) post('/api/human/name', { name: savedName }).catch(() => {});

connect();
