'use strict';

// ---------------------------------------------------------------------------
// State + tiny helpers

const S = {
  st: null,
  usage: null,
  view: load('view') || 'studio', // 'studio' or 'game'
  gameId: load('gameId'),
  tab: load('tab') || 'feed',
  agentId: null,
  shellKey: '',
  feeds: {},
  tx: {},
  unread: {},
  pending: { feed: [], agent: [], studio: [] },
};

function load(k) { try { return localStorage.getItem(`ballast.${k}`); } catch { return null; } }
function store(k, v) { try { localStorage.setItem(`ballast.${k}`, v); } catch { /* private mode */ } }

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!res.ok || data?.error) throw new Error(data?.error || res.statusText);
  return data;
}

function toast(text, isErr = false) {
  const el = document.createElement('div');
  el.className = `toast${isErr ? ' err' : ''}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 3500);
}
const fail = (err) => toast(err.message || String(err), true);

const game = () => S.st?.games.find((g) => g.id === S.gameId);
const agentsOf = (gid) => S.st.agents.filter((a) => a.gameId === gid);
const acctOf = (id) => S.st.accounts.find((a) => a.id === id);
const agentOf = (id) => S.st.agents.find((a) => a.id === id);
const tasksOf = (gid) => S.st.tasks.filter((t) => t.gameId === gid);
// Carries the read-only file key in the path so sandboxed artifact frames (which get no
// cookie) can load, including their relative links.
const fileUrl = (...parts) => `/f/${S.st.fileKey}/${parts.map((p) => encodeURIComponent(p)).join('/')}`;

const COLORS = ['#f2a33a', '#3ecf8e', '#5aa9ff', '#b38cff', '#ff7aa8', '#4fd1c5', '#f6e05e', '#fc8181'];
function colorFor(id = '') {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
const avatar = (name, id) => `<span class="avatar" style="background:${colorFor(id)}">${esc((name || '?')[0].toUpperCase())}</span>`;

function clock(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function dur(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function ago(ts) { return ts ? `${dur(Date.now() - ts).split(' ')[0]} ago` : ''; }
function fmtTokens(n = 0) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
const money = (n = 0) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
function resetsIn(epochSec) {
  if (!epochSec) return '';
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return 'resetting';
  if (ms < 36 * 3600e3) return `resets in ${dur(ms).replace(/ \d+s$/, '')}`;
  return `resets ${new Date(epochSec * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

// Limit windows as the API reports them: five_hour is the session limit, seven_day the weekly one.
const WINDOW_LABELS = { five_hour: 'Session', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' };
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
function windowsOf(acct) {
  const w = acct?.usage?.windows || {};
  return Object.keys(w).sort((a, b) => (WINDOW_ORDER.indexOf(a) + 1 || 99) - (WINDOW_ORDER.indexOf(b) + 1 || 99))
    .map((key) => ({ key, label: WINDOW_LABELS[key] || key.replace(/_/g, ' '), ...w[key] }));
}

// Minimal markdown: fenced code, inline code, bold, headings, bullets, links.
function md(src) {
  return String(src ?? '').split('```').map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/^[\w+-]*\n/, ''))}</code></pre>`;
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,6} (.+)$/gm, '<strong class="h">$1</strong>')
      .replace(/^\s*(?:[-*•]|\d+\.) (.+)$/gm, '<span class="li">$1</span>')
      .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/^\n+|\n+$/g, '')
      .replace(/\n/g, '<br>')
      .replace(/(<\/(?:span|strong)>)<br>/g, '$1');
  }).join('');
}
const clamp = (text, html) => (text.length > 1400 || text.split('\n').length > 18)
  ? `<div class="md clamp">${html}</div><button class="more" data-act="more">Show more</button>`
  : `<div class="md">${html}</div>`;

const ICON_CLIP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.1l-9.2 9.2a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 015.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5"/></svg>';

// ---------------------------------------------------------------------------
// Modals

function modal({ title, body, wide = false, actions = [], onMount }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}">
    <header><h2>${esc(title)}</h2><button class="icon-btn" data-close title="Close">✕</button></header>
    <div class="content">${body}</div>
    ${actions.length ? `<footer>${actions.map((a, i) => `<button class="${a.kind || 'ghost'}" data-i="${i}">${esc(a.label)}</button>`).join('')}</footer>` : ''}
  </div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-close]').onclick = close;
  back.querySelectorAll('footer [data-i]').forEach((btn) => {
    btn.onclick = async () => {
      const action = actions[Number(btn.dataset.i)];
      if (!action.onClick) return close();
      btn.disabled = true;
      try {
        if ((await action.onClick(back)) !== false) close();
      } catch (err) { fail(err); } finally { btn.disabled = false; }
    };
  });
  $('#modal-root').append(back);
  back.querySelector('input, textarea, select')?.focus();
  onMount?.(back, close);
  return close;
}

function confirmModal(title, text, label, onYes) {
  modal({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: 'Cancel' }, { label, kind: 'danger', onClick: onYes }] });
}

const formData = (root) => Object.fromEntries($$('[name]', root).map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value]));

// ---------------------------------------------------------------------------
// Sidebar

function renderSide() {
  const games = [...S.st.games].sort((a, b) => (a.status === 'paused') - (b.status === 'paused'));
  const running = S.st.agents.filter((a) => a.status === 'running').length;
  $('#games').innerHTML = `<button class="game-link studio-link${S.view === 'studio' ? ' active' : ''}" data-act="studio">
      <span class="gname">Studio</span><span class="hint" style="margin:0">${running ? `${running} running` : 'overview'}</span>
    </button>` + (games.length ? games.map((g) => {
    const agents = agentsOf(g.id);
    const unread = S.unread[g.id] || 0;
    return `<button class="game-link${S.view === 'game' && g.id === S.gameId ? ' active' : ''}${g.status === 'paused' ? ' paused' : ''}" data-act="game" data-id="${g.id}">
      <span class="gname">${esc(g.name)}</span>
      ${unread ? `<span class="badge">${unread}</span>` : ''}
      ${g.status === 'paused' ? '<span class="hint" style="margin:0">paused</span>' : `<span class="dots">${agents.map((a) => `<span class="dot ${a.status}"></span>`).join('')}</span>`}
    </button>`;
  }).join('') : '<p class="hint" style="padding:0 10px">No games yet.</p>');

  $('#accounts').innerHTML = S.st.accounts.length ? S.st.accounts.map(acctRow).join('') : '<p class="hint" style="padding:0 10px">Add each Claude account you want working.</p>';
}

function meter(w, { full = false } = {}) {
  if (w.utilization == null) return '';
  const pct = Math.round(w.utilization * 100);
  const cls = pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '';
  const reset = resetsIn(w.resetsAt);
  return `<div class="meter${full ? ' full' : ''}" title="${esc(w.label)}: ${pct}% used${reset ? `, ${reset}` : ''}">
    <span>${esc(w.label)}</span><span class="bar"><i class="${cls}" style="width:${Math.min(100, pct)}%"></i></span><span>${pct}%</span>
    ${full ? `<span class="reset">${esc(reset)}</span>` : ''}
  </div>`;
}

const todayTokens = (accountId) => S.usage?.accounts?.[accountId]?.today || null;

function acctRow(a) {
  const status = !a.loggedIn ? 'error' : a.limited ? 'limited' : a.running ? 'running' : 'idle';
  const today = todayTokens(a.id);
  const sub = !a.loggedIn ? 'Not logged in'
    : a.limited ? `Out of usage until ${clock(a.limitedUntil)}`
    : [a.email, a.plan, today?.tokens ? `${fmtTokens(today.tokens)} tokens today` : ''].filter(Boolean).join(' · ') || 'Logged in';
  return `<div class="acct">
    <div class="row">
      <span class="dot ${status}"></span>
      <span class="aname">${esc(a.name)}${a.isDefault ? ' <span class="hint" style="display:inline">(this PC)</span>' : ''}</span>
      ${!a.loggedIn ? `<button class="primary small" data-act="acct-login" data-id="${a.id}">Log in</button>` : ''}
      <span class="actions">
        <button class="icon-btn" data-act="acct-refresh" data-id="${a.id}" title="Re-check login">⟳</button>
        <button class="icon-btn" data-act="acct-edit" data-id="${a.id}" title="Edit">✎</button>
      </span>
    </div>
    <div class="sub">${esc(sub)}${a.running ? ` · ${a.running} running` : ''}</div>
    ${windowsOf(a).slice(0, 2).map((w) => meter(w)).join('')}
  </div>`;
}

// ---------------------------------------------------------------------------
// Header + tabs

const PRIORITY = { 3: 'high', 2: 'normal', 1: 'low' };

function renderHead() {
  if (S.view === 'studio') {
    if (!S.st.accounts.length) { $('#ghead').innerHTML = ''; return; }
    const running = S.st.agents.filter((a) => a.status === 'running').length;
    const t = Object.values(S.usage?.accounts || {}).reduce((sum, a) => sum + a.today.tokens, 0);
    $('#ghead').innerHTML = `<div><h1>Studio</h1><span class="hint" style="margin:0">${S.st.games.length} games · ${S.st.agents.length} agents · ${running} running · ${fmtTokens(t)} tokens today</span></div>
      <span class="spacer"></span>
      <button class="ghost small" data-act="probe-all" title="Re-check session and weekly limits on every account">Refresh limits</button>
      <button class="ghost small" data-act="sync-all" title="Re-read claude.ai artifacts and comments on every account">Sync claude.ai</button>`;
    return;
  }
  const g = game();
  if (!g) { $('#ghead').innerHTML = ''; return; }
  const agents = agentsOf(g.id);
  $('#ghead').innerHTML = `
    <div>
      <h1>${esc(g.name)}</h1>
      <button class="repo" data-act="open-folder" data-path="${esc(g.repoPath)}" title="Open folder">${esc(g.repoPath)}</button>
    </div>
    ${g.runner === 'cloud'
      ? `<a class="pill queued" href="https://github.com/${esc(g.github)}" target="_blank" rel="noopener" title="Agents run as Claude cloud sessions and open pull requests into ${esc(g.baseBranch)}">cloud · ${esc(g.github)}</a>`
      : `<span class="pill" title="${g.isolation === 'worktree' ? `Each agent has its own git worktree; finished work lands on ${esc(g.integrationBranch)}` : 'All agents edit the same folder'}">${g.isolation === 'worktree' ? 'worktrees' : 'shared tree'}</span>`}
    ${g.cloudError ? `<span class="pill error" title="${esc(g.cloudError)}">GitHub unreachable</span>` : ''}
    ${g.status === 'paused' ? '<span class="pill limited">paused</span>' : ''}
    ${(g.priority ?? 2) !== 2 ? `<span class="pill">${PRIORITY[g.priority]} priority</span>` : ''}
    <span class="spacer"></span>
    <span class="dots" title="${agents.map((a) => `${a.name}: ${a.status}`).join('\n')}">${agents.map((a) => `<span class="dot ${a.status}"></span>`).join('')}</span>
    <label class="switch" title="When on, idle agents keep claiming open board tasks on their own"><input type="checkbox" id="autopilot" ${g.autopilot ? 'checked' : ''}><i></i>Autopilot</label>
    <button class="ghost small" data-act="wake" title="Hand open board tasks to idle agents now">Wake idle</button>`;
}

function renderTabs() {
  const g = game();
  if (S.view === 'studio' || !g || !S.st.accounts.length) { $('#tabs').innerHTML = ''; return; }
  const agents = agentsOf(g.id);
  const running = agents.filter((a) => a.status === 'running').length;
  const open = tasksOf(g.id).filter((t) => t.status === 'open' || t.status === 'claimed').length;
  const arts = S.st.artifacts.filter((a) => a.gameId === g.id).length + S.st.cloudArtifacts.filter((a) => a.gameId === g.id).length;
  const tabs = [
    ['feed', 'Feed', ''],
    ['agents', 'Agents', agents.length ? `${running}/${agents.length}` : ''],
    ['board', 'Board', open || ''],
    ['builds', 'Builds', ''],
    ['artifacts', 'Artifacts', arts || ''],
    ['settings', 'Settings', ''],
  ];
  $('#tabs').innerHTML = tabs.map(([id, label, count]) =>
    `<button class="${S.tab === id ? 'active' : ''}" data-act="tab" data-tab="${id}">${label}${count !== '' ? `<span class="count">${count}</span>` : ''}</button>`).join('');
}

// ---------------------------------------------------------------------------
// View shells: rebuilt on game/tab switches only, so typing is never clobbered.

function buildShell() {
  const g = game();
  const v = $('#view');
  S.shellKey = shellKey();
  if (!S.st.accounts.length || (!g && S.view === 'game') || (S.view === 'studio' && !S.st.games.length)) {
    v.innerHTML = onboarding();
    return;
  }
  if (S.view === 'studio') {
    v.innerHTML = studioShell();
    bindComposer('studio');
    return;
  }
  switch (S.tab) {
    case 'feed':
      v.innerHTML = `<div class="feed scroll" id="feed-list"></div>${composer('feed', `Note to every agent on ${g.name}: gameplay review, art notes, direction…`)}`;
      bindComposer('feed');
      updateTargetSelect();
      loadFeed();
      break;
    case 'agents':
      v.innerHTML = '<div class="split"><div class="agent-list" id="agent-list"></div><div class="agent-pane" id="agent-pane"></div></div>';
      buildAgentPane();
      break;
    case 'board':
      v.innerHTML = `<div class="board-wrap">
        <form class="task-form" id="task-form">
          <input name="title" placeholder="New task, e.g. [gameplay] Coyote time on jumps" autocomplete="off">
          <input name="detail" placeholder="Detail / done-condition (optional)" autocomplete="off">
          <button class="primary small">Add</button>
        </form>
        <div class="board" id="board"></div></div>`;
      $('#task-form').onsubmit = async (e) => {
        e.preventDefault();
        const f = formData(e.target);
        if (!f.title.trim()) return;
        try {
          await api('POST', `/api/games/${g.id}/tasks`, f);
          e.target.reset();
          e.target.title.focus();
        } catch (err) { fail(err); }
      };
      break;
    case 'builds':
      v.innerHTML = '<div class="scroll pad" style="flex:1" id="builds"></div>';
      break;
    case 'artifacts':
      v.innerHTML = `<div class="scroll" style="flex:1">
        <div class="pad" style="padding-bottom:0">
          <div class="section-head"><h3>claude.ai artifacts</h3><button class="ghost small" data-act="cloud-track">+ Track a claude.ai artifact</button></div>
          <div id="cloud-arts"></div>
          <div class="section-head" style="margin-top:22px"><h3>Files from agents</h3></div>
        </div>
        <div class="grid" id="arts" style="overflow:visible;padding-top:4px"></div>
      </div>`;
      break;
    case 'settings':
      v.innerHTML = `<div class="scroll pad" style="flex:1">${settingsForm(g)}</div>`;
      bindSettings(g);
      break;
  }
}

// The onboarding checklist also depends on login state, so it rebuilds when that changes.
const shellKey = () => S.view === 'studio'
  ? `studio|${S.st.games.map((g) => g.id + g.name).join()}|${S.st.accounts.length > 0}|${S.st.accounts.some((a) => a.loggedIn)}`
  : `${S.gameId}|${S.tab}|${S.st.accounts.length > 0}|${!!game()}|${!game() && S.st.accounts.some((a) => a.loggedIn)}`;

function renderLive() {
  if (shellKey() !== S.shellKey) buildShell();
  renderSide();
  renderHead();
  renderTabs();
  if (S.view === 'studio') return renderStudio();
  if (!game()) return;
  switch (S.tab) {
    case 'feed': updateTargetSelect(); break;
    case 'agents': {
      renderAgentList();
      const selected = agentOf(S.agentId);
      const stale = !selected || selected.gameId !== S.gameId || !$('#agent-head');
      if (stale && (agentsOf(S.gameId).length || $('#agent-head'))) buildAgentPane();
      else renderAgentHead();
      break;
    }
    case 'board': renderBoard(); break;
    case 'builds': renderBuilds(); break;
    case 'artifacts': renderArtifacts(); renderCloudArtifacts(); break;
  }
}

function onboarding() {
  const hasAcct = S.st.accounts.length > 0;
  const loggedIn = S.st.accounts.some((a) => a.loggedIn);
  return `<div class="empty">
    <h2>Ballast</h2>
    <p>Every Claude account you add becomes an agent. Point a game at a repo, send notes to the whole team, and they split the work between themselves.</p>
    <div class="steps">
      <div><b>1</b>Add your Claude accounts ${hasAcct ? '✓' : `<button class="primary small" data-act="new-account" style="float:right">Add account</button>`}</div>
      <div><b>2</b>Log each one in ${loggedIn ? '✓' : '<span class="hint" style="display:inline">(use Log in next to the account)</span>'}</div>
      <div><b>3</b>Create a game from a repo or an empty folder ${hasAcct ? `<button class="primary small" data-act="new-game" style="float:right">New game</button>` : ''}</div>
      <div><b>4</b>Send a note. Agents triage it onto the board and get to work.</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Composer (feed + per-agent)

function composer(kind, placeholder) {
  return `<form class="composer" id="composer-${kind}" autocomplete="off">
    <div class="inner">
      <div class="chips" id="chips-${kind}"></div>
      <textarea rows="2" placeholder="${esc(placeholder)}"></textarea>
      <div class="bar">
        ${kind === 'feed' ? '<select id="target" title="Who gets this message"></select>' : ''}
        <button type="button" class="icon-btn" data-attach title="Attach images or files">${ICON_CLIP}</button>
        <input type="file" multiple hidden>
        <p class="hint">Enter to send · Shift+Enter for a new line · paste or drop screenshots</p>
        <button class="primary small" type="submit">Send</button>
      </div>
    </div>
  </form>`;
}

function updateTargetSelect() {
  const sel = $('#target');
  const g = game();
  if (!sel || !g) return;
  const keep = sel.value || 'all';
  const agents = agentsOf(g.id);
  sel.innerHTML = `<option value="all">All agents (${agents.length})</option>${agents.map((a) => `<option value="${a.id}">Only ${esc(a.name)}</option>`).join('')}`;
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'all';
}

function renderChips(kind) {
  const el = $(`#chips-${kind}`);
  if (!el) return;
  el.innerHTML = S.pending[kind].map((f, i) => `<span class="chip">${f.isImage ? `<img src="${f.url}">` : ''}${esc(f.name)}<button type="button" data-act="chip-remove" data-kind="${kind}" data-i="${i}">✕</button></span>`).join('');
}

async function upload(kind, files) {
  const g = game();
  for (const file of files) {
    if (file.size > 60e6) { toast(`${file.name} is over 60 MB`, true); continue; }
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    try {
      const endpoint = kind === 'studio' ? '/api/studio/attachments' : `/api/games/${g.id}/attachments`;
      const saved = await api('POST', endpoint, { name: file.name || 'pasted.png', data });
      S.pending[kind].push({ ...saved, isImage: file.type.startsWith('image/') });
      renderChips(kind);
    } catch (err) { fail(err); }
  }
}

function bindComposer(kind) {
  const form = $(`#composer-${kind}`);
  const ta = $('textarea', form);
  const fileInput = $('input[type=file]', form);
  S.pending[kind] = [];
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(260, ta.scrollHeight)}px`; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); upload(kind, files); }
  });
  $('[data-attach]', form).onclick = () => fileInput.click();
  fileInput.onchange = () => { upload(kind, [...fileInput.files]); fileInput.value = ''; };
  form.addEventListener('dragover', (e) => { e.preventDefault(); form.classList.add('drag'); });
  form.addEventListener('dragleave', () => form.classList.remove('drag'));
  form.addEventListener('drop', (e) => {
    e.preventDefault();
    form.classList.remove('drag');
    upload(kind, [...e.dataTransfer.files]);
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    const attachments = S.pending[kind];
    if (!text && !attachments.length) return;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const files = attachments.map(({ name, path, url }) => ({ name, path, url }));
      if (kind === 'studio') {
        const gameIds = $$('[name=st-game]:checked').map((el) => el.value);
        if (!gameIds.length) throw new Error('Tick at least one game.');
        const r = await api('POST', '/api/studio/notes', { gameIds, text, attachments: files });
        toast(`Sent to ${r.sent} game${r.sent > 1 ? 's' : ''}`);
      } else {
        const target = kind === 'feed' ? $('#target').value : S.agentId;
        await api('POST', `/api/games/${S.gameId}/notes`, { text, target, attachments: files });
      }
      ta.value = '';
      grow();
      S.pending[kind] = [];
      renderChips(kind);
    } catch (err) { fail(err); } finally { btn.disabled = false; ta.focus(); }
  };
}

// ---------------------------------------------------------------------------
// Feed

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }

async function loadFeed() {
  const gid = S.gameId;
  try {
    const list = await api('GET', `/api/games/${gid}/feed?limit=300`);
    S.feeds[gid] = list;
    const el = $('#feed-list');
    if (!el || gid !== S.gameId) return;
    el.innerHTML = list.length ? list.map(feedEntry).join('') : emptyFeed();
    el.scrollTop = el.scrollHeight;
  } catch (err) { fail(err); }
}

const emptyFeed = () => `<div class="empty" id="feed-empty"><h2>Nothing here yet</h2><p>Write a note below. One agent splits it into board tasks, then every agent on this game picks up work.</p></div>`;

function attachmentsHtml(list = []) {
  if (!list.length) return '';
  return `<div class="thumbs">${list.map((a) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name)
    ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" data-act="img-zoom">`
    : `<a class="file" href="${esc(a.url)}?download">${esc(a.name)}</a>`).join('')}</div>`;
}

function feedEntry(e) {
  const when = `<span class="when">${clock(e.ts)}</span>`;
  if (e.kind === 'system') return `<div class="entry system"><div class="body">${esc(e.text)} · ${clock(e.ts)}</div></div>`;
  let av = e.agentId ? avatar(e.from, e.agentId) : '';
  let label = '';
  if (e.kind === 'note') {
    av = e.source === 'review' ? '<span class="avatar" style="background:var(--violet)">R</span>' : '<span class="avatar" style="background:var(--accent)">★</span>';
    const src = e.source === 'review' ? 'review · ' : e.source === 'studio' ? 'studio · ' : '';
    label = e.to ? `<span class="pill">to ${esc(e.to)} only</span>` : `<span class="pill limited">${src}note #${e.num} · all agents</span>`;
  } else if (e.kind === 'cloud') {
    av = '<span class="avatar" style="background:var(--violet)">C</span>';
    label = '<span class="pill" style="color:var(--violet)">claude.ai</span>';
  } else if (e.kind === 'update') label = '<span class="pill queued">update</span>';
  else if (e.kind === 'task') label = '<span class="pill">board</span>';
  else if (e.kind === 'artifact') label = '<span class="pill" style="color:var(--violet)">artifact</span>';
  else if (e.kind === 'error') label = '<span class="pill error">error</span>';
  else if (e.kind === 'build') {
    av = '<span class="avatar" style="background:var(--violet)">B</span>';
    label = `<span class="pill ${esc(e.status)}">${esc(e.status)}</span>`;
  } else if (e.itemKind === 'triage') label = '<span class="pill">triage</span>';

  let body = clamp(e.text || '', md(e.text));
  if (e.kind === 'task' || e.kind === 'error') body = `<div class="md">${md(e.text)}</div>`;
  if (e.kind === 'artifact' && e.artifactId) body = `<div class="art-ref"><div class="md" style="flex:1">${md(e.text)}</div><button class="btn small" data-act="art-open" data-id="${e.artifactId}">Open</button></div>`;
  if (e.kind === 'build') body += `<div style="margin-top:8px"><button class="btn small" data-act="build-log" data-id="${e.buildId}">View log</button></div>`;
  return `<div class="entry ${e.kind}">
    <div class="head">${av}<span class="who">${esc(e.from || (e.kind === 'build' ? 'Build' : 'Ballast'))}</span>${label}${when}</div>
    <div class="body">${body}${attachmentsHtml(e.attachments)}</div>
  </div>`;
}

function appendFeed(entry) {
  const el = $('#feed-list');
  if (!el) return;
  const stick = nearBottom(el);
  $('#feed-empty')?.remove();
  el.insertAdjacentHTML('beforeend', feedEntry(entry));
  if (stick) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Agents

function statusPill(a) {
  if (a.status === 'running') return `<span class="pill running">running <span data-since="${a.startedAt}"></span></span>`;
  if (a.status === 'queued') return `<span class="pill queued">queued ${a.queue}</span>`;
  return `<span class="pill ${a.status}">${a.status}</span>`;
}

function renderAgentList() {
  const el = $('#agent-list');
  if (!el) return;
  const g = game();
  const agents = agentsOf(g.id);
  el.innerHTML = agents.map((a) => {
    const acct = acctOf(a.accountId);
    const held = S.st.tasks.find((t) => t.claimedBy === a.id && t.status === 'claimed');
    return `<button class="agent-card${a.id === S.agentId ? ' active' : ''}" data-act="agent-select" data-id="${a.id}">
      <div class="row">${avatar(a.name, a.id)}<span class="name">${esc(a.name)}${g.leadAgentId === a.id ? ' <span class="hint" style="display:inline">lead</span>' : ''}</span>${statusPill(a)}</div>
      <div class="meta">${esc([a.role, acct?.name, a.branch].filter(Boolean).join(' · '))}</div>
      <div class="meta">${held ? `on #${held.num} ${esc(held.title)}` : `${a.turns || 0} turns · $${(a.costUsd || 0).toFixed(2)}`}</div>
    </button>`;
  }).join('') + `<button class="ghost" data-act="agent-add" style="margin-top:4px">+ Add agent</button>
    ${agents.length ? '' : '<p class="hint">Add an agent per Claude account you want on this game. Agents on the same account share its usage.</p>'}`;
}

function buildAgentPane() {
  const pane = $('#agent-pane');
  if (!pane) return;
  const agents = agentsOf(S.gameId);
  if (!agentOf(S.agentId) || agentOf(S.agentId).gameId !== S.gameId) S.agentId = agents[0]?.id || null;
  renderAgentList();
  if (!S.agentId) {
    pane.innerHTML = '<div class="empty"><h2>No agents yet</h2><p>Add one for each Claude account that should work on this game.</p><button class="primary" data-act="agent-add">Add agent</button></div>';
    return;
  }
  const cloudRun = game()?.runner === 'cloud';
  pane.innerHTML = `<div class="agent-head" id="agent-head"></div><div class="tx scroll" id="tx-list"></div>${composer('agent', cloudRun ? 'Message this agent: goes to its live cloud session, or starts a new one…' : 'Message only this agent…')}`;
  bindComposer('agent');
  renderAgentHead();
  loadTranscript();
}

function renderAgentHead() {
  const el = $('#agent-head');
  const a = agentOf(S.agentId);
  if (!el || !a) return;
  const acct = acctOf(a.accountId);
  if (game()?.runner === 'cloud') {
    const live = a.cloud;
    const last = a.lastCloud;
    const task = live?.taskId && S.st.tasks.find((t) => t.id === live.taskId);
    el.innerHTML = `${avatar(a.name, a.id)}<h3>${esc(a.name)}</h3>${statusPill(a)}<span class="pill">${esc(acct?.name || '?')}</span>
      <span class="spacer"></span>
      ${live ? `<a class="btn small" href="${esc(live.url)}" target="_blank" rel="noopener">Open cloud session</a><button class="danger small" data-act="agent-stop" title="Stop tracking this session and put its task back on the board">Stop</button>` : ''}
      <button class="ghost small" data-act="agent-edit">Edit</button>
      <button class="ghost small" data-act="agent-remove">Remove</button>
      <div class="hint" style="flex-basis:100%;margin:0">${live
        ? `Working on ${task ? `#${task.num} ${esc(task.title)}` : live.key === 'survey' ? 'the project survey' : 'your message'} since ${clock(live.since)}. Ballast checks GitHub every 90 seconds for its report.`
        : last ? `Last session finished ${ago(last.at)}: ${last.pr ? `<a href="${esc(last.pr)}" target="_blank" rel="noopener">pull request</a>` : `branch ${esc(last.branch)}`} · <a href="${esc(last.url)}" target="_blank" rel="noopener">session</a>`
        : 'Idle. Gets a cloud session as soon as there is an open task (with autopilot on) or a message for it.'}
        ${a.role ? ` · ${esc(a.role)}` : ''}</div>
      ${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}`;
    return;
  }
  el.innerHTML = `${avatar(a.name, a.id)}<h3>${esc(a.name)}</h3>${statusPill(a)}<span class="pill">${esc(acct?.name || '?')}</span>
    <span class="spacer"></span>
    ${a.status === 'running' || a.status === 'queued' ? '<button class="danger small" data-act="agent-stop">Stop</button>' : ''}
    <button class="ghost small" data-act="agent-edit">Edit</button>
    <button class="ghost small" data-act="agent-sessions" title="Continue a Claude Code session this account already has in this repo">Sessions</button>
    <button class="ghost small" data-act="agent-term" title="Open this Claude session in a terminal window">Terminal</button>
    <button class="ghost small" data-act="agent-reset" title="Start a fresh Claude session next time">New session</button>
    <button class="ghost small" data-act="agent-remove">Remove</button>
    <div class="hint" style="flex-basis:100%;margin:0">${esc(a.cwd)}${a.sessionId ? ` · session ${esc(a.sessionId.slice(0, 8))}` : ''}${a.role ? ` · ${esc(a.role)}` : ''}</div>
    ${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}`;
}

async function loadTranscript() {
  const id = S.agentId;
  try {
    const list = await api('GET', `/api/agents/${id}/transcript?limit=500`);
    S.tx[id] = list;
    const el = $('#tx-list');
    if (!el || id !== S.agentId) return;
    const none = game()?.runner === 'cloud'
      ? 'Cloud agents work on claude.ai, so their step-by-step transcript lives in the cloud session (link above). Ballast records what was sent and what came back here.'
      : 'No turns yet. Message this agent directly, or send a note to the whole game from the Feed.';
    el.innerHTML = list.length ? list.map(txEntry).join('') : `<div class="empty"><p>${none}</p></div>`;
    el.scrollTop = el.scrollHeight;
  } catch (err) { fail(err); }
}

const ITEM_LABEL = { triage: 'triage note', note: 'director note', message: 'message', next: 'autopilot', nudge: 'nudge', survey: 'project survey' };

function txEntry(e) {
  switch (e.kind) {
    case 'prompt': {
      const first = esc(e.text.split('\n')[0].slice(0, 120));
      return `<details class="t-prompt"><summary>Ballast → ${ITEM_LABEL[e.itemKind] || 'message'} · ${clock(e.ts)} · ${first}</summary><div class="md">${md(e.text)}</div></details>`;
    }
    case 'system': return `<div class="t-sys">${esc(e.text)} · ${clock(e.ts)}</div>`;
    case 'text': return `<div class="t-text md">${md(e.text)}</div>`;
    case 'tool': return `<div class="t-tool" title="${esc(e.detail)}">⏵ <b>${esc(e.name)}</b> ${esc(e.detail)}</div>`;
    case 'tool_result': return `<details class="t-res${e.ok ? '' : ' bad'}"><summary>${e.ok ? 'result' : 'error'}</summary><pre>${esc(e.text)}</pre></details>`;
    case 'result': return `<div class="t-result">Turn ${e.ok ? 'finished' : 'failed'} · ${dur(e.durationMs)} · ${e.steps || 0} steps${e.cost != null ? ` · $${Number(e.cost).toFixed(3)}` : ''}</div>`;
    case 'error': return `<div class="t-error">${esc(e.text)}</div>`;
    default: return '';
  }
}

function appendTx(entry) {
  const el = $('#tx-list');
  if (!el) return;
  const stick = nearBottom(el);
  $('.empty', el)?.remove();
  el.insertAdjacentHTML('beforeend', txEntry(entry));
  if (stick) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Board

function renderBoard() {
  const el = $('#board');
  if (!el) return;
  const tasks = tasksOf(S.gameId);
  const name = (id) => agentOf(id)?.name || 'removed agent';
  const cols = [['open', 'Open'], ['claimed', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
  el.innerHTML = cols.map(([status, label]) => {
    let list = tasks.filter((t) => t.status === status);
    list = status === 'done' ? list.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 40) : list.sort((a, b) => a.num - b.num);
    return `<div class="col"><h5>${label} <span>${tasks.filter((t) => t.status === status).length}</span></h5>${list.map((t) => {
      const meta = status === 'claimed' ? `${esc(name(t.claimedBy))} · ${ago(t.claimedAt)}`
        : status === 'done' ? `${esc(name(t.doneBy))} · ${ago(t.doneAt)}`
        : `from ${esc(t.createdBy || '?')}${t.noteNum ? ` · note #${t.noteNum}` : ''}`;
      const acts = [
        status !== 'open' && `<button class="ghost small" data-act="task-status" data-id="${t.id}" data-status="open">Reopen</button>`,
        status !== 'done' && `<button class="ghost small" data-act="task-status" data-id="${t.id}" data-status="done">Done</button>`,
        `<button class="ghost small" data-act="task-edit" data-id="${t.id}">Edit</button>`,
        `<button class="ghost small" data-act="task-delete" data-id="${t.id}">Delete</button>`,
      ].filter(Boolean).join('');
      return `<div class="task">
        <div><span class="num">#${t.num}</span><span class="title">${esc(t.title)}</span></div>
        <div class="meta">${meta}${t.note && status === 'open' ? ` · ${esc(t.note)}` : ''}</div>
        ${t.detail && status !== 'done' ? `<div class="detail">${esc(t.detail)}</div>` : ''}
        ${t.summary ? `<div class="summary">${esc(t.summary)}</div>` : ''}
        ${t.blockReason && status === 'blocked' ? `<div class="blocked">${esc(t.blockReason)}</div>` : ''}
        <div class="acts">${acts}</div>
      </div>`;
    }).join('')}</div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Builds

function nextCheckin(times) {
  if (!times?.length) return null;
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return times.find((t) => t > hm) || times[0];
}

function renderBuilds() {
  const el = $('#builds');
  if (!el) return;
  const g = game();
  const builds = S.st.builds.filter((b) => b.gameId === g.id).reverse();
  const running = builds.some((b) => b.status === 'running');
  const next = nextCheckin(g.build.checkins);
  el.innerHTML = `
    <div class="card build-top">
      <div class="grow">
        <b>Daily check-ins</b>
        <div class="slots">${g.build.checkins.length ? g.build.checkins.map((t) => `<span class="slot${t === next ? ' next' : ''}">${t}</span>`).join('') : '<span class="hint">None scheduled. Set times in Settings.</span>'}</div>
        <div class="hint">${g.build.command ? `Runs <code>${esc(g.build.command.slice(0, 120))}</code> on ${g.isolation === 'worktree' ? esc(g.integrationBranch) : 'the shared tree'}` : 'No build command yet: check-ins post a changelog only.'}</div>
      </div>
      ${running ? '<button class="danger" data-act="build-cancel">Cancel build</button>' : '<button class="primary" data-act="build-now">Build now</button>'}
    </div>
    ${builds.length ? builds.map(buildCard).join('') : '<p class="hint">No builds yet.</p>'}`;
}

function buildCard(b) {
  const title = b.slot ? `${b.slot} check-in` : b.reason === 'manual' ? 'Manual build' : 'Check-in';
  const files = (b.files || []).map((f) => `<a href="${fileUrl('builds', b.gameId, b.id, 'output', f)}?download">${esc(f)}</a>`).join('');
  const changes = [b.tasksDone?.length ? `Done:\n${b.tasksDone.map((t) => `• ${t}`).join('\n')}` : '', b.changelog ? `Commits:\n${b.changelog}` : ''].filter(Boolean).join('\n\n');
  return `<div class="card build">
    <div class="row">
      <span class="pill ${esc(b.status)}">${esc(b.status)}</span><b>${esc(title)}</b>
      <span class="grow hint" style="margin:0">${clock(b.startedAt)} · ${b.finishedAt ? dur(b.finishedAt - b.startedAt) : `<span data-since="${b.startedAt}"></span>`}${b.commit ? ` · ${esc(b.commit)}` : ''}</span>
      ${b.outDir ? `<button class="ghost small" data-act="open-folder" data-path="${esc(b.outDir)}">Folder</button>` : ''}
      <button class="ghost small" data-act="build-log" data-id="${b.id}">Log</button>
    </div>
    ${b.error ? `<div class="blocked" style="color:var(--red);margin-top:6px">${esc(b.error)}</div>` : ''}
    ${b.warning ? `<div class="hint">${esc(b.warning)}</div>` : ''}
    ${files ? `<div class="files">${files}</div>` : ''}
    ${b.sharedTo ? `<div class="hint">Shared to <a href="#" data-act="open-folder" data-path="${esc(b.sharedTo)}">${esc(b.sharedTo)}</a></div>` : ''}
    ${changes ? `<details style="margin-top:8px"><summary class="hint" style="display:inline;cursor:pointer">Changes</summary><pre>${esc(changes)}</pre></details>` : ''}
  </div>`;
}

function showBuildLog(id) {
  let timer;
  const close = modal({
    title: 'Build log',
    wide: true,
    body: '<pre id="build-log" style="margin:0;min-height:100%">Loading…</pre>',
    onMount: (root) => {
      const refreshLog = async () => {
        if (!root.isConnected) return clearInterval(timer);
        const pre = $('#build-log', root);
        const stick = pre.parentElement.scrollHeight - pre.parentElement.scrollTop - pre.parentElement.clientHeight < 80;
        try { pre.textContent = (await api('GET', `/api/builds/${id}/log`)) || '(empty)'; } catch (err) { pre.textContent = err.message; }
        if (stick) pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
        if (S.st.builds.find((b) => b.id === id)?.status !== 'running') clearInterval(timer);
      };
      refreshLog();
      timer = setInterval(refreshLog, 2000);
    },
  });
  return close;
}

// ---------------------------------------------------------------------------
// Artifacts

const artUrl = (a) => fileUrl('artifacts', a.gameId, a.id, a.entry);

function renderArtifacts() {
  const el = $('#arts');
  if (!el) return;
  const arts = S.st.artifacts.filter((a) => a.gameId === S.gameId).sort((a, b) => b.createdAt - a.createdAt);
  if (!arts.length) {
    el.innerHTML = '<div class="empty" style="grid-column:1/-1"><h2>No artifacts yet</h2><p>Agents publish prototypes, mockups, design docs and screenshots here with their publish_artifact tool. Ask for one in a note: "make an HTML mock of the new HUD".</p></div>';
    return;
  }
  el.innerHTML = arts.map((a, i) => {
    const thumb = a.kind === 'image' ? `<img src="${artUrl(a)}" loading="lazy">`
      : a.kind === 'html' && i < 24 ? `<iframe src="${artUrl(a)}" sandbox="allow-scripts" loading="lazy" tabindex="-1"></iframe>`
      : esc(a.kind.toUpperCase());
    return `<button class="art" data-act="art-open" data-id="${a.id}">
      <div class="thumb">${thumb}</div>
      <div class="info"><div class="title">${esc(a.title)}</div><div class="meta">${esc(a.agentName)} · ${clock(a.createdAt)}</div>
      ${a.description ? `<div class="meta">${esc(a.description.slice(0, 120))}</div>` : ''}</div>
    </button>`;
  }).join('');
}

async function openArtifact(id) {
  const a = S.st.artifacts.find((x) => x.id === id);
  if (!a) return toast('That artifact was removed.', true);
  const url = artUrl(a);
  let body;
  if (a.kind === 'html') body = `<iframe class="viewer" src="${url}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock"></iframe>`;
  else if (a.kind === 'image') body = `<img class="viewer-img" src="${url}">`;
  else if (a.kind === 'video') body = `<video src="${url}" controls style="width:100%"></video>`;
  else if (a.kind === 'audio') body = `<audio src="${url}" controls style="width:100%"></audio>`;
  else if (a.kind === 'markdown' || a.kind === 'text') {
    const text = await fetch(url).then((r) => r.text()).catch((e) => e.message);
    body = a.kind === 'markdown' ? `<div class="md">${md(text)}</div>` : `<pre>${esc(text)}</pre>`;
  } else body = `<p>${esc(a.entry)}</p><a class="btn" href="${url}?download">Download</a>`;
  modal({
    title: a.title,
    wide: ['html', 'image', 'video', 'markdown', 'text'].includes(a.kind),
    body: `${a.description ? `<p class="hint" style="margin-top:0">${esc(a.description)}</p>` : ''}${body}`,
    actions: [
      { label: 'Delete', kind: 'danger', onClick: () => api('DELETE', `/api/artifacts/${a.id}`) },
      { label: 'Download', onClick: () => { location.href = `${url}?download`; } },
      { label: 'Open in new tab', onClick: () => { window.open(url, '_blank', 'noopener'); } },
    ],
  });
}

// ---------------------------------------------------------------------------
// Studio: every account, every game

function studioShell() {
  const games = S.st.games;
  return `<div class="scroll pad studio" style="flex:1">
    <section><div class="section-head"><h3>Accounts &amp; limits</h3><span class="hint">Session = 5-hour limit · Weekly = 7-day limit · autopilot pauses an account above ${S.st.settings.limitGuardPct}%</span></div><div class="acct-grid" id="st-accounts"></div></section>
    <section><div class="section-head"><h3>Token usage</h3><span class="hint">Every Claude run Ballast makes: agent turns, artifact syncs, limit checks</span></div><div class="card" id="st-usage"></div></section>
    <section><div class="section-head"><h3>Games</h3><button class="ghost small" data-act="new-game">+ New game</button></div><div class="game-grid" id="st-games"></div></section>
    <section><div class="section-head"><h3>Note to several games</h3></div>
      <div class="targets">${games.map((g) => `<label class="check"><input type="checkbox" name="st-game" value="${g.id}" ${g.status === 'paused' ? '' : 'checked'}><span>${esc(g.name)}</span></label>`).join('')}</div>
      <div class="studio-composer">${composer('studio', 'Studio-wide direction: shared tech, art style, a process change… Each ticked game triages it onto its own board.')}</div>
    </section>
    <section><div class="section-head"><h3>claude.ai artifacts</h3><button class="ghost small" data-act="cloud-track">+ Track a link</button></div><div id="st-cloud"></div></section>
  </div>`;
}

function renderStudio() {
  if (!$('#st-accounts')) return;
  $('#st-accounts').innerHTML = S.st.accounts.map(accountCard).join('');
  $('#st-usage').innerHTML = usagePanel();
  $('#st-games').innerHTML = S.st.games.map(gameCard).join('');
  $('#st-cloud').innerHTML = cloudInbox();
}

function accountCard(a) {
  const u = S.usage?.accounts?.[a.id];
  const state = !a.loggedIn ? ['error', 'logged out'] : a.limited ? ['limited', `out until ${clock(a.limitedUntil)}`]
    : a.guarded ? ['limited', 'near limit: autopilot paused'] : a.running ? ['running', `${a.running} running`] : ['idle', 'ready'];
  const windows = windowsOf(a);
  const tracked = S.st.cloudArtifacts.filter((c) => c.accountId === a.id).length;
  const line = (label, b) => b ? `<div class="kv"><span>${label}</span><b>${fmtTokens(b.tokens)}</b><span class="hint" style="margin:0">${money(b.cost)} · in ${fmtTokens(b.input)} · out ${fmtTokens(b.output)} · cache ${fmtTokens(b.cacheRead + b.cacheWrite)}</span></div>` : '';
  return `<div class="card acct-card">
    <div class="row">${avatar(a.name, a.id)}<b class="grow">${esc(a.name)}</b><span class="pill ${state[0]}">${esc(state[1])}</span></div>
    <div class="hint" style="margin:2px 0 10px">${esc([a.email, a.plan, a.org].filter(Boolean).join(' · ') || (a.loggedIn ? '' : 'Log in from the sidebar'))}</div>
    ${windows.length ? windows.map((w) => meter(w, { full: true })).join('') : '<div class="hint">No limit data yet.</div>'}
    <div class="row hint" style="margin:6px 0 0">
      <span class="grow">${a.usage?.updatedAt ? `limits checked ${ago(a.usage.updatedAt)}` : 'limits not checked yet'}${a.usage?.overage === 'using' ? ' · using extra usage' : ''}</span>
      <button class="ghost small" data-act="probe" data-id="${a.id}" ${a.probing || !a.loggedIn ? 'disabled' : ''}>${a.probing ? 'Checking…' : 'Refresh'}</button>
    </div>
    <div class="usage-lines">${line('Today', u?.today) || '<div class="hint">No tokens used today.</div>'}${line('7 days', u?.week)}</div>
    <div class="row hint" style="margin:8px 0 0">
      <span class="grow">claude.ai: ${tracked} tracked · ${a.cloudSyncedAt ? `synced ${ago(a.cloudSyncedAt)}` : 'not synced yet'}${a.cloudError ? ` · <span style="color:var(--red)" title="${esc(a.cloudError)}">sync failed</span>` : ''}</span>
      <button class="ghost small" data-act="sync" data-id="${a.id}" ${a.syncing || !a.loggedIn ? 'disabled' : ''}>${a.syncing ? 'Syncing…' : 'Sync'}</button>
    </div>
  </div>`;
}

function usagePanel() {
  const u = S.usage;
  if (!u) return '<p class="hint">Loading…</p>';
  const max = Math.max(1, ...u.series.map((d) => d.total));
  const W = 100 / u.series.length;
  const bars = u.series.map((d, i) => {
    let y = 100;
    const segs = Object.entries(d.byAccount).map(([acc, tokens]) => {
      const h = (tokens / max) * 92;
      y -= h;
      return `<rect x="${i * W + W * 0.18}" y="${y}" width="${W * 0.64}" height="${h}" fill="${colorFor(acc)}"><title>${esc(acctOf(acc)?.name || 'removed account')} · ${d.day}: ${fmtTokens(tokens)} tokens</title></rect>`;
    }).join('');
    return segs;
  }).join('');
  const labels = u.series.map((d, i) => (i % 2 === u.series.length % 2 ? '' : `<span style="left:${i * W + W / 2}%">${d.day.slice(5)}</span>`)).join('');
  const legend = Object.keys(u.accounts).map((id) => `<span><i style="background:${colorFor(id)}"></i>${esc(acctOf(id)?.name || 'removed')}</span>`).join('');
  const gameRows = Object.entries(u.games).sort((a, b) => b[1].week.tokens - a[1].week.tokens).map(([id, b]) => {
    const name = id === '_none' ? 'Housekeeping (syncs, limit checks)' : S.st.games.find((g) => g.id === id)?.name || 'removed game';
    return `<tr><td>${esc(name)}</td><td>${fmtTokens(b.today.tokens)}</td><td>${money(b.today.cost)}</td><td>${fmtTokens(b.week.tokens)}</td><td>${money(b.week.cost)}</td><td>${b.week.runs}</td></tr>`;
  }).join('');
  return `<div class="chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${bars}</svg><div class="xlabels">${labels}</div></div>
    <div class="legend">${legend || '<span class="hint">No usage recorded yet.</span>'}<span class="hint" style="margin-left:auto">peak day ${fmtTokens(max)} tokens</span></div>
    ${gameRows ? `<table class="tbl"><thead><tr><th>Game</th><th>Today</th><th></th><th>7 days</th><th></th><th>Runs</th></tr></thead><tbody>${gameRows}</tbody></table>` : ''}`;
}

function gameCard(g) {
  const agents = agentsOf(g.id);
  const tasks = tasksOf(g.id);
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const doneToday = tasks.filter((t) => t.status === 'done' && (t.doneAt || 0) >= dayStart).length;
  const last = S.st.builds.filter((b) => b.gameId === g.id).at(-1);
  const next = nextCheckin(g.build.checkins);
  const t = S.usage?.games?.[g.id]?.today;
  const reviews = S.st.cloudArtifacts.filter((c) => c.gameId === g.id);
  return `<div class="card game-card${g.status === 'paused' ? ' paused' : ''}">
    <div class="row"><b class="grow link" data-act="game" data-id="${g.id}">${esc(g.name)}</b>
      ${g.status === 'paused' ? '<span class="pill limited">paused</span>' : ''}
      <span class="pill">${PRIORITY[g.priority ?? 2]}</span></div>
    <div class="row" style="margin:8px 0">${agents.map((a) => `<span class="dot ${a.status}" title="${esc(a.name)}: ${a.status}"></span>`).join('') || '<span class="hint" style="margin:0">no agents</span>'}
      <span class="hint" style="margin:0 0 0 6px">${agents.filter((a) => a.status === 'running').length}/${agents.length} running</span></div>
    <div class="stats">
      <div><b>${tasks.filter((t) => t.status === 'open').length}</b><span>open</span></div>
      <div><b>${tasks.filter((t) => t.status === 'claimed').length}</b><span>in progress</span></div>
      <div><b>${doneToday}</b><span>done today</span></div>
      <div><b>${tasks.filter((t) => t.status === 'blocked').length}</b><span>blocked</span></div>
    </div>
    <div class="hint">${last ? `Last build <span class="pill ${esc(last.status)}">${esc(last.status)}</span> ${clock(last.startedAt)}` : 'No builds yet'}${next ? ` · next check-in ${next}` : ''}</div>
    <div class="hint">${t ? `${fmtTokens(t.tokens)} tokens · ${money(t.cost)} today` : 'No tokens today'}${reviews.length ? ` · ${reviews.length} claude.ai artifact${reviews.length > 1 ? 's' : ''}` : ''}</div>
    <div class="row" style="margin-top:10px">
      <button class="btn small" data-act="game" data-id="${g.id}">Open</button>
      <button class="ghost small" data-act="game-status" data-id="${g.id}" data-status="${g.status === 'paused' ? 'active' : 'paused'}">${g.status === 'paused' ? 'Resume' : 'Pause'}</button>
      <select class="mini" data-act-change="game-priority" data-id="${g.id}" title="Which game gets account time first when accounts are busy">
        ${[3, 2, 1].map((p) => `<option value="${p}"${(g.priority ?? 2) === p ? ' selected' : ''}>${PRIORITY[p]} priority</option>`).join('')}
      </select>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// claude.ai artifacts

const ROLE_INFO = {
  review: 'Director review: page changes and comments become notes for the team',
  reference: 'Reference: agents read it on demand; comments still reach the team',
  output: 'Made by an agent: comments reach the team',
};

function cloudInbox() {
  const tracked = S.st.cloudArtifacts;
  const trackedUrls = new Set(tracked.map((c) => c.url));
  const discovered = [];
  for (const [accountId, idx] of Object.entries(S.st.cloudIndex || {})) {
    for (const item of idx.items || []) {
      if (!trackedUrls.has(item.url) && !discovered.some((d) => d.url === item.url)) discovered.push({ ...item, accountId });
    }
  }
  const trackedRows = tracked.map((c) => {
    const g = S.st.games.find((x) => x.id === c.gameId);
    const open = (c.threads || []).filter((t) => !t.resolved).length;
    return `<tr><td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a></td><td>${g ? `<span class="link" data-act="game" data-id="${g.id}">${esc(g.name)}</span>` : '<span class="hint" style="margin:0">no game</span>'}</td>
      <td><span class="pill" title="${esc(ROLE_INFO[c.role])}">${c.role}</span></td><td>${esc(acctOf(c.accountId)?.name || '?')}</td>
      <td>${esc(c.updated || '?')}</td><td>${c.lastReadAt ? ago(c.lastReadAt) : 'pending'}</td><td>${open || ''}</td>
      <td><button class="ghost small" data-act="cloud-edit" data-id="${c.id}">Edit</button></td></tr>`;
  }).join('');
  const discoveredRows = discovered.slice(0, 60).map((d) => `<tr><td><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a></td><td>${esc(acctOf(d.accountId)?.name || '?')}${d.owner === 'shared' ? ' (shared)' : ''}</td><td>${esc(d.updated || '')}</td>
    <td><button class="btn small" data-act="cloud-track" data-url="${esc(d.url)}" data-account="${d.accountId}">Track</button></td></tr>`).join('');
  return `${trackedRows ? `<table class="tbl"><thead><tr><th>Tracked</th><th>Game</th><th>Role</th><th>Account</th><th>Updated</th><th>Read</th><th>Open threads</th><th></th></tr></thead><tbody>${trackedRows}</tbody></table>` : '<p class="hint">Nothing tracked yet. Track a design doc, a review page or a tracker and link it to a game: Ballast re-reads it and its comments on every sync and hands changes to that game\'s agents.</p>'}
    ${discoveredRows ? `<details style="margin-top:12px" ${tracked.length ? '' : 'open'}><summary class="hint" style="display:inline;cursor:pointer">Found on your accounts (${discovered.length})</summary>
      <table class="tbl"><thead><tr><th>Artifact</th><th>Account</th><th>Updated</th><th></th></tr></thead><tbody>${discoveredRows}</tbody></table></details>` : ''}`;
}

function renderCloudArtifacts() {
  const el = $('#cloud-arts');
  if (!el) return;
  const list = S.st.cloudArtifacts.filter((c) => c.gameId === S.gameId);
  if (!list.length) {
    el.innerHTML = '<p class="hint">Link design docs, director review pages and trackers from claude.ai. Ballast keeps them in sync, and comments and review changes reach this game\'s agents as notes.</p>';
    return;
  }
  el.innerHTML = list.map((c) => {
    const open = (c.threads || []).filter((t) => !t.resolved);
    return `<div class="card cloud-card">
      <div class="row"><span class="pill" title="${esc(ROLE_INFO[c.role])}">${c.role}</span><b class="grow">${esc(c.title)}</b>
        <a class="btn small" href="${esc(c.url)}" target="_blank" rel="noopener">Open on claude.ai</a>
        ${c.mirrored ? `<button class="ghost small" data-act="cloud-copy" data-id="${c.id}" title="Ballast's last copy of the page">Last copy</button>` : ''}
        <button class="ghost small" data-act="cloud-read" data-id="${c.id}">Read now</button>
        <button class="ghost small" data-act="cloud-edit" data-id="${c.id}">Edit</button></div>
      <div class="hint">updated ${esc(c.updated || '?')} · ${c.lastReadAt ? `read ${ago(c.lastReadAt)}` : 'waiting for first read'}${c.changedAt ? ` · last change seen ${ago(c.changedAt)}` : ''} · via ${esc(acctOf(c.accountId)?.name || '?')}</div>
      ${c.summary ? clamp(c.summary, md(c.summary)) : ''}
      ${c.dataSummary ? `<details><summary class="hint" style="display:inline;cursor:pointer">Live data</summary><div class="md">${md(c.dataSummary)}</div></details>` : ''}
      ${open.length ? `<div class="threads">${open.map((t) => `<div class="thread">${t.messages.map((m) => `<div><b>${esc(m.author || '?')}</b> ${esc(m.text)}${m.at ? ` <span class="hint" style="display:inline">${esc(m.at)}</span>` : ''}</div>`).join('')}</div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

function trackModal({ url = '', accountId = '', gameId = S.view === 'game' ? S.gameId : '' } = {}) {
  const loggedIn = S.st.accounts.filter((a) => a.loggedIn);
  modal({
    title: 'Track a claude.ai artifact',
    body: `<label class="field"><span>Link</span><input name="url" value="${esc(url)}" placeholder="https://claude.ai/artifact/…"></label>
      <label class="field"><span>Game</span><select name="gameId"><option value="">No game yet</option>${S.st.games.map((g) => `<option value="${g.id}"${g.id === gameId ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Role</span><select name="role">${Object.entries(ROLE_INFO).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>Read it with</span><select name="accountId">${loggedIn.map((a) => `<option value="${a.id}"${a.id === accountId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select><small>An account that owns the artifact or was shared on it.</small></label>`,
    actions: [{ label: 'Cancel' }, { label: 'Track', kind: 'primary', onClick: async (root) => { await api('POST', '/api/cloud', formData(root)); toast('Tracking. First read starts now.'); } }],
  });
}

function editCloudModal(id) {
  const c = S.st.cloudArtifacts.find((x) => x.id === id);
  modal({
    title: c.title,
    body: `<p class="hint" style="margin-top:0"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></p>
      <label class="field"><span>Game</span><select name="gameId"><option value="">No game</option>${S.st.games.map((g) => `<option value="${g.id}"${g.id === c.gameId ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Role</span><select name="role">${Object.entries(ROLE_INFO).map(([k, v]) => `<option value="${k}"${k === c.role ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>Read it with</span><select name="accountId">${S.st.accounts.map((a) => `<option value="${a.id}"${a.id === c.accountId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`,
    actions: [
      { label: 'Stop tracking', kind: 'danger', onClick: () => api('DELETE', `/api/cloud/${id}`) },
      { label: 'Save', kind: 'primary', onClick: (root) => api('PATCH', `/api/cloud/${id}`, formData(root)) },
    ],
  });
}

async function sessionsModal() {
  const a = agentOf(S.agentId);
  const list = await api('GET', `/api/agents/${a.id}/sessions`);
  modal({
    title: `Existing sessions for ${a.name}`,
    wide: list.length > 6,
    body: list.length
      ? `<p class="hint" style="margin-top:0">Claude Code sessions ${esc(acctOf(a.accountId)?.name || '')} already has in this repo. Adopting one continues it as a fork, so the agent keeps that conversation's context and the original stays as it was.</p>
        <table class="tbl"><thead><tr><th>Session</th><th>Last active</th><th>Size</th><th></th></tr></thead><tbody>${list.map((s) => `<tr>
          <td>${esc(s.title)}<div class="hint" style="margin:0">${esc(s.sessionId)}</div></td><td>${clock(s.updatedAt)}</td><td>${fmtTokens(s.size)}B</td>
          <td>${s.current ? '<span class="pill running">current</span>' : `<button class="btn small" data-adopt="${esc(s.sessionId)}" data-dir="${esc(s.dir)}">Adopt</button>`}</td></tr>`).join('')}</tbody></table>`
      : `<p>No earlier Claude Code sessions for this account in ${esc(game().repoPath)}.</p>`,
    onMount: (root, close) => {
      root.querySelectorAll('[data-adopt]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api('POST', `/api/agents/${a.id}/adopt`, { sessionId: btn.dataset.adopt, dir: btn.dataset.dir });
            close();
            toast('Adopted. The next message continues that conversation.');
            loadTranscript();
          } catch (err) { fail(err); }
        };
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Settings (game)

function settingsForm(g) {
  const agents = agentsOf(g.id);
  const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `<form class="settings" id="game-settings">
    <h3>Game</h3>
    <div class="two">
      <label class="field"><span>Name</span><input name="name" value="${esc(g.name)}"></label>
      <label class="field"><span>Lead agent</span><select name="leadAgentId">${agents.map((a) => opt(a.id, g.leadAgentId, a.name)).join('') || '<option value="">(no agents)</option>'}</select><small>Triages director notes into board tasks when idle.</small></label>
    </div>
    <div class="two">
      <label class="field"><span>Status</span><select name="status">${opt('active', g.status || 'active', 'Active')}${opt('paused', g.status, 'Paused (agents stop picking up work)')}</select></label>
      <label class="field"><span>Priority</span><select name="priority">${[3, 2, 1].map((p) => opt(String(p), String(g.priority ?? 2), `${PRIORITY[p][0].toUpperCase()}${PRIORITY[p].slice(1)}`)).join('')}</select><small>Which game gets account time first when accounts are busy.</small></label>
    </div>
    ${g.briefSuggestion ? `<div class="card suggestion"><b>Suggested brief</b> <span class="hint" style="display:inline">from the project survey</span><div class="md" style="margin:8px 0">${md(g.briefSuggestion)}</div>
      <button type="button" class="primary small" data-act="brief-accept">Use this brief</button> <button type="button" class="ghost small" data-act="brief-dismiss">Dismiss</button></div>` : ''}
    <label class="field"><span>Game brief</span><textarea name="brief" rows="7" placeholder="Pillars, target platform, art direction, scope, what fun looks like…">${esc(g.brief)}</textarea><small>Every agent reads this. Changes reach running sessions with their next message.</small></label>
    <label class="check"><input type="checkbox" name="autopilot" ${g.autopilot ? 'checked' : ''}><span><b>Autopilot</b><br><span class="hint" style="margin:0">Idle agents keep claiming open board tasks on their own (up to ${S.st.settings.autopilotDailyTurns} automatic turns a day).</span></span></label>

    ${g.runner === 'cloud' ? `<h3>Cloud</h3>
    <p class="hint">Agents run as Claude Code cloud sessions on <a href="https://github.com/${esc(g.github)}" target="_blank" rel="noopener">github.com/${esc(g.github)}</a>, one task per session, and open pull requests into <code>${esc(g.baseBranch)}</code>. Ballast splits your notes into tasks itself and learns each outcome from the report file the agent pushes. Model and permissions for cloud sessions are set on claude.ai/code. Ballast's clone (for reports and builds): ${esc(g.repoPath)}</p>` : ''}
    <div ${g.runner === 'cloud' ? 'hidden' : ''}>
    <h3>Agents</h3>
    <div class="two">
      <label class="field"><span>Permission mode</span><select name="permissionMode">
        ${opt(g.permissionMode, g.permissionMode)}${['bypassPermissions', 'auto', 'acceptEdits', 'dontAsk'].filter((m) => m !== g.permissionMode).map((m) => opt(m, '')).join('')}
      </select><small>bypassPermissions is fully autonomous: agents run any command without asking.</small></label>
      <label class="field"><span>Model</span><input name="model" value="${esc(g.model)}" list="models" placeholder="Account default"><datalist id="models"><option value="fable"><option value="opus"><option value="sonnet"><option value="haiku"></datalist></label>
    </div>
    <div class="two">
      <label class="field"><span>Effort</span><select name="effort">${opt('', g.effort, 'Default')}${['low', 'medium', 'high', 'xhigh', 'max'].map((e) => opt(e, g.effort)).join('')}</select></label>
      <label class="field"><span>Repo</span><input value="${esc(g.repoPath)}" disabled><small>${g.isolation === 'worktree' ? `Worktrees in ${esc(g.repoPath)}.ballast · shared line ${esc(g.integrationBranch)}` : 'Shared working tree'}</small></label>
    </div>
    </div>

    <h3>Builds &amp; check-ins</h3>
    <label class="field"><span>Build command</span><textarea name="command" rows="3" placeholder='e.g. "C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.40f1\\Editor\\Unity.exe" -batchmode -quit -projectPath . -executeMethod Builds.Quest -logFile -'>${esc(g.build.command)}</textarea>
      <small>Runs in ${g.runner === 'cloud' ? `Ballast's clone, at the latest ${esc(g.baseBranch)} from GitHub (merged pull requests)` : g.isolation === 'worktree' ? `a build worktree checked out at ${esc(g.integrationBranch)}` : 'the repo'}. Env: BALLAST_OUTPUT_DIR, BALLAST_BUILD_ID, BALLAST_COMMIT.</small></label>
    <div class="two">
      <label class="field"><span>Check-in times (daily)</span><input name="checkins" value="${esc(g.build.checkins.join(', '))}" placeholder="09:00, 13:00, 17:30"></label>
      <label class="field"><span>Build output to collect</span><input name="outputPath" value="${esc(g.build.outputPath)}" placeholder="Builds/Quest (relative to the repo)"><small>Or write straight into BALLAST_OUTPUT_DIR.</small></label>
    </div>
    <div class="two">
      <label class="field"><span>Share folder</span><input name="shareDir" value="${esc(g.build.shareDir)}" placeholder="e.g. a Google Drive / OneDrive / network folder"><small>Successful builds are copied here.</small></label>
      <label class="field"><span>Webhook (Slack or Discord)</span><input name="webhookUrl" value="${esc(g.build.webhookUrl)}" placeholder="https://hooks.slack.com/…"><small>Gets the check-in summary.</small></label>
    </div>
    <div class="two">
      <label class="field"><span>Build timeout (minutes)</span><input name="timeoutMin" type="number" min="1" value="${g.build.timeoutMin}"></label>
      <label class="check" style="margin-top:22px"><input type="checkbox" name="agentReport" ${g.build.agentReport ? 'checked' : ''}><span>Ask the lead agent for a written check-in report</span></label>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="primary">Save</button>
      <button type="button" class="ghost" data-act="survey" title="The lead agent reads the repo, suggests a brief and fills the board">Survey project</button><span style="flex:1"></span>
      <button type="button" class="danger" data-act="game-remove">Remove game from Ballast</button>
    </div>
  </form>`;
}

function bindSettings(g) {
  $('#game-settings').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    try {
      await api('PATCH', `/api/games/${g.id}`, {
        name: f.name, leadAgentId: f.leadAgentId || null, brief: f.brief, autopilot: f.autopilot, status: f.status, priority: Number(f.priority),
        permissionMode: f.permissionMode, model: f.model, effort: f.effort,
        build: { command: f.command, checkins: f.checkins, outputPath: f.outputPath, shareDir: f.shareDir, webhookUrl: f.webhookUrl, timeoutMin: f.timeoutMin, agentReport: f.agentReport },
      });
      toast('Saved');
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Flows: accounts, games, agents, global settings

function newAccountModal() {
  const hasDefault = S.st.accounts.some((a) => a.isDefault);
  modal({
    title: 'Add a Claude account',
    body: `<label class="field"><span>Name</span><input name="name" placeholder="e.g. Studio Max, Personal Pro"></label>
      ${hasDefault ? '' : `<label class="check"><input type="checkbox" name="useDefault"><span>Use the Claude login already on this computer<br><span class="hint" style="margin:0">Otherwise Ballast makes a separate profile and opens a terminal to log in.</span></span></label>`}
      <p class="hint">Each account keeps its own login and usage limits in its own Claude config folder.</p>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Add', kind: 'primary', onClick: async (root) => {
        const f = formData(root);
        const acct = await api('POST', '/api/accounts', f);
        if (!acct.loggedIn) await loginFlow(acct.id);
      },
    }],
  });
}

async function loginFlow(id) {
  const res = await api('POST', `/api/accounts/${id}/login`);
  if (res.opened) toast('A terminal opened. Finish the login there; Ballast picks it up on its own.');
  else {
    modal({
      title: 'Log in from a terminal',
      body: `<p>Run this in a terminal, finish the login, then press ⟳ on the account:</p><div class="cmd">${esc(res.command)}</div>`,
      actions: [{ label: 'Done' }],
    });
  }
}

function editAccountModal(id) {
  const a = acctOf(id);
  modal({
    title: `Account: ${a.name}`,
    body: `<label class="field"><span>Name</span><input name="name" value="${esc(a.name)}"></label>
      <label class="field"><span>Parallel turns on this account</span><input name="maxConcurrent" type="number" min="1" value="${a.maxConcurrent || S.st.settings.maxConcurrentPerAccount}"><small>How many of this account's agents may run at the same time.</small></label>
      <p class="hint">${a.loggedIn ? `${esc(a.email || '')} · ${esc(a.plan || '')}${a.org ? ` · ${esc(a.org)}` : ''}` : 'Not logged in'}<br>Config folder: ${esc(a.configDir)}</p>
      ${a.limited ? `<label class="check"><input type="checkbox" name="clearLimit"><span>Clear the usage-limit pause now</span></label>` : ''}`,
    actions: [
      { label: 'Remove', kind: 'danger', onClick: () => api('DELETE', `/api/accounts/${id}`) },
      { label: 'Log in again', onClick: () => loginFlow(id) },
      { label: 'Save', kind: 'primary', onClick: (root) => api('PATCH', `/api/accounts/${id}`, formData(root)) },
    ],
  });
}

function newGameModal() {
  modal({
    title: 'New game',
    body: `<label class="field"><span>Name</span><input name="name" placeholder="e.g. Dark Territory"></label>
      <label class="field"><span>Where agents run</span><select name="runner" id="ng-runner">
        <option value="local">This PC (local repo)</option>
        <option value="cloud">Claude cloud, on a GitHub repo</option>
      </select></label>
      <div data-runner="local">
        <label class="field"><span>Repo folder</span><input name="repoPath" placeholder="C:\\Dev\\my-game"><small>An existing git repo, or a new or empty folder (Ballast creates the repo).</small></label>
        <label class="field"><span>How agents share the code</span><select name="isolation">
          <option value="worktree">Own git worktree per agent (recommended)</option>
          <option value="shared">Shared working tree</option>
        </select><small>Worktrees stop agents from stepping on each other; finished work lands on ballast/integration. Unity: each worktree imports its own Library the first time.</small></label>
      </div>
      <div data-runner="cloud" hidden>
        <div class="two">
          <label class="field"><span>GitHub repo</span><input name="github" placeholder="owner/name or https://github.com/owner/name"></label>
          <label class="field"><span>Base branch</span><input name="baseBranch" placeholder="Repo default"></label>
        </div>
        <p class="hint">Each agent works in a Claude Code cloud session on its own branch and opens a pull request. Every account needs GitHub connected on claude.ai/code (run <code>/web-setup</code> once in Claude Code, or install the Claude GitHub app). Ballast clones the repo here only to watch for reports and run builds.</p>
      </div>
      <label class="field"><span>Agents</span>${S.st.accounts.map((a) => `<label class="check" style="margin-bottom:6px"><input type="checkbox" name="acc:${a.id}" ${a.loggedIn ? 'checked' : ''}><span>${esc(a.name)} <span class="hint" style="display:inline">${esc(a.email || (a.loggedIn ? '' : 'not logged in'))}</span></span></label>`).join('')}</label>
      <label class="field"><span>Game brief (optional)</span><textarea name="brief" rows="4" placeholder="Genre, pillars, platform, art direction…"></textarea></label>
      <label class="check"><input type="checkbox" name="survey" checked><span>If the repo already has work in it, have the lead agent survey it first<br><span class="hint" style="margin:0">Reads the code and history, suggests a brief and fills the board. Use Sessions on an agent to continue Claude conversations you already had in this repo.</span></span></label>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Create', kind: 'primary', onClick: async (root) => {
        const f = formData(root);
        const accountIds = Object.keys(f).filter((k) => k.startsWith('acc:') && f[k]).map((k) => k.slice(4));
        const g = await api('POST', '/api/games', {
          name: f.name, runner: f.runner, repoPath: f.repoPath, isolation: f.isolation, github: f.github, baseBranch: f.baseBranch,
          brief: f.brief, survey: f.survey, accountIds,
        });
        S.st = await api('GET', '/api/state');
        selectGame(g.id);
      },
    }],
    onMount: (root) => {
      $('#ng-runner', root).onchange = (e) => {
        for (const el of $$('[data-runner]', root)) el.hidden = el.dataset.runner !== e.target.value;
      };
    },
  });
}

const ROLES = ['gameplay', 'art & tech art', 'UI / UX', 'audio', 'level design', 'QA & polish', 'build & tools', 'generalist'];
const rolesList = `<datalist id="roles">${ROLES.map((r) => `<option value="${r}">`).join('')}</datalist>`;

function addAgentModal() {
  modal({
    title: 'Add agent',
    body: `<label class="field"><span>Account</span><select name="accountId">${S.st.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}${a.loggedIn ? '' : ' (not logged in)'}</option>`).join('')}</select></label>
      <label class="field"><span>Name (optional)</span><input name="name" placeholder="Defaults to the account name"></label>
      <label class="field"><span>Role (optional)</span><input name="role" list="roles" placeholder="e.g. gameplay">${rolesList}<small>Agents prefer tasks that fit their role but take anything open.</small></label>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Add', kind: 'primary', onClick: async (root) => {
        const a = await api('POST', `/api/games/${S.gameId}/agents`, formData(root));
        S.agentId = a.id;
        if (S.tab === 'agents') { S.st = await api('GET', '/api/state'); renderAgentList(); buildAgentPane(); }
      },
    }],
  });
}

function editAgentModal() {
  const a = agentOf(S.agentId);
  modal({
    title: `Agent: ${a.name}`,
    body: `<label class="field"><span>Name</span><input name="name" value="${esc(a.name)}"></label>
      <label class="field"><span>Role</span><input name="role" list="roles" value="${esc(a.role)}">${rolesList}</label>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (root) => api('PATCH', `/api/agents/${a.id}`, formData(root)) }],
  });
}

function editTaskModal(id) {
  const t = S.st.tasks.find((x) => x.id === id);
  modal({
    title: `Task #${t.num}`,
    body: `<label class="field"><span>Title</span><input name="title" value="${esc(t.title)}"></label>
      <label class="field"><span>Detail</span><textarea name="detail" rows="6">${esc(t.detail)}</textarea></label>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (root) => api('PATCH', `/api/tasks/${id}`, formData(root)) }],
  });
}

function globalSettingsModal() {
  const s = S.st.settings;
  modal({
    title: 'Ballast settings',
    body: `<label class="field"><span>Your name in notes</span><input name="directorName" value="${esc(s.directorName)}"></label>
      <label class="field"><span>Claude CLI</span><input name="claudePath" value="${esc(s.claudePath)}" placeholder="${esc(S.st.claudePath)}"><small>Leave empty to auto-detect. Using: ${esc(S.st.claudePath)}</small></label>
      <div class="two">
        <label class="field"><span>Parallel turns per account</span><input name="maxConcurrentPerAccount" type="number" min="1" value="${s.maxConcurrentPerAccount}"></label>
        <label class="field"><span>Autopilot turns per game per day</span><input name="autopilotDailyTurns" type="number" min="1" value="${s.autopilotDailyTurns}"></label>
      </div>
      <h4 class="sub-h">Limits</h4>
      <div class="two">
        <label class="field"><span>Re-check idle accounts every (min)</span><input name="limitRefreshMin" type="number" min="0" value="${s.limitRefreshMin}"><small>A one-word run on a small model; 0 turns it off. Busy accounts update with every turn.</small></label>
        <label class="field"><span>Autopilot stops above (%)</span><input name="limitGuardPct" type="number" min="1" max="100" value="${s.limitGuardPct}"><small>Of the session or weekly limit. Your own messages still go through.</small></label>
      </div>
      <h4 class="sub-h">claude.ai artifacts</h4>
      <div class="two">
        <label class="field"><span>Sync every (min)</span><input name="cloudSyncMin" type="number" min="0" value="${s.cloudSyncMin}"><small>0 = only when you press Sync. Accounts with nothing tracked sync hourly.</small></label>
        <label class="field"><span>Re-read pages edited today every (min)</span><input name="contentRefreshMin" type="number" min="0" value="${s.contentRefreshMin}"></label>
      </div>
      <div class="two">
        <label class="field"><span>Sync model</span><input name="syncModel" value="${esc(s.syncModel)}" list="models"><datalist id="models"><option value="haiku"><option value="sonnet"></datalist></label>
        <label class="field"><span>Reviewers</span><input name="reviewers" value="${esc(s.reviewers)}" placeholder="Everyone"><small>Comma-separated names or emails. When set, only their comments become notes for agents.</small></label>
      </div>
      <label class="check"><input type="checkbox" name="desktopArtifacts" ${s.desktopArtifacts !== false ? 'checked' : ''}><span>Let sync runs use Claude Code's Artifact tools<br><span class="hint" style="margin:0">Claude Code only loads them when it thinks the desktop app launched it, so Ballast sets that flag for sync runs only. Unofficial: a Claude Code update could change it.</span></span></label>
      <h4 class="sub-h">Cloud games</h4>
      <div class="two">
        <label class="field"><span>Triage model</span><input name="triageModel" value="${esc(s.triageModel)}" list="models"><small>Splits notes into tasks for cloud-run games.</small></label>
        <label class="field"><span>Mark a session blocked after (min)</span><input name="cloudTaskTimeoutMin" type="number" min="10" value="${s.cloudTaskTimeoutMin}"><small>If it hasn't pushed its report by then.</small></label>
      </div>
      <p class="hint">Data folder: <a href="#" data-act="open-folder" data-path="${esc(S.st.home)}">${esc(S.st.home)}</a></p>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (root) => api('PATCH', '/api/settings', formData(root)) }],
  });
}

// ---------------------------------------------------------------------------
// Navigation + actions

function selectStudio() {
  S.view = 'studio';
  store('view', 'studio');
  renderLive();
}

function selectGame(id) {
  S.view = 'game';
  store('view', 'game');
  S.gameId = id;
  store('gameId', id);
  S.unread[id] = 0;
  S.agentId = null;
  renderLive();
}

function openTab(tab) {
  S.tab = tab;
  store('tab', tab);
  renderLive();
}

const ACTIONS = {
  'studio': selectStudio,
  'game': (d) => selectGame(d.id),
  'probe': async (d) => { await api('POST', `/api/accounts/${d.id}/probe`); },
  'sync': async (d) => { await api('POST', `/api/accounts/${d.id}/sync`); toast('Reading claude.ai artifacts…'); },
  'probe-all': async () => {
    const ids = S.st.accounts.filter((a) => a.loggedIn).map((a) => a.id);
    for (const id of ids) await api('POST', `/api/accounts/${id}/probe`);
    toast(`Checking limits on ${ids.length} account${ids.length === 1 ? '' : 's'}…`);
  },
  'sync-all': async () => {
    const ids = S.st.accounts.filter((a) => a.loggedIn).map((a) => a.id);
    for (const id of ids) await api('POST', `/api/accounts/${id}/sync`);
    toast(`Syncing claude.ai on ${ids.length} account${ids.length === 1 ? '' : 's'}…`);
  },
  'game-status': (d) => api('PATCH', `/api/games/${d.id}`, { status: d.status }),
  'cloud-track': (d) => trackModal({ url: d.url || '', accountId: d.account || '' }),
  'cloud-edit': (d) => editCloudModal(d.id),
  'cloud-read': async (d) => {
    const c = S.st.cloudArtifacts.find((x) => x.id === d.id);
    await api('POST', `/api/accounts/${c.accountId}/sync`);
    toast(`Reading "${c.title}" now…`);
  },
  'cloud-copy': (d) => {
    const c = S.st.cloudArtifacts.find((x) => x.id === d.id);
    modal({ title: `${c.title} (Ballast's last copy)`, wide: true, body: `<iframe class="viewer" src="${fileUrl('cloud', c.id, 'page.html')}" sandbox="allow-scripts"></iframe>` });
  },
  'agent-sessions': sessionsModal,
  'survey': async () => { await api('POST', `/api/games/${S.gameId}/survey`); toast('Survey queued for the lead agent.'); },
  'brief-accept': async () => { await api('PATCH', `/api/games/${S.gameId}`, { acceptBriefSuggestion: true }); S.shellKey = ''; renderLive(); },
  'brief-dismiss': async () => { await api('PATCH', `/api/games/${S.gameId}`, { dismissBriefSuggestion: true }); S.shellKey = ''; renderLive(); },
  'tab': (d) => openTab(d.tab),
  'new-game': () => (S.st.accounts.length ? newGameModal() : toast('Add a Claude account first.', true)),
  'new-account': newAccountModal,
  'acct-login': (d) => loginFlow(d.id),
  'acct-refresh': async (d) => { const a = await api('POST', `/api/accounts/${d.id}/refresh`); toast(a.loggedIn ? `${a.name}: logged in as ${a.email}` : `${a.name}: not logged in`); },
  'acct-edit': (d) => editAccountModal(d.id),
  'wake': async () => { const r = await api('POST', `/api/games/${S.gameId}/wake`); toast(r.woken ? `Woke ${r.woken} agent${r.woken > 1 ? 's' : ''}` : 'Nothing to hand out: no open tasks or no idle agents.'); },
  'open-folder': (d) => api('POST', '/api/open-folder', { path: d.path }),
  'agent-select': (d) => { S.agentId = d.id; renderAgentList(); buildAgentPane(); },
  'agent-add': addAgentModal,
  'agent-edit': editAgentModal,
  'agent-stop': () => api('POST', `/api/agents/${S.agentId}/stop`),
  'agent-reset': async () => { await api('POST', `/api/agents/${S.agentId}/reset`); toast('Next message starts a fresh session.'); },
  'agent-term': async () => {
    const r = await api('POST', `/api/agents/${S.agentId}/terminal`);
    if (r.url) return window.open(r.url, '_blank', 'noopener');
    if (!r.opened) modal({ title: 'Open in a terminal', body: `<div class="cmd">${esc(r.command)}</div>`, actions: [{ label: 'Done' }] });
  },
  'agent-remove': () => {
    const a = agentOf(S.agentId);
    confirmModal(`Remove ${a.name}?`, 'Its claimed task goes back on the board. Its worktree and branch stay on disk.', 'Remove', () => api('DELETE', `/api/agents/${a.id}`));
  },
  'task-status': (d) => api('PATCH', `/api/tasks/${d.id}`, { status: d.status }),
  'task-edit': (d) => editTaskModal(d.id),
  'task-delete': (d) => api('DELETE', `/api/tasks/${d.id}`),
  'build-now': async () => { await api('POST', `/api/games/${S.gameId}/build`); toast('Build started'); },
  'build-cancel': () => api('POST', `/api/games/${S.gameId}/build/cancel`),
  'build-log': (d) => showBuildLog(d.id),
  'art-open': (d) => openArtifact(d.id),
  'game-remove': () => {
    const g = game();
    confirmModal(`Remove ${g.name}?`, 'Stops its agents and forgets its board in Ballast. The repo, worktrees, feed history and builds stay on disk.', 'Remove', async () => {
      await api('DELETE', `/api/games/${g.id}`);
      S.gameId = null;
      selectStudio();
    });
  },
  'more': (_, el) => { el.previousElementSibling.classList.remove('clamp'); el.remove(); },
  'img-zoom': (_, el) => modal({ title: el.alt || 'Image', wide: true, body: `<img class="viewer-img" src="${el.src}">` }),
  'chip-remove': (d) => { S.pending[d.kind].splice(Number(d.i), 1); renderChips(d.kind); },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !ACTIONS[el.dataset.act]) return;
  e.preventDefault();
  try { await ACTIONS[el.dataset.act](el.dataset, el); } catch (err) { fail(err); }
});

document.addEventListener('change', async (e) => {
  try {
    if (e.target.id === 'autopilot') await api('PATCH', `/api/games/${S.gameId}`, { autopilot: e.target.checked });
    if (e.target.dataset.actChange === 'game-priority') await api('PATCH', `/api/games/${e.target.dataset.id}`, { priority: Number(e.target.value) });
  } catch (err) { fail(err); }
});

$('#new-game').onclick = () => ACTIONS['new-game']();
$('#new-account').onclick = newAccountModal;
$('#open-settings').onclick = globalSettingsModal;

setInterval(() => {
  for (const el of $$('[data-since]')) el.textContent = el.dataset.since && el.dataset.since !== 'null' ? dur(Date.now() - Number(el.dataset.since)) : '';
}, 1000);

// ---------------------------------------------------------------------------
// Live updates

// Token totals come from a separate, heavier endpoint, so they refresh at most every few seconds.
let usageTimer = null;
let usageAt = 0;
function loadUsage() {
  if (usageTimer) return;
  usageTimer = setTimeout(async () => {
    usageTimer = null;
    usageAt = Date.now();
    try {
      S.usage = await api('GET', '/api/usage?days=14');
      renderSide();
      renderHead();
      if (S.view === 'studio') renderStudio();
    } catch { /* next state change retries */ }
  }, Math.max(0, 4000 - (Date.now() - usageAt)));
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      S.st = await api('GET', '/api/state');
      if (!game()) {
        S.gameId = S.st.games[0]?.id || null;
        if (S.gameId) store('gameId', S.gameId);
        else if (S.view === 'game') S.view = 'studio';
      }
      renderLive();
      loadUsage();
    } catch (err) { fail(err); } finally { refreshing = null; }
  })();
  return refreshing;
}

function handleEvent(ev) {
  if (ev.type === 'state') return refresh();
  if (ev.type === 'feed') {
    S.feeds[ev.gameId]?.push(ev.entry);
    if (ev.gameId === S.gameId) appendFeed(ev.entry);
    else if (!['system', 'task'].includes(ev.entry.kind)) {
      S.unread[ev.gameId] = (S.unread[ev.gameId] || 0) + 1;
      renderSide();
    }
  }
  if (ev.type === 'tx') {
    S.tx[ev.agentId]?.push(ev.entry);
    if (ev.agentId === S.agentId && S.tab === 'agents') appendTx(ev.entry);
  }
}

function connect() {
  const es = new EventSource('/events');
  es.onopen = async () => {
    $('#conn').classList.add('on');
    await refresh();
    if (S.tab === 'feed' && $('#feed-list')) loadFeed();
    if (S.tab === 'agents' && $('#tx-list')) loadTranscript();
  };
  es.onerror = () => $('#conn').classList.remove('on');
  es.onmessage = (m) => { try { handleEvent(JSON.parse(m.data)); } catch (err) { console.error(err); } };
}

(async function boot() {
  await refresh();
  connect();
})();
