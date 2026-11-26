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
// Delegate chats that reported back are closed; only the Agents tab tree still lists them.
const agentsOf = (gid, { all = false } = {}) => S.st.agents.filter((a) => a.gameId === gid && (all || !a.retired));
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
const mdInline = (s) => esc(s)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(https?:\/\/[^\s<)|]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

function md(src) {
  return String(src ?? '').split('```').map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/^[\w+-]*\n/, ''))}</code></pre>`;
    // Pipe tables (a header row, a |---| row, then rows) become real tables; Claude's answers use them.
    const tables = [];
    part = part.replace(/(^|\n)((?:[ \t]*\|.*\|[ \t]*(?:\n|$)){2,})/g, (m, pre, block) => {
      const rows = block.trim().split('\n');
      if (!/^\s*\|?\s*:?-{2,}/.test(rows[1])) return m;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => mdInline(c.trim()));
      tables.push(`<div class="md-table"><table><thead><tr>${cells(rows[0]).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      return `${pre}\u0000T${tables.length - 1}\u0000\n`;
    });
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,6} (.+)$/gm, '<strong class="h">$1</strong>')
      .replace(/^\s*(?:[-*•]|\d+\.) (.+)$/gm, '<span class="li">$1</span>')
      .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/^\n+|\n+$/g, '')
      .replace(/\n/g, '<br>')
      .replace(/(<\/(?:span|strong)>)<br>/g, '$1')
      .replace(/(?:<br>)?\u0000T(\d+)\u0000(?:<br>)?/g, (_, n) => tables[Number(n)]);
  }).join('');
}
const clamp = (text, html) => (text.length > 1400 || text.split('\n').length > 18)
  ? `<div class="md clamp">${html}</div><button class="more" data-act="more">Show more</button>`
  : `<div class="md">${html}</div>`;

const ICON_MIC = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 17v5"/></svg>';
const ICON_CLIP ='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.1l-9.2 9.2a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 015.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5"/></svg>';

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
  const all = [...S.st.games].sort((a, b) => STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)]);
  const archived = all.filter((g) => statusOf(g) === 'archived');
  // Archived games fold away; the one you have open stays visible.
  const games = all.filter((g) => statusOf(g) !== 'archived' || S.showArchived || (S.view === 'game' && g.id === S.gameId));
  const running = S.st.agents.filter((a) => a.status === 'running').length; // delegate chats included
  const questions = openQuestions().length + openInterventions().length; // questions plus people-only blocks
  $('#games').innerHTML = `<button class="game-link${S.view === 'studio' ? ' active' : ''}" data-act="studio">
      <span class="gname">Studio</span><span class="hint" style="margin:0">${running ? `${running} running` : 'overview'}</span>
    </button>
    <button class="game-link studio-link${S.view === 'inbox' ? ' active' : ''}" data-act="inbox">
      <span class="gname">Director's Inbox</span>${questions ? `<span class="badge">${questions}</span>` : '<span class="hint" style="margin:0">empty</span>'}
    </button>` + (games.length ? games.map((g) => {
    const agents = agentsOf(g.id);
    const unread = S.unread[g.id] || 0;
    const s = statusOf(g);
    return `<button class="game-link${S.view === 'game' && g.id === S.gameId ? ' active' : ''}${s !== 'active' ? ' paused' : ''}" data-act="game" data-id="${g.id}">
      <span class="gname">${esc(g.name)}</span>
      ${unread ? `<span class="badge">${unread}</span>` : ''}
      ${s !== 'active' ? `<span class="hint" style="margin:0">${s === 'shipped' ? '🚀 shipped' : STATUS_LABEL[s]}</span>` : `<span class="dots">${agents.map((a) => `<span class="dot ${a.status}"></span>`).join('')}</span>`}
    </button>`;
  }).join('') : '<p class="hint" style="padding:0 10px">No games yet.</p>')
    + (archived.length ? `<button class="game-link archived-toggle" data-act="toggle-archived"><span class="gname hint" style="margin:0">${S.showArchived ? '▾' : '▸'} Archived (${archived.length})</span></button>` : '');

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
  const sub = a.signedInAs ? `Paused: signed in as ${a.signedInAs}`
    : needsRepair(a) ? 'Signed out: its agents are paused'
    : !a.loggedIn ? 'Not logged in'
    : a.limited ? `Out of usage until ${clock(a.limitedUntil)}`
    : [a.email, a.plan, today?.tokens ? `${fmtTokens(today.tokens)} tokens today` : ''].filter(Boolean).join(' · ') || 'Logged in';
  return `<div class="acct">
    <div class="row">
      <span class="dot ${status}"></span>
      <span class="aname">${esc(a.name)}${a.isDefault ? ' <span class="hint" style="display:inline">(this PC)</span>' : ''}</span>
      ${needsRepair(a) ? `<button class="primary small" data-act="acct-repair" data-id="${a.id}" title="${esc(a.authBroken?.error || 'Signed out')}">Repair sign-in</button>` : !a.loggedIn ? `<button class="primary small" data-act="acct-login" data-id="${a.id}">Log in</button>` : ''}
      <span class="actions">
        <button class="icon-btn" data-act="acct-refresh" data-id="${a.id}" title="Re-check login">⟳</button>
        <button class="icon-btn" data-act="acct-edit" data-id="${a.id}" title="Edit">✎</button>
      </span>
    </div>
    <div class="sub${a.signedInAs || needsRepair(a) ? ' warn-text' : ''}">${esc(sub)}${a.running ? ` · ${a.running} running` : ''}</div>
    ${a.signedInAs ? `<div class="row" style="gap:4px;margin:4px 0 2px"><button class="primary small" data-act="acct-detach" data-id="${a.id}">Give it its own login</button></div>` : ''}
    ${windowsOf(a).slice(0, 2).map((w) => meter(w)).join('')}
  </div>`;
}

// ---------------------------------------------------------------------------
// Header + tabs

const PRIORITY = { 3: 'high', 2: 'normal', 1: 'low' };

// Review policy per discipline: game override, else the studio default.
const policyOf = (g, d) => {
  const mode = g?.review?.[d] || S.st.settings.review?.[d] || 'after';
  return mode === 'gate' && g?.isolation === 'shared' ? 'after' : mode;
};
// An archived game's open items stay out of the Inbox (they come back if it's restored).
const liveGame = (id) => statusOf((S.st.games || []).find((g) => g.id === id) || {}) !== 'archived';
const openQuestions = (gid) => (S.st.inbox || []).filter((q) => q.status === 'open' && (gid ? q.gameId === gid : liveGame(q.gameId)));
const isDept = (tab) => S.st?.disciplines?.some((d) => d.id === tab);

function renderHead() {
  if (S.view === 'setup') {
    $('#ghead').innerHTML = `<div><h1>Setup guide</h1><span class="hint" style="margin:0">Step ${(S.setupStep || 0) + 1} of ${SETUP_STEPS.length} · you can come back to this from Settings any time</span></div>`;
    return;
  }
  if (S.view === 'inbox') {
    const n = openQuestions().length;
    const h = openInterventions().length;
    $('#ghead').innerHTML = `<div><h1>Director's Inbox</h1><span class="hint" style="margin:0">Questions from every agent on every game, and blocked tickets that need a person. Agents never wait on questions: each one is working on the assumption shown, and your answer goes straight back to it.</span></div>
      <span class="spacer"></span>${h ? `<span class="pill error">${h} need${h === 1 ? 's' : ''} you</span>` : ''}<span class="pill ${n ? 'limited' : ''}">${n} question${n === 1 ? '' : 's'}</span>`;
    return;
  }
  if (S.view === 'studio') {
    if (!S.st.accounts.length) { $('#ghead').innerHTML = ''; return; }
    const running = S.st.agents.filter((a) => a.status === 'running').length;
    const delegatesOpen = S.st.agents.filter((a) => a.parentId && !a.retired).length;
    const subs = S.st.agents.reduce((n, a) => n + (a.subagents?.active?.length || 0), 0);
    const t = Object.values(S.usage?.accounts || {}).reduce((sum, a) => sum + a.today.tokens, 0);
    const inDev = S.st.games.filter((g) => ['active', 'paused'].includes(statusOf(g))).length;
    const shipped = S.st.games.filter((g) => statusOf(g) === 'shipped').length;
    $('#ghead').innerHTML = `<div><h1>Studio</h1><span class="hint" style="margin:0">Your games, their output and their audiences · ${inDev} in development${shipped ? ` · ${shipped} shipped` : ''} · ${S.st.agents.filter((a) => !a.parentId).length} agents${delegatesOpen ? ` + ${delegatesOpen} delegate chat${delegatesOpen > 1 ? 's' : ''}` : ''} · ${running} running${subs ? ` (+${subs} subagents)` : ''} · ${fmtTokens(t)} tokens today</span></div>
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
      ? `<a class="pill queued" href="https://github.com/${esc(g.github)}${g.subdir ? `/tree/${esc(g.baseBranch)}/${esc(g.subdir)}` : ''}" target="_blank" rel="noopener" title="Agents run as Claude cloud sessions and open pull requests into ${esc(g.baseBranch)}">cloud · ${esc(g.github)}${g.subdir ? `/${esc(g.subdir)}` : ''}</a>`
      : `<span class="pill" title="${g.isolation === 'worktree' ? `Each agent has its own git worktree; finished work lands on ${esc(g.integrationBranch)}` : 'All agents edit the same folder'}">${g.isolation === 'worktree' ? 'worktrees' : 'shared tree'}</span>`}
    ${g.cloudError ? `<span class="pill error" title="${esc(g.cloudError)}">GitHub unreachable</span>` : ''}
    ${activeFocuses(g).map((f) => `<button class="pill fx-pill" data-act="tab" data-tab="board" title="${esc(f.text || f.title)}">★ ${esc(f.title)}</button>`).join('')}
    ${S.st.accounts.filter((a) => needsRepair(a) && agentsOf(g.id).some((x) => x.accountId === a.id)).map((a) => `<button class="pill error" data-act="acct-repair" data-id="${a.id}" title="${esc(a.authBroken?.error || 'Signed out')}">${esc(a.name)} signed out · Repair sign-in</button>`).join('')}
    ${(() => {
      const unlinked = agents.filter((a) => a.status === 'unlinked').length;
      return unlinked ? `<button class="primary small" data-act="cloud-connect-all" title="Nothing can start until each cloud agent has a session">Connect ${unlinked} cloud session${unlinked > 1 ? 's' : ''}</button>` : '';
    })()}
    ${statusOf(g) !== 'active' ? `<span class="pill ${statusOf(g)}">${STATUS_LABEL[statusOf(g)]}${g.releases?.at(-1)?.version ? ` ${esc(g.releases.at(-1).version)}` : ''}</span>` : ''}
    ${statusOf(g) === 'archived' ? `<button class="primary small" data-act="game-restore" data-id="${g.id}">Restore</button>` : ''}
    ${RS.active && RS.gameId === g.id ? '<button class="pill error" data-act="tab" data-tab="feed" title="Back to the review">● recording review</button>' : ''}
    ${(g.priority ?? 2) !== 2 ? `<span class="pill">${PRIORITY[g.priority]} priority</span>` : ''}
    <span class="spacer"></span>
    ${(() => {
      // The newest build there's something to play in, one click from anywhere in the game.
      const b = [...S.st.builds].reverse().find((x) => x.gameId === g.id && x.playable);
      if (!b) return '';
      const p = b.playable;
      const when = `Build from ${clock(b.startedAt)}${b.commit ? ` @ ${b.commit}` : ''}`;
      return p.web ? `<a class="btn small primary" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(when)}">▶ Play latest</a>`
        : p.exe ? `<button class="primary small" data-act="build-run" data-id="${b.id}" title="${esc(when)}">▶ Play latest</button>`
          : `<button class="primary small" data-act="build-quest" data-id="${b.id}" title="${esc(when)}: install on your Quest">▶ Install latest on Quest</button>`;
    })()}
    <span class="dots" title="${agents.map((a) => `${a.name}: ${a.status}`).join('\n')}">${agents.map((a) => `<span class="dot ${a.status}"></span>`).join('')}</span>
    <label class="switch" title="When on, idle agents keep claiming open board tasks on their own"><input type="checkbox" id="autopilot" ${g.autopilot ? 'checked' : ''}><i></i>Autopilot</label>
    <button class="ghost small" data-act="wake" title="Hand open board tasks to idle agents now">Wake idle</button>${awayPill()}`;
}

function renderTabs() {
  const g = game();
  if (S.view !== 'game' || !g || !S.st.accounts.length) { $('#tabs').innerHTML = ''; return; }
  const agents = agentsOf(g.id);
  const running = agents.filter((a) => a.status === 'running').length;
  const open = tasksOf(g.id).filter((t) => t.status === 'open' || t.status === 'claimed').length;
  const arts = S.st.artifacts.filter((a) => a.gameId === g.id).length + S.st.cloudArtifacts.filter((a) => a.gameId === g.id).length;
  const pendingIn = (d) => tasksOf(g.id).filter((t) => t.discipline === d && t.review?.state === 'pending').length
    + openQuestions(g.id).filter((q) => q.discipline === d).length
    + (S.st.deptNotes || []).filter((n) => n.gameId === g.id && n.discipline === d && n.status === 'new').length;
  const tabs = [
    ['feed', 'Feed', ''],
    ...S.st.disciplines.map((d) => [d.id, d.label, policyOf(g, d.id) === 'skip' ? '' : pendingIn(d.id) || '']),
    ['agents', 'Agents', agents.length ? `${running}/${agents.length}` : ''],
    ['gdd', 'GDD', (g.gdd?.drafts || []).filter((x) => x.status === 'review').length || ''],
    ['roadmap', 'Roadmap', ''],
    ['sections', 'Sections', S.st.roadmaps?.[g.id]?.features?.filter((f) => f.gate >= 0 && f.level >= f.gate).length || ''],
    ['loops', 'Gameplay Loop', ''],
    ['board', 'Board', open || ''],
    ['builds', 'Builds', ''],
    ['perf', 'Performance', ''],
    ['budget', 'Budget', ''],
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
  if (S.view === 'setup') {
    v.innerHTML = setupShell();
    return;
  }
  if (!S.st.accounts.length || (!g && S.view === 'game') || (S.view === 'studio' && !S.st.games.length)) {
    v.innerHTML = onboarding();
    return;
  }
  if (S.view === 'studio') {
    v.innerHTML = studioShell();
    bindComposer('studio');
    return;
  }
  if (S.view === 'inbox') {
    v.innerHTML = '<div class="scroll pad" style="flex:1" id="inbox"></div>';
    return;
  }
  if (isDept(S.tab)) {
    // The note box sits outside the live-rendered parts so typing survives state updates.
    const label = S.st.disciplines.find((d) => d.id === S.tab)?.label || S.tab;
    v.innerHTML = `<div class="scroll pad dept" style="flex:1">
      <div id="dept-top"></div>
      <form class="card dept-note-form" id="dept-note-form">
        <b>Leave a ${esc(label)} note</b>
        <textarea name="text" rows="3" placeholder="Feedback for the whole ${esc(label.toLowerCase())} department: what looks or feels off, what to aim for…"></textarea>
        <div class="row"><span class="hint grow" style="margin:0">The next agent working in ${esc(label)} picks it up and breaks it into tasks. It's archived once they're all done.</span><button class="primary small">Leave note</button></div>
      </form>
      <div id="dept"></div>
    </div>`;
    $('#dept-note-form').onsubmit = async (e) => {
      e.preventDefault();
      const ta = e.target.text;
      if (!ta.value.trim()) return;
      try {
        await api('POST', `/api/games/${S.gameId}/dept-notes`, { discipline: S.tab, text: ta.value });
        ta.value = '';
        toast(`${label} note left`);
      } catch (err) { fail(err); }
    };
    return;
  }
  switch (S.tab) {
    case 'feed':
      v.innerHTML = `<div class="feed scroll" id="feed-list"></div>${composer('feed', `Note to every agent on ${g.name}: gameplay review, art notes, direction…`)}`;
      bindComposer('feed');
      updateTargetSelect();
      loadFeed();
      if (RS.active && RS.gameId === g.id) rsRender(); // a review keeps recording across tab switches
      break;
    case 'agents':
      v.innerHTML = '<div class="split"><div class="agent-list" id="agent-list"></div><div class="agent-pane" id="agent-pane"></div></div>';
      buildAgentPane();
      break;
    case 'roadmap':
      v.innerHTML = '<div class="scroll pad roadmap" style="flex:1" id="roadmap"></div>';
      break;
    case 'gdd':
      v.innerHTML = '<div class="scroll pad" style="flex:1" id="gddtab"></div>';
      delete GDDV.data[g.id];
      delete GDDV.sig[g.id];
      renderGdd();
      break;
    case 'sections':
      v.innerHTML = '<div class="scroll pad" style="flex:1" id="sections"></div>';
      renderSections();
      break;
    case 'loops':
      v.innerHTML = '<div class="scroll pad loops" style="flex:1" id="loops"></div>';
      delete LOOPS.data[g.id]; // fresh each time the tab opens
      renderLoops();
      break;
    case 'board':
      v.innerHTML = `<div class="board-wrap">
        ${gddBar(g)}
        <div id="focus-bar"></div>
        <div id="jungle-bar"></div>
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
    case 'perf':
      v.innerHTML = '<div class="scroll pad perf" style="flex:1" id="perf"></div>';
      delete PERF.data[g.id]; // fresh runs each time the tab opens
      renderPerf();
      break;
    case 'budget':
      v.innerHTML = '<div class="scroll pad perf" style="flex:1" id="budget"></div>';
      delete BUDGET.data[g.id]; // fresh figures each time the tab opens
      renderBudget();
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
const shellKey = () => S.view === 'setup' ? `setup|${S.setupStep || 0}` : S.view === 'studio'
  ? `studio|${S.st.games.map((g) => g.id + g.name + statusOf(g)).join()}|${S.st.accounts.length > 0}|${S.st.accounts.some((a) => a.loggedIn)}`
  : S.view === 'inbox' ? `inbox|${S.st.accounts.length > 0}`
    : `${S.gameId}|${S.tab}|${S.tab === 'settings' ? statusOf(game()) : ''}|${S.st.accounts.length > 0}|${!!game()}|${!game() && S.st.accounts.some((a) => a.loggedIn)}`;

function renderLive() {
  if (shellKey() !== S.shellKey) buildShell();
  renderSide();
  renderHead();
  renderTabs();
  if (S.view === 'setup') return renderSetup();
  if (S.view === 'studio') return renderStudio();
  if (S.view === 'inbox') return renderInbox();
  if (!game()) return;
  if (isDept(S.tab)) return renderDept(S.tab);
  switch (S.tab) {
    case 'feed': updateTargetSelect(); renderAskLine(); break;
    case 'agents': {
      renderAgentList();
      const selected = agentOf(S.agentId);
      const stale = !selected || selected.gameId !== S.gameId || !$('#agent-head');
      if (stale && (agentsOf(S.gameId).length || $('#agent-head'))) buildAgentPane();
      else renderAgentHead();
      break;
    }
    case 'board': renderBoard(); break;
    case 'roadmap': renderRoadmap(); break;
    case 'sections': renderSections(); break;
    case 'gdd': renderGdd(); break;
    case 'builds': renderBuilds(); break;
    case 'artifacts': renderArtifacts(); renderCloudArtifacts(); break;
  }
}

function onboarding() {
  const hasAcct = S.st.accounts.length > 0;
  const loggedIn = S.st.accounts.some((a) => a.loggedIn);
  return `<div class="empty">
    <img src="logo.svg" alt="Ballast" style="width:260px;max-width:80%;margin:0 auto 14px;display:block">
    <p><b>Home base for author developers:</b> solo developers making games entirely with AI. Every Claude account you add becomes an agent. Point a game at a repo, direct it with notes and play-session reviews, and track every game's output, costs and audience in one place.</p>
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
      ${kind === 'feed' ? '<div class="ask-line" id="ask-line"></div>' : ''}
      <div class="chips" id="chips-${kind}"></div>
      <textarea rows="2" placeholder="${esc(placeholder)}" data-placeholder="${esc(placeholder)}"></textarea>
      <div class="bar">
        ${kind === 'feed' ? `<button type="button" class="ghost small ask-toggle" data-act="ask-toggle" title="Conversation mode: ask Claude a question instead of sending a note to the agents">💬 Ask Claude</button>
          <select id="target" title="Who gets this message"></select>
          <button type="button" class="ghost small mic-btn" data-act="review-start" title="Talk while you play: Ballast transcribes and sends your notes to every agent when you're done">${ICON_MIC} Director Review</button>` : ''}
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

const isVideoName = (n) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(n || '');
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

function renderChips(kind) {
  const el = $(`#chips-${kind}`);
  if (!el) return;
  el.innerHTML = S.pending[kind].map((f, i) => `<span class="chip${f.uploading ? ' uploading' : ''}">${f.isImage && !f.uploading ? `<img src="${f.url}">` : ''}${isVideoName(f.name) ? '🎬 ' : ''}${esc(f.name)}${f.uploading ? ` <span class="hint" style="display:inline;margin:0">${f.pct}% of ${fmtSize(f.size)}</span><i class="chip-bar" style="width:${f.pct}%"></i>` : ''}<button type="button" data-act="chip-remove" data-kind="${kind}" data-i="${i}" title="${f.uploading ? 'Cancel upload' : 'Remove'}">✕</button></span>`).join('')
    + (kind === 'feed' && S.pending.feed.some((f) => isVideoName(f.name)) ? '<div class="hint chip-note">🎬 Claude reviews the video (frames plus your commentary) before the note reaches the team; the review notes and key frames go with it.</div>' : '');
}

// Files stream straight to disk (any size, with progress), so playtest videos work like screenshots.
function sendFile(endpoint, file, onProgress) {
  const xhr = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    xhr.open('POST', `${endpoint}?name=${encodeURIComponent(file.name || 'pasted.png')}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.floor((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
      xhr.status < 300 ? resolve(body) : reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: lost the connection to Ballast'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { cancelled: true }));
    xhr.send(file);
  });
  return { done, cancel: () => xhr.abort() };
}

async function upload(kind, files) {
  const g = game();
  for (const file of files) {
    const endpoint = kind === 'studio' ? '/api/studio/upload' : `/api/games/${g.id}/upload`;
    const chip = { name: file.name || 'pasted.png', uploading: true, pct: 0, size: file.size, isImage: file.type.startsWith('image/') };
    S.pending[kind].push(chip);
    renderChips(kind);
    let last = 0;
    const up = sendFile(endpoint, file, (pct) => { chip.pct = pct; if (Date.now() - last > 250) { last = Date.now(); renderChips(kind); } });
    chip.cancel = up.cancel;
    try {
      Object.assign(chip, await up.done, { uploading: false, cancel: null });
    } catch (err) {
      S.pending[kind] = S.pending[kind].filter((x) => x !== chip);
      if (!err.cancelled) fail(err);
    }
    renderChips(kind);
  }
}

function bindComposer(kind) {
  const form = $(`#composer-${kind}`);
  const ta = $('textarea', form);
  const fileInput = $('input[type=file]', form);
  S.pending[kind] = [];
  const grow = () => {
    ta.style.height = 'auto';
    if (ta.value) ta.style.height = `${Math.min(260, ta.scrollHeight)}px`; // empty: back to its two rows
  };
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
    if (attachments.some((f) => f.uploading)) return toast('Wait for the upload to finish (or remove it).', true);
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const files = attachments.map(({ name, path, url }) => ({ name, path, url }));
      if (kind === 'studio') {
        const gameIds = $$('[name=st-game]:checked').map((el) => el.value);
        if (!gameIds.length) throw new Error('Tick at least one game.');
        const r = await api('POST', '/api/studio/notes', { gameIds, text, attachments: files });
        toast(`Sent to ${r.sent} game${r.sent > 1 ? 's' : ''}`);
      } else if (kind === 'feed' && S.askMode) {
        const r = await api('POST', `/api/games/${S.gameId}/ask`, { text, attachments: files });
        S.asking[S.gameId] = r.askId;
        renderAskLine();
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
  const videos = list.filter((a) => isVideoName(a.name));
  list = list.filter((a) => !isVideoName(a.name));
  return `${videos.map((a) => `<div class="video-att"><video controls preload="metadata" src="${esc(a.url)}"></video><a class="hint" href="${esc(a.url)}?download">${esc(a.name)}</a></div>`).join('')}${list.length ? `<div class="thumbs">${list.map((a) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name)
    ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" data-act="img-zoom">`
    : `<a class="file" href="${esc(a.url)}?download">${esc(a.name)}</a>`).join('')}</div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Conversation mode: questions answered by the account with the most weekly room

S.askMode = load('askMode') === '1';
S.asking = {}; // gameId -> askId still being answered

// Mirrors the server's pick: most weekly room, then most session room.
function roomiestAccount() {
  const pct = (a, re) => Math.max(0, ...windowsOf(a).filter((w) => re.test(w.label)).map((w) => (w.utilization || 0) * 100));
  return S.st.accounts.filter((a) => a.loggedIn && !a.limited).map((a) => ({ a, weekly: pct(a, /Weekly/), session: pct(a, /Session/) }))
    .sort((x, y) => x.weekly - y.weekly || x.session - y.session)[0] || null;
}

function renderAskLine() {
  const form = $('#composer-feed');
  const line = $('#ask-line');
  if (!form || !line) return;
  form.classList.toggle('ask-on', !!S.askMode);
  $('.ask-toggle', form)?.classList.toggle('on', !!S.askMode);
  const ta = $('textarea', form);
  ta.placeholder = S.askMode ? 'Ask Claude anything about this game: the design, the code, why something works the way it does…' : ta.dataset.placeholder;
  $('button[type=submit]', form).textContent = S.askMode ? 'Ask' : 'Send';
  if (!S.askMode) { line.innerHTML = ''; return; }
  const r = roomiestAccount();
  const busy = S.asking[S.gameId];
  line.innerHTML = `<span class="grow">💬 <b>Conversation mode</b> · ${busy ? 'answering…' : r ? `answered by <b>${esc(r.a.name)}</b>, ${Math.round(100 - r.weekly)}% of its week left` : 'no account has usage free'} · agents don't see this</span>
    <a href="#" data-act="ask-reset" title="Earlier questions stop being carried into new ones">New conversation</a>`;
}

function liveAnswer(askId, account, text) {
  const el = $('#feed-list');
  if (!el) return;
  let box = $(`#live-${askId}`);
  const stick = nearBottom(el);
  if (!box) {
    el.insertAdjacentHTML('beforeend', `<div class="entry answer live" id="live-${askId}"><div class="head"><span class="avatar" style="background:var(--blue)">C</span><span class="who">${esc(account)}</span><span class="pill queued">answering…</span></div><div class="body"><div class="md"></div></div></div>`);
    box = $(`#live-${askId}`);
  }
  $('.md', box).innerHTML = text ? md(text) : '<span class="hint">Thinking…</span>';
  if (stick) el.scrollTop = el.scrollHeight;
}

function sendAnswerToTeam(askId) {
  const feed = S.feeds[S.gameId] || [];
  const q = feed.find((e) => e.kind === 'ask' && e.askId === askId);
  const a = feed.find((e) => e.kind === 'answer' && e.askId === askId);
  modal({
    title: 'Send to the team',
    wide: true,
    body: `<p class="hint" style="margin-top:0">Edit it down to what the agents should do. It goes out as a note to every agent, like any note from the Feed.</p>
      <textarea name="text" style="width:100%;height:46vh">${esc(`From my conversation with Claude:\n\nQ: ${q?.text || ''}\n\nA: ${a?.text || ''}`)}</textarea>`,
    actions: [{ label: 'Cancel' }, { label: 'Send to all agents', kind: 'primary', onClick: async (root) => {
      await api('POST', `/api/games/${S.gameId}/notes`, { text: $('textarea', root).value, target: 'all', attachments: q?.attachments || [] });
      toast('Sent to every agent');
    } }],
  });
}

// While the director is away: who, until when (set in Settings).
function awayPill() {
  const a = S.st.settings.away;
  if (!a?.from) return '';
  const day = (d) => new Date(`${d}T12:00`);
  const now = new Date();
  if (now < day(a.from).setHours(0, 0, 0, 0) || now > day(a.to).setHours(23, 59, 59, 999)) return '';
  const label = { sick: '🤒 Off sick', vacation: '🏖 On vacation', away: 'Away' }[a.reason] || 'Away';
  return `<span class="pill limited" title="Agents leave work that needs you on the board and do review-free work. Change it in Settings.">${label} until ${esc(day(a.to).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</span>`;
}

function feedEntry(e) {
  const when = `<span class="when">${clock(e.ts)}</span>`;
  if (e.kind === 'system') return `<div class="entry system"><div class="body">${esc(e.text)} · ${clock(e.ts)}</div></div>`;
  if (e.kind === 'video') {
    return `<div class="entry video-entry" data-video="${esc(e.videoId)}"><div class="head"><span class="avatar" style="background:var(--accent)">★</span><span class="who">${esc(e.from)}</span><span class="pill queued vid-stage">🎬 reviewing the video…</span>${when}</div>
      <div class="body">${e.text ? `<div class="md">${md(e.text)}</div>` : ''}${attachmentsHtml(e.attachments)}<div class="hint vid-progress">Your note goes to the team with Claude's timestamped review as soon as it's done.</div></div></div>`;
  }
  if (e.kind === 'report') {
    return `<div class="entry report"><div class="head"><span class="avatar" style="background:var(--brand-green)">☀</span><span class="who">${esc(e.from || 'Daily update')}</span><span class="pill success">for you</span>${when}</div>
      <div class="body"><div class="md">${md(e.text)}</div></div></div>`;
  }
  if (e.kind === 'ask') {
    return `<div class="entry ask"><div class="head"><span class="avatar" style="background:var(--accent)">★</span><span class="who">${esc(e.from)}</span><span class="pill">asked ${esc(e.to || 'Claude')}</span>${when}</div>
      <div class="body"><div class="md">${md(e.text)}</div>${attachmentsHtml(e.attachments)}</div></div>`;
  }
  if (e.kind === 'answer') {
    return `<div class="entry answer${e.error ? ' failed' : ''}"><div class="head"><span class="avatar" style="background:var(--blue)">C</span><span class="who">${esc(e.from)}</span><span class="pill">${e.error ? 'no answer' : 'answer'}</span>${when}</div>
      <div class="body"><div class="md">${md(e.text)}</div>${e.error ? '' : `<div class="answer-actions"><button class="ghost small" data-act="ask-to-team" data-id="${e.askId}" title="Turn this into a note for the agents">Send to team</button><button class="ghost small" data-act="ask-copy" data-id="${e.askId}">Copy</button>${e.cost ? `<span class="hint" style="margin:0">${money(e.cost)}</span>` : ''}</div>`}</div></div>`;
  }
  let av = e.agentId ? avatar(e.from, e.agentId) : '';
  let label = '';
  if (e.kind === 'note') {
    av = e.source === 'review' ? '<span class="avatar" style="background:var(--violet)">R</span>' : '<span class="avatar" style="background:var(--accent)">★</span>';
    const src = e.source === 'review-session' ? 'director review · ' : e.source === 'review' ? 'review · ' : e.source === 'studio' ? 'studio · ' : e.source === 'playtest' ? 'playtesters · ' : '';
    label = e.to ? `<span class="pill">to ${esc(e.to)} only</span>` : `<span class="pill limited">${src}note #${e.num} · all agents</span>`;
  } else if (e.kind === 'question') {
    label = '<span class="pill limited">question · not blocking</span>';
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
  if (e.kind === 'question') body += `<div style="margin-top:8px"><button class="btn small" data-act="q-answer" data-id="${e.questionId}">Answer</button></div>`;
  if (e.kind === 'note' && e.num && !e.to) body += `<div class="note-acts"><button class="ghost small" data-act="note-check" data-num="${e.num}" title="Does this feedback confirm any blocked ticket, or send it back? New notes are checked by themselves.">Check blocked tickets</button></div>`;
  if (e.kind === 'build') body +=`<div style="margin-top:8px"><button class="btn small" data-act="build-log" data-id="${e.buildId}">View log</button></div>`;
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
  if (a.status === 'queued') return `<span class="pill queued" title="${esc(a.waiting ? `Waiting to ${a.waiting.what}. It waits for ${a.waiting.why}.` : `${a.queue} queued`)}">queued${a.waiting ? `: ${esc(a.waiting.short)}` : ` ${a.queue}`}</span>`;
  if (a.status === 'unlinked') return '<span class="pill limited" title="Connect a cloud session before it can take work">needs session</span>';
  if (a.status === 'capped') return `<span class="pill limited" title="This game's usage cap or a stop rule is holding its ${a.queue} queued item(s) until the account's limits reset (game Settings)">held by usage rules</span>`;
  return `<span class="pill ${a.status}">${a.status}</span>`;
}

function renderAgentList() {
  const el = $('#agent-list');
  if (!el) return;
  const g = game();
  const agents = agentsOf(g.id, { all: true });
  // A tree: main agents, with the delegate chats they opened nested beneath them. Finished
  // delegates fold into a count so the list stays about what's working now.
  const card = (a, depth) => {
    const acct = acctOf(a.accountId);
    const held = S.st.tasks.find((t) => t.claimedBy === a.id && t.status === 'claimed');
    const sn = a.subagents?.active?.length || 0;
    const kids = agents.filter((k) => k.parentId === a.id && !k.retired).length;
    return `<button class="agent-card${a.id === S.agentId ? ' active' : ''}${depth ? ' delegate-card' : ''}" style="margin-left:${depth * 16}px" data-act="agent-select" data-id="${a.id}">
      <div class="row">${avatar(a.name, a.id)}<span class="name">${depth ? '<span class="hint" style="display:inline">↳ </span>' : ''}${esc(a.name)}${g.leadAgentId === a.id ? ' <span class="hint" style="display:inline">lead</span>' : ''}</span>
        ${kids ? `<span class="pill" title="Delegate chats this agent has open">${kids} delegate${kids > 1 ? 's' : ''}</span>` : ''}${sn ? `<span class="pill queued" title="Subagents running inside this chat">+${sn} sub</span>` : ''}${statusPill(a)}</div>
      <div class="meta">${esc([depth ? 'delegate chat' : a.role, acct?.name, a.branch].filter(Boolean).join(' · '))}</div>
      <div class="meta">${held ? `on #${held.num} ${esc(held.title)}` : depth && a.delegateBrief ? esc(a.delegateBrief.slice(0, 90)) : `${a.turns || 0} turns · $${(a.costUsd || 0).toFixed(2)}`}</div>
    </button>`;
  };
  const tree = (a, depth) => {
    const kids = agents.filter((k) => k.parentId === a.id);
    const live = kids.filter((k) => !k.retired);
    const finished = kids.length - live.length;
    return card(a, depth) + live.map((k) => tree(k, depth + 1)).join('')
      + (finished ? `<div class="hint" style="margin:0 0 0 ${(depth + 1) * 16 + 4}px">${finished} delegate chat${finished > 1 ? 's' : ''} reported back</div>` : '');
  };
  const roots = agents.filter((a) => !a.parentId || !agents.some((p) => p.id === a.parentId));
  el.innerHTML = roots.map((a) => tree(a, 0)).join('') + `<button class="ghost" data-act="agent-add" style="margin-top:4px">+ Add agent</button>
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
    const liveItems = live ? live.items || [{ key: live.key, taskId: live.taskId }] : [];
    const liveTasks = liveItems.map((i) => ({ ...i, task: S.st.tasks.find((t) => t.id === i.taskId) }));
    el.innerHTML = `${avatar(a.name, a.id)}<h3>${esc(a.name)}</h3>${statusPill(a)}<span class="pill">${esc(acct?.name || '?')}</span>
      <span class="spacer"></span>
      ${a.cloudLink
        ? `<a class="btn small" href="${esc(a.cloudLink.url)}" target="_blank" rel="noopener">Open cloud session</a><button class="ghost small" data-act="cloud-connect">Change session</button>`
        : '<button class="primary small" data-act="cloud-connect">Connect cloud session</button>'}
      ${live ? '<button class="danger small" data-act="agent-stop" title="Stop tracking this task and put it back on the board">Stop</button>' : ''}
      <button class="ghost small" data-act="agent-edit">Edit</button>
      <button class="ghost small" data-act="agent-remove">Remove</button>
      <div class="hint" style="flex-basis:100%;margin:0">${live
        ? `Working on ${liveTasks.map((i) => (i.task ? `${i.done ? '<s>' : ''}#${i.task.num} ${esc(i.task.title)}${i.done ? '</s>' : ''}` : i.key === 'survey' ? 'the project survey' : 'your message')).join(', ')} since ${clock(live.since)}. Ballast checks GitHub every 90 seconds for reports.`
        : last ? `Last session finished ${ago(last.at)}: ${last.pr ? `<a href="${esc(last.pr)}" target="_blank" rel="noopener">pull request</a>` : `branch ${esc(last.branch)}`} · <a href="${esc(last.url)}" target="_blank" rel="noopener">session</a>`
        : a.cloudLink ? 'Idle. Its cloud session gets the next open task (with autopilot on, or when you press Wake) or your next message.'
        : 'Needs a cloud session before it can take tasks: press Connect cloud session.'}
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
    ${delegateChatsPanel(a)}
    ${subagentsPanel(a)}
    ${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}`;
}

// Delegate chats: this agent's parent and brief (if it is one), and the chats it has opened.
function delegateChatsPanel(a) {
  const parent = a.parentId && agentOf(a.parentId);
  const kids = S.st.agents.filter((k) => k.parentId === a.id);
  const head = parent || a.delegateBrief
    ? `<div class="hint" style="margin:0"><b style="color:var(--text)">Delegate chat</b> opened by ${parent ? `<span class="link" data-act="agent-select" data-id="${parent.id}">${esc(parent.name)}</span>` : 'a closed chat'}${a.retired ? ' · reported back' : ''}</div>
      ${a.delegateBrief ? `<div class="md" style="font-size:13px">${md(a.delegateBrief.slice(0, 800))}</div>` : ''}
      ${a.delegateResult ? `<div class="hint" style="margin:4px 0 0">Report: ${esc(a.delegateResult.summary.slice(0, 500))}</div>` : ''}`
    : '';
  const list = kids.length
    ? `<div class="hint" style="margin:${head ? '8px' : '0'} 0 0"><b style="color:var(--text)">Delegate chats</b> ${kids.filter((k) => !k.retired).length} open of ${a.delegateLimit || 'no'} allowed · ${kids.filter((k) => k.retired).length} reported back</div>
      ${kids.map((k) => `<div class="delegate"><span class="dot ${k.status}"></span><span class="link grow" data-act="agent-select" data-id="${k.id}">${esc(k.name)}</span><span class="hint" style="margin:0">${k.retired ? 'reported back' : esc(k.status)} · ${esc(acctOf(k.accountId)?.name || '')}</span></div>`).join('')}`
    : '';
  return head || list ? `<div class="delegates">${head}${list}</div>` : '';
}

// The subagents a local agent is running inside its chat, live, with the limit and what recently finished.
function subagentsPanel(a) {
  const d = a.subagents || { active: [], recent: [] };
  const limit = a.subagentLimit;
  if (!d.active.length && !d.recent.length && !a.subagentsRun) return '';
  return `<div class="delegates">
    <div class="hint" style="margin:0"><b style="color:var(--text)">Subagents</b> ${d.active.length}${limit ? ` of ${limit}` : ''} running · ${a.subagentsRun || 0} finished${a.subagentsDenied ? ` · ${a.subagentsDenied} held back by the limit` : ''}</div>
    ${d.active.map((x) => `<div class="delegate"><span class="dot running"></span><span class="grow">${esc(x.description)}</span><span class="hint" style="margin:0">${esc(x.type)}${x.background ? ' · background' : ''} · <span data-since="${x.startedAt}"></span></span></div>`).join('')}
    ${d.recent.length ? `<details><summary class="hint" style="display:inline;cursor:pointer">Recently finished (${d.recent.length})</summary>${d.recent.map((x) => `<div class="delegate"><span class="dot ${x.ok ? 'idle' : 'error'}"></span><span class="grow">${esc(x.description)}</span><span class="hint" style="margin:0">${esc(x.type)} · ${dur(x.endedAt - x.startedAt)}</span></div>`).join('')}</details>` : ''}
  </div>`;
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

const PRIO_LABEL = ['Low', 'Normal', 'High', 'Urgent'];

// ---------------------------------------------------------------------------
// Ticket conversations: talk a ticket through with Claude, then rewrite it from what you decided

function threadMsg(m) {
  if (m.role === 'system') return `<div class="th-sys">${esc(m.text)} · ${clock(m.ts)}</div>`;
  const me = m.role === 'user';
  return `<div class="th-msg ${me ? 'me' : 'claude'}${m.error ? ' failed' : ''}"><div class="th-head"><b>${esc(m.from)}</b>${me && m.to ? ` <span class="hint" style="display:inline">to ${esc(m.to)}</span>` : ''} <span class="hint" style="display:inline">${clock(m.ts)}${m.cost ? ` · ${money(m.cost)}` : ''}</span></div><div class="md">${md(m.text)}</div>${attachmentsHtml(m.attachments)}</div>`;
}

async function threadModal(taskId) {
  const t = S.st.tasks.find((x) => x.id === taskId);
  if (!t) return;
  let data;
  try { data = await api('GET', `/api/tasks/${taskId}/thread`); } catch (err) { return fail(err); }
  const r = roomiestAccount();
  const opener = t.status === 'blocked'
    ? `Agent blocked on this: ${t.blockReason || '(no reason given)'}. What's going on, and what are our options?`
    : '';
  modal({
    title: `#${t.num} ${t.title.replace(/^\s*\[[^\]]+\]\s*/, '')}`,
    wide: true,
    body: `<div class="th-ticket"><span class="pill ${esc(t.status)}">${esc(t.status)}</span> <span class="pill">${PRIO_LABEL[t.priority ?? 1]}</span>
        ${t.blockReason ? `<div class="blocked" style="margin-top:6px">${esc(t.blockReason)}</div>` : ''}
        <details style="margin-top:6px"><summary class="hint" style="display:inline;cursor:pointer">Ticket detail</summary><div class="md" style="margin-top:6px">${md(t.detail || '(none)')}</div></details></div>
      <div class="th-msgs" id="thread-msgs" data-task="${t.id}">${data.messages.length ? data.messages.map(threadMsg).join('') : `<p class="hint">Talk this ticket through with Claude: it reads the code and the ticket, lays out the options and recommends one. When you've decided, press <b>Update the ticket</b>.</p>`}</div>
      <div id="thread-live"></div>
      <div id="thread-form-wrap">
        <form id="thread-form" class="th-form"><textarea rows="3" placeholder="What do you want to work out?">${esc(data.messages.length ? '' : opener)}</textarea>
          <div class="row" style="gap:8px"><span class="hint grow" style="margin:0">${r ? `Answered by ${esc(r.a.name)} (most weekly room) · reads the repo, changes nothing` : 'No account has usage free'}</span>
            <button type="button" class="ghost small" data-thread-update ${data.messages.some((m) => m.role === 'assistant' && !m.error) ? '' : 'disabled'}>Update the ticket</button>
            <button class="primary small">Send</button></div></form></div>`,
    actions: [],
    onMount: (root) => {
      const list = $('#thread-msgs', root);
      list.scrollTop = list.scrollHeight;
      const form = $('#thread-form', root);
      const ta = $('textarea', form);
      ta.focus();
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (!ta.value.trim()) return;
        const btn = $('button.primary', form);
        btn.disabled = true;
        try { await api('POST', `/api/tasks/${taskId}/thread`, { text: ta.value }); ta.value = ''; threadLive(taskId, r?.a.name || 'Claude', ''); } catch (err) { fail(err); } finally { btn.disabled = false; }
      };
      $('[data-thread-update]', root).onclick = (e) => threadPropose(taskId, root, e.target);
    },
  });
}

function threadLive(taskId, account, text) {
  const list = $(`#thread-msgs[data-task="${taskId}"]`);
  const live = $('#thread-live');
  if (!list || !live) return;
  live.innerHTML = `<div class="th-msg claude live"><div class="th-head"><b>${esc(account)}</b> <span class="pill queued">answering…</span></div><div class="md">${text ? md(text) : '<span class="hint">Reading the ticket and the code…</span>'}</div></div>`;
  list.scrollTop = list.scrollHeight;
  live.scrollIntoView({ block: 'end' });
}

async function threadPropose(taskId, root, btn) {
  btn.disabled = true;
  btn.textContent = 'Drafting the update…';
  let p;
  try { p = await api('POST', `/api/tasks/${taskId}/thread/propose`); } catch (err) { btn.disabled = false; btn.textContent = 'Update the ticket'; return fail(err); }
  const t = S.st.tasks.find((x) => x.id === taskId);
  const held = t.status === 'claimed' && t.claimedBy;
  const holder = held ? agentOf(t.claimedBy)?.name || 'its agent' : '';
  const next = held && p.next === 'open' ? 'keep' : p.next; // an agent is on it: don't pull it back mid-work by default
  $('#thread-form-wrap', root).innerHTML = `<form id="thread-apply" class="th-apply card">
      <b>Updated ticket</b> <span class="hint" style="display:inline">drafted from your conversation: edit anything, then apply</span>
      <p class="th-decision">${esc(p.decision)}</p>
      <label class="field"><span>Title</span><input name="title" value="${esc(p.title)}"></label>
      <label class="field"><span>Detail</span><textarea name="detail" rows="9">${esc(p.detail)}</textarea></label>
      <div class="two"><label class="field"><span>Then</span><select name="next">
          <option value="open"${next === 'open' ? ' selected' : ''}>${t.status === 'open' ? 'Leave it open on the board' : 'Put it back on the board for an agent'}</option>
          <option value="keep"${next === 'keep' ? ' selected' : ''}>Keep it ${esc(t.status)}</option>
          <option value="done"${next === 'done' ? ' selected' : ''}>Close it: no longer needed</option></select></label>
        <label class="field"><span>Priority</span><select name="priority">${['low', 'normal', 'high', 'urgent'].map((v, i) => `<option value="${v}"${p.priority === v ? ' selected' : ''}>${PRIO_LABEL[i]}</option>`).join('')}</select></label></div>
      ${held ? `<label class="check"><input type="checkbox" name="tellAgent" checked><span>Tell ${esc(holder)} now (it's working on this and won't reread the ticket mid-task)</span></label>` : ''}
      <div class="row" style="gap:8px;justify-content:flex-end"><button type="button" class="ghost small" data-back>Keep talking</button><button class="primary small">Apply</button></div>
    </form>`;
  const f = $('#thread-apply', root);
  $('[data-back]', f).onclick = () => { $('[data-close]', root).click(); threadModal(taskId); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = formData(f);
    try {
      await api('POST', `/api/tasks/${taskId}/thread/apply`, { ...v, decision: p.decision, tellAgent: !!v.tellAgent });
      toast(`#${t.num} updated`);
      $('[data-close]', root).click();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// GDD re-evaluation (Board tab): pull the latest GDD, read the repo, add what's missing. On demand or scheduled.

const GDD_SCHEDULES = { off: 'Off', hourly: 'Every hour', '6h': 'Every 6 hours', daily: 'Every day', weekly: 'Every week' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const gddPagesOf = (g) => (S.st.cloudArtifacts || []).filter((c) => c.gameId === g.id && (c.role === 'gdd' || /\bgdd\b|game design doc/i.test(c.title || '')));

function gddBar(g) {
  const r = g.gddReview || { every: 'off', at: '09:00', day: 1, onlyOnChange: true };
  const opt = (v, cur, label) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="gdd-bar" id="gdd-bar">
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <button type="button" class="primary small" data-act="gdd-review" id="gdd-run">Re-evaluate against the GDD &amp; update tasks</button>
      <span class="hint grow" id="gdd-status" style="margin:0"></span>
    </div>
    <div class="row gdd-sched" style="gap:8px;flex-wrap:wrap">
      <span class="hint" style="margin:0">Run it</span>
      <select class="mini" data-gdd="every">${Object.entries(GDD_SCHEDULES).map(([k, l]) => opt(k, r.every, l)).join('')}</select>
      <select class="mini" data-gdd="day" ${r.every === 'weekly' ? '' : 'hidden'}>${WEEKDAYS.map((d, i) => opt(i, r.day ?? 1, `on ${d}`)).join('')}</select>
      <input class="mini" type="time" data-gdd="at" value="${esc(r.at || '09:00')}" ${r.every === 'daily' || r.every === 'weekly' ? '' : 'hidden'}>
      <select class="mini" data-gdd="model" title="Model for the re-evaluation">${opt('', r.model || '', 'Sonnet (default)')}${opt('opus', r.model || '', 'Opus')}${opt('haiku', r.model || '', 'Haiku')}</select>
      <label class="check" style="margin:0" ${r.every === 'off' ? 'hidden' : ''} data-gdd-skip><input type="checkbox" data-gdd="onlyOnChange" ${r.onlyOnChange !== false ? 'checked' : ''}><span class="hint" style="margin:0">Skip scheduled runs when the GDD hasn't changed</span></label>
    </div>
  </div>`;
}

// The status line, refreshed with the board.
function renderGddStatus(g) {
  const el = $('#gdd-status');
  if (!el) return;
  const r = g.gddReview || {};
  const pages = gddPagesOf(g);
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const parts = [];
  if (r.status === 'running') parts.push('<b>Re-evaluating:</b> pulling the latest GDD, reading the repo…');
  else if (r.status === 'error') parts.push(`<span class="gdd-err">✗ ${esc(r.error || 'The last run failed.')}</span>`);
  else if (r.last) {
    const l = r.last;
    parts.push(l.skipped
      ? `Last check ${esc(ago(l.at))}: GDD unchanged, skipped`
      : `Last run ${esc(ago(l.at))}: ${l.added?.length ? `added ${l.added.map((n) => `#${n}`).join(', ')}` : 'no new tasks'}${l.gddChanged ? ' · the GDD had changed' : ''}${l.outdated?.length ? ` · ${l.outdated.length} ticket${l.outdated.length > 1 ? 's' : ''} may not match the GDD (see the feed)` : ''}`);
  } else parts.push(pages.length ? `GDD: ${esc(pages.map((p) => p.title).join(', '))}, plus GDD files in the repo` : 'No claude.ai GDD page is tracked for this game; GDD and design files in the repo are used.');
  if (r.warning && r.status !== 'running') parts.push(`<span class="gdd-err">${esc(r.warning)}</span>`);
  if (r.every && r.every !== 'off' && r.nextAt && r.status !== 'running') parts.push(`next ${esc(when(r.nextAt))}`);
  el.innerHTML = parts.join(' · ');
  const btn = $('#gdd-run');
  if (btn) { btn.disabled = r.status === 'running'; btn.textContent = r.status === 'running' ? 'Re-evaluating…' : 'Re-evaluate against the GDD & update tasks'; }
}

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!t.dataset?.gdd || !t.closest('#gdd-bar')) return;
  const bar = t.closest('#gdd-bar');
  const val = (k) => $(`[data-gdd="${k}"]`, bar);
  if (t.dataset.gdd === 'every') {
    val('day').hidden = t.value !== 'weekly';
    val('at').hidden = !['daily', 'weekly'].includes(t.value);
    $('[data-gdd-skip]', bar).hidden = t.value === 'off';
  }
  try {
    await api('PATCH', `/api/games/${S.gameId}/gdd-review`, { every: val('every').value, at: val('at').value || '09:00', day: Number(val('day').value), onlyOnChange: val('onlyOnChange').checked, model: val('model').value });
    toast(val('every').value === 'off' ? 'GDD re-evaluation: on demand only' : `GDD re-evaluation scheduled: ${GDD_SCHEDULES[val('every').value].toLowerCase()}`);
  } catch (err) { fail(err); }
});

function renderBoard() {
  const el = $('#board');
  if (!el) return;
  const game = S.st.games.find((x) => x.id === S.gameId);
  if (game) renderGddStatus(game);
  const jb = $('#jungle-bar');
  if (jb && game) jb.innerHTML = jungleBar(game);
  const fb = $('#focus-bar');
  if (fb && game && !fb.contains(document.activeElement)) fb.innerHTML = focusBar(game);
  const tasks = tasksOf(S.gameId);
  const name = (id) => agentOf(id)?.name || 'removed agent';
  const cols = [['open', 'Open'], ['claimed', 'In progress'], ['review', 'Awaiting approval'], ['blocked', 'Blocked'], ['done', 'Done']];
  const { shown: doneShown, archived } = boardArchive(tasks);
  el.innerHTML = cols.map(([status, label]) => {
    let list = tasks.filter((t) => t.status === status);
    list = status === 'done' ? doneShown : list.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1) || a.num - b.num);
    const count = status === 'done' ? doneShown.length : list.length;
    const extra = status === 'done' && archived.length ? `<a href="#" class="col-archive" data-act="board-archive" title="Older done tickets and cancelled ones">Archive ${archived.length}</a>` : '';
    return `<div class="col"><h5>${label} <span>${count}</span>${extra}</h5>${list.map((t) => {
      const meta = status === 'claimed' ? `${esc(name(t.claimedBy))} · ${ago(t.claimedAt)}`
        : status === 'done' ? `${esc(name(t.doneBy))} · ${ago(t.doneAt)}`
        : `${t.assignee ? `for ${esc(name(t.assignee))} · ` : ''}from ${esc(t.createdBy || '?')}${t.noteNum ? ` · note #${t.noteNum}` : ''}`;
      const talk = t.thread?.count ? `💬 ${t.thread.count}` : status === 'blocked' ? 'Work it out with Claude' : '💬 Discuss';
      const iv = t.human && openInterventions().find((i) => i.id === t.human);
      const acts = [
        iv && `<button class="primary small hi-btn" data-act="hi-open" data-id="${iv.id}">What's needed</button>`,
        status === 'blocked' && !t.human && t.triage?.status !== 'running' && `<button class="ghost small" data-act="task-triage" data-id="${t.id}" title="Have Claude work out whether an agent can still do it, or what a person needs to do">Triage</button>`,
        status === 'blocked' && `<button class="${iv ? 'ghost' : 'primary'} small" data-act="thread-open" data-id="${t.id}">${talk}</button>`,
        status === 'review' && `<button class="primary small" data-act="review-approve" data-id="${t.id}">Approve</button>`,
        status !== 'blocked' && `<button class="ghost small" data-act="thread-open" data-id="${t.id}" title="Talk this ticket through with Claude">${talk}</button>`,
        status !== 'open' && `<button class="ghost small" data-act="task-status" data-id="${t.id}" data-status="open">Reopen</button>`,
        status !== 'done' && `<button class="ghost small" data-act="task-status" data-id="${t.id}" data-status="done">Done</button>`,
        status !== 'done' && `<button class="ghost small" data-act="task-cancel" data-id="${t.id}" title="Close it without doing it; it goes to the board archive">Cancel</button>`,
        ownerActs(game, t, status),
        `<button class="ghost small" data-act="task-edit" data-id="${t.id}">Edit</button>`,
        `<button class="ghost small" data-act="task-delete" data-id="${t.id}">Delete</button>`,
      ].filter(Boolean).join('');
      const p = t.priority ?? 1;
      const moves = status === 'done' ? '' : `<span class="prio-moves">
          <button class="icon-btn" data-act="task-prio" data-id="${t.id}" data-dir="up" ${p >= 3 ? 'disabled' : ''} title="Promote${p < 3 ? ` to ${PRIO_LABEL[p + 1]}` : ''}">▲</button>
          <button class="icon-btn" data-act="task-prio" data-id="${t.id}" data-dir="down" ${p <= 0 ? 'disabled' : ''} title="Demote${p > 0 ? ` to ${PRIO_LABEL[p - 1]}` : ''}">▼</button></span>`;
      return `<div class="task prio-${p}">
        <div class="task-top"><div class="grow"><span class="num">#${t.num}</span>${p !== 1 && status !== 'done' ? `<span class="prio-badge p${p}">${PRIO_LABEL[p]}</span>` : ''}<span class="title">${esc(t.title)}</span>${focusPill(game, t)}${ownerPill(game, t)}</div>${moves}</div>
        <div class="meta">${meta}${t.note && status === 'open' ? ` · ${esc(t.note)}` : ''}</div>
        ${t.detail && status !== 'done' ? `<div class="detail">${esc(t.detail)}</div>` : ''}
        ${t.summary ? `<div class="summary">${esc(t.summary)}</div>` : ''}
        ${iv ? `<div class="hi-line"><span class="hi-tag">🙋 NEEDS YOU</span> ${esc(iv.title)}</div>` : ''}
        ${status === 'blocked' && t.triage?.status === 'running' ? '<div class="hint" style="margin:4px 0 0">Self-triaging: can an agent still do this, or does it need a person?</div>' : ''}
        ${status === 'blocked' && t.triage?.verdict === 'stuck' ? '<div class="hint" style="margin:4px 0 0;color:var(--accent)">Blocked again after retries, with no person-only cause found. Talk it through.</div>' : ''}
        ${t.triage?.verdict === 'retry' && status !== 'blocked' && t.triage.why ? `<div class="hint" style="margin:4px 0 0">↻ Self-triaged: ${esc(t.triage.why.slice(0, 160))}</div>` : ''}
        ${t.feedbackCheck && status === 'blocked' && t.feedbackCheck.verdict === 'waiting' ? `<div class="hint fb-check">⏸ Checked against note #${t.feedbackCheck.note}: ${esc(t.feedbackCheck.evidence.slice(0, 220))}</div>` : ''}
        ${t.feedbackCheck?.verdict === 'reopen' && status === 'open' ? `<div class="hint fb-check">↩ Reopened by note #${t.feedbackCheck.note}: ${esc(t.feedbackCheck.evidence.slice(0, 220))}</div>` : ''}
        ${t.blockReason && status === 'blocked' ? `<div class="blocked">${esc(t.blockReason)}</div>` : ''}
        <div class="acts">${acts}</div>
      </div>`;
    }).join('')}</div>`;
  }).join('');
}

// The Done column keeps the latest 50; older done tickets and cancelled ones live in the archive.
const DONE_SHOWN = 50;
function boardArchive(tasks) {
  const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.doneAt || b.updatedAt || 0) - (a.doneAt || a.updatedAt || 0));
  const kept = done.filter((t) => !t.cancelled);
  const shown = kept.slice(0, DONE_SHOWN);
  return { shown, archived: done.filter((t) => !shown.includes(t)) };
}

function archiveModal() {
  const g = game();
  const name = (id) => agentOf(id)?.name || '';
  const rows = () => boardArchive(tasksOf(g.id)).archived;
  const item = (t) => `<div class="arch-row" data-id="${t.id}">
      <div class="row" style="gap:8px"><span class="num">#${t.num}</span><span class="grow">${esc(t.title)}</span>
        <span class="pill${t.cancelled ? ' limited' : ' success'}">${t.cancelled ? 'cancelled' : 'done'}</span>
        <span class="hint" style="margin:0;white-space:nowrap">${t.doneAt ? ago(t.doneAt) : ''}${t.doneBy && name(t.doneBy) ? ` · ${esc(name(t.doneBy))}` : ''}</span>
        <button class="ghost small" data-act="archive-reopen" data-id="${t.id}">Reopen</button></div>
      ${t.summary ? `<details><summary class="hint">What happened</summary><div class="summary">${esc(t.summary)}</div></details>` : ''}
    </div>`;
  modal({
    title: `Board archive · ${g.name}`,
    wide: true,
    body: `<p class="hint" style="margin-top:0">Done tickets older than the latest ${DONE_SHOWN}, and every cancelled ticket. Agents can still see them when they search the board.</p>
      <div class="row" style="gap:8px;margin-bottom:10px"><input name="q" placeholder="Search by number, title or summary" class="grow">
        <select name="kind" class="mini"><option value="">Done and cancelled</option><option value="done">Done</option><option value="cancelled">Cancelled</option></select></div>
      <div class="arch-list"></div>`,
    onMount: (root) => {
      const draw = () => {
        const q = $('[name=q]', root).value.trim().toLowerCase().replace(/^#/, '');
        const kind = $('[name=kind]', root).value;
        const list = rows().filter((t) => (!kind || (kind === 'cancelled') === !!t.cancelled)
          && (!q || String(t.num) === q || t.title.toLowerCase().includes(q) || (t.summary || '').toLowerCase().includes(q)));
        $('.arch-list', root).innerHTML = list.length ? list.slice(0, 300).map(item).join('') + (list.length > 300 ? `<p class="hint">${list.length - 300} more: search to narrow it down.</p>` : '') : '<p class="hint">Nothing matches.</p>';
      };
      $('[name=q]', root).oninput = draw;
      $('[name=kind]', root).onchange = draw;
      draw();
    },
  });
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

// ---------------------------------------------------------------------------
// Performance: profiler runs from playtests, how they trend across test builds, and each run over time

const PERF = { data: {}, sel: {}, loading: {} }; // per game: runs, selections
const SERIES = ['#3987e5', '#d95926']; // categorical slots 1-2, validated against the dark panel
const LOOK_NORMAL_FIELDS = ['t', 'fps', 'simMs', 'renderMs', 'draws', 'drawn', 'cpuMs', 'gpuMs', 'scale'];
const pfmt = (v, unit = '') => {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const n = a >= 1000 ? Math.round(v).toLocaleString() : a >= 100 ? String(Math.round(v)) : a >= 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v * 100) / 100);
  return unit === '%' ? `${n}%` : unit === 'ms' || unit === 'fps' ? `${n} ${unit}` : n;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const budgetTag = (ref, unit) => (ref != null ? `<span class="pf-budget"><i></i>budget ${pfmt(ref, unit)}</span>` : '');
const runTick = (r) => `${new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/s?([AP])M/i, (m, x) => x.toLowerCase())}`;
const runDay = (r) => new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' });
const runName = (r) => `${runDay(r)} ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${r.label ? ` · ${r.label}` : ''}`;
const niceMax = (v) => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v); };
const mmssP = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function loadPerf(gid = S.gameId) {
  PERF.loading[gid] = true;
  try { PERF.data[gid] = await api('GET', `/api/games/${gid}/perf`); } catch (err) { fail(err); PERF.data[gid] = []; }
  PERF.loading[gid] = false;
  if (S.tab === 'perf' && S.gameId === gid) renderPerf();
}

// +1 when higher is better (frame rate), -1 when lower is (ms, draw calls), read off the budgets.
function perfDirection(runs, name) {
  let up = 0;
  for (const r of runs) for (const b of r.budgets) if (b.name === name && b.limit != null && b.value !== b.limit) up += (b.value > b.limit) === b.pass ? 1 : -1;
  return up ? Math.sign(up) : /fps|rate/i.test(name) ? 1 : -1;
}

// Inside budget both times, a change is just a change; it only reads as better or worse when a budget is at stake.
function deltaHtml(cur, prev, dir, unit, neutral = false) {
  if (cur == null || prev == null) return '';
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return '<span class="pf-delta">no change</span>';
  const good = Math.sign(d) === dir;
  if (neutral) return `<span class="pf-delta"><i class="pf-arrow">${d > 0 ? '▲' : '▼'}</i> ${pfmt(Math.abs(d), unit)}</span>`;
  return `<span class="pf-delta"><i class="pf-arrow ${good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'}</i> ${pfmt(Math.abs(d), unit)} ${good ? 'better' : 'worse'}</span>`;
}

// One axis per chart: gridlines, y labels and an optional budget line.
function chartFrame(w, h, ymax, ref, unit) {
  const m = { l: 40, r: 12, t: 12, b: 22 };
  const y = (v) => m.t + (h - m.t - m.b) * (1 - v / ymax);
  const grid = [0, 0.5, 1].map((f) => `<line class="pf-gridline" x1="${m.l}" x2="${w - m.r}" y1="${y(ymax * f)}" y2="${y(ymax * f)}"/><text class="pf-ax" x="${m.l - 6}" y="${y(ymax * f) + 4}" text-anchor="end">${pfmt(ymax * f, unit === '%' ? '%' : '')}</text>`).join('');
  const budget = ref != null ? `<line class="pf-ref" x1="${m.l}" x2="${w - m.r}" y1="${y(ref)}" y2="${y(ref)}"/>` : '';
  return { m, y, grid, budget };
}

function trendCard(runs, name) {
  const pts = runs.map((r, i) => ({ r, i, b: r.budgets.find((x) => x.name === name) })).filter((p) => p.b);
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const unit = last.b.unit;
  const dir = perfDirection(runs, name);
  const w = 300, h = 130;
  const ymax = niceMax(Math.max(...pts.map((p) => p.b.value), ...pts.map((p) => p.b.limit ?? 0)) * 1.08);
  const f = chartFrame(w, h, ymax, last.b.limit, unit);
  const x = (i) => (runs.length < 2 ? (f.m.l + w - f.m.r) / 2 : f.m.l + 10 + ((w - f.m.l - f.m.r - 20) * i) / (runs.length - 1));
  const line = pts.length > 1 ? `<polyline class="pf-line" stroke="${SERIES[0]}" points="${pts.map((p) => `${x(p.i)},${f.y(p.b.value)}`).join(' ')}"/>` : '';
  const dots = pts.map((p) => {
    const tip = `${runName(p.r)}${p.r.noteNum ? ` (note #${p.r.noteNum})` : ''}\n${name}: ${pfmt(p.b.value, unit)}${p.b.limit != null ? ` · budget ${pfmt(p.b.limit, unit)}` : ''}\n${p.b.pass ? '✓ within budget' : '✗ over budget'}`;
    return `<circle class="pf-dot ${p.b.pass ? 'pass' : 'fail'}" cx="${x(p.i)}" cy="${f.y(p.b.value)}" r="4.5"/><circle class="pf-hit" cx="${x(p.i)}" cy="${f.y(p.b.value)}" r="13" data-tip="${esc(tip)}"/>`;
  }).join('');
  const xi = runs.length <= 3 ? runs.map((_, i) => i) : [0, runs.length - 1];
  const xl = xi.map((i) => `<text class="pf-ax" x="${x(i)}" y="${h - 6}" text-anchor="${i === 0 && runs.length > 1 ? 'start' : i === runs.length - 1 && runs.length > 1 ? 'end' : 'middle'}">${esc(runTick(runs[i]))}</text>`).join('');
  const agg = unit === 'max' ? 'peak' : unit === 'mean' ? 'average' : '';
  return `<div class="card pf-trend">
    <div class="pf-trend-head"><b>${esc(cap(name))}</b>${agg ? `<span class="hint" style="margin:0">${agg}</span>` : ''}${budgetTag(last.b.limit, unit)}</div>
    <div class="pf-big"><span>${pfmt(last.b.value, unit)}</span><span class="pf-status ${last.b.pass ? 'pass' : 'fail'}">${last.b.pass ? '✓ in budget' : '✗ over budget'}</span></div>
    <div class="pf-sub">${prev ? `${deltaHtml(last.b.value, prev.b.value, dir, unit, last.b.pass && prev.b.pass)} <span class="hint" style="margin:0">vs the run before</span>` : '<span class="hint" style="margin:0">One run so far</span>'}</div>
    <svg viewBox="0 0 ${w} ${h}" class="pf-svg" role="img" aria-label="${esc(name)} across runs">${f.grid}${f.budget}${line}${dots}${xl}</svg>
  </div>`;
}

// The charts for one run, over the length of the round.
function runCharts(r) {
  const F = r.samples.fields;
  const col = (n) => F.indexOf(n);
  const lim = (n) => r.budgets.find((b) => b.name === n)?.limit ?? null;
  const known = F.length >= 6 && F.every((f, i) => LOOK_NORMAL_FIELDS[i] === f);
  const charts = known ? [
    { title: 'Frame rate', unit: 'fps', series: [['fps', 'Frame rate']], ref: lim('frame rate') },
    { title: 'Frame time', unit: 'ms', series: [['cpuMs', 'CPU'], ['gpuMs', 'GPU']], ref: lim('frame CPU') ?? lim('frame GPU') },
    { title: 'Draw calls', unit: '', series: [['draws', 'Draw calls']], ref: lim('draw calls') },
    { title: 'Townsfolk drawn', unit: '', series: [['drawn', 'Townsfolk drawn']], ref: null },
    { title: 'Render scale', unit: '%', series: [['scale', 'Render scale']], ref: null, scale: 100, ymax: 100 },
    { title: 'Crowd CPU', unit: 'ms', series: [['simMs', 'Sim'], ['renderMs', 'Draw']], ref: null },
  ] : F.filter((f) => f !== 't').map((f) => ({ title: f, unit: '', series: [[f, f]], ref: null }));
  const ti = col('t');
  const rows = r.samples.rows;
  const T = rows.map((row, i) => (ti >= 0 && row[ti] != null ? row[ti] : i));
  const tmax = Math.max(1, ...T);
  return charts.map((c, ci) => {
    const ss = c.series.map(([f, label], si) => ({ label, i: col(f), color: SERIES[si] })).filter((s) => s.i >= 0 && rows.some((row) => row[s.i] != null));
    if (!ss.length) return '';
    const k = c.scale || 1;
    const w = 640, h = 140;
    const ymax = c.ymax || niceMax(Math.max(...ss.flatMap((s) => rows.map((row) => (row[s.i] ?? 0) * k)), c.ref ?? 0) * 1.08);
    const f = chartFrame(w, h, ymax, c.ref, c.unit);
    const x = (v) => f.m.l + ((w - f.m.l - f.m.r) * v) / tmax;
    const lines = ss.map((s) => {
      const pts = rows.map((row, i) => (row[s.i] == null ? null : `${x(T[i])},${f.y(row[s.i] * k)}`)).filter(Boolean);
      let lastI = rows.length - 1;
      while (lastI > 0 && rows[lastI][s.i] == null) lastI--;
      const label = ss.length > 1 ? `<text class="pf-direct" x="${w - f.m.r - 2}" y="${f.y(rows[lastI][s.i] * k) - 6}" text-anchor="end">${esc(s.label)}</text>` : '';
      return `<polyline class="pf-line" stroke="${s.color}" points="${pts.join(' ')}"/>${label}`;
    }).join('');
    const xl = [0, tmax / 2, tmax].map((v, i) => `<text class="pf-ax" x="${x(v)}" y="${h - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${mmssP(v)}</text>`).join('');
    const legend = ss.length > 1 ? `<span class="pf-legend">${ss.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</span>` : '';
    return `<div class="pf-run-chart">
      <div class="pf-trend-head"><b>${esc(cap(c.title))}</b>${legend}${budgetTag(c.ref, c.unit)}</div>
      <svg viewBox="0 0 ${w} ${h}" class="pf-svg pf-time" data-run="${esc(r.id)}" data-x0="${f.m.l}" data-x1="${w - f.m.r}" data-tmax="${tmax}" data-w="${w}">
        ${f.grid}${f.budget}${lines}${xl}<line class="pf-xh" x1="0" x2="0" y1="${f.m.t}" y2="${h - f.m.b}" visibility="hidden"/>
        <rect class="pf-overlay" x="${f.m.l}" y="0" width="${w - f.m.l - f.m.r}" height="${h}"/>
      </svg></div>`;
  }).join('');
}

// Hovering a run chart shows that moment across every chart of the run.
function perfHover(e) {
  const tip = $('#pf-tip');
  const hit = e.target.closest?.('[data-tip]');
  if (hit) { showTip(tip, hit.dataset.tip, e); return; }
  const svg = e.target.closest?.('svg.pf-time');
  if (!svg) { tip?.classList.add('hidden'); $$('.pf-xh').forEach((l) => l.setAttribute('visibility', 'hidden')); return; }
  const r = (PERF.data[S.gameId] || []).find((x) => x.id === svg.dataset.run);
  if (!r) return;
  const box = svg.getBoundingClientRect();
  const vx = ((e.clientX - box.left) / box.width) * Number(svg.dataset.w);
  const x0 = Number(svg.dataset.x0), x1 = Number(svg.dataset.x1), tmax = Number(svg.dataset.tmax);
  const tAt = Math.max(0, Math.min(tmax, ((vx - x0) / (x1 - x0)) * tmax));
  const F = r.samples.fields;
  const ti = F.indexOf('t');
  const T = r.samples.rows.map((row, i) => (ti >= 0 && row[ti] != null ? row[ti] : i));
  let best = 0;
  T.forEach((t, i) => { if (Math.abs(t - tAt) < Math.abs(T[best] - tAt)) best = i; });
  const px = x0 + ((x1 - x0) * T[best]) / tmax;
  $$('svg.pf-time .pf-xh').forEach((l) => { l.setAttribute('x1', px); l.setAttribute('x2', px); l.setAttribute('visibility', 'visible'); });
  const row = r.samples.rows[best];
  const names = { fps: 'Frame rate', cpuMs: 'CPU', gpuMs: 'GPU', draws: 'Draw calls', drawn: 'Townsfolk drawn', scale: 'Render scale', simMs: 'Crowd sim', renderMs: 'Crowd draw' };
  const units = { fps: 'fps', cpuMs: 'ms', gpuMs: 'ms', simMs: 'ms', renderMs: 'ms' };
  const lines = F.map((f, i) => (f === 't' || row[i] == null ? null : `${names[f] || f}: ${f === 'scale' ? `${Math.round(row[i] * 100)}%` : pfmt(row[i], units[f] || '')}`)).filter(Boolean);
  showTip(tip, `At ${mmssP(T[best])}\n${lines.join('\n')}`, e);
}

function showTip(tip, text, e) {
  if (!tip) return;
  tip.textContent = text;
  tip.classList.remove('hidden');
  const pad = 14;
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + pad)}px`;
  tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight - pad)}px`;
}

function renderPerf() {
  const el = $('#perf');
  if (!el) return;
  const gid = S.gameId;
  const all = PERF.data[gid];
  if (!all) { el.innerHTML = '<p class="hint">Loading profiler runs…</p>'; if (!PERF.loading[gid]) loadPerf(gid); return; }
  const add = '<label class="btn small pf-add">Add a profiler run<input type="file" accept=".json,application/json" multiple hidden data-perf-add></label>';
  if (!all.length) {
    el.innerHTML = `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Performance</h2>${add}</div>
      <p>Every profiler run from a playtest shows up here: how frame rate, CPU and GPU time, draw calls and the rest move from one test build to the next, and what each run looked like minute by minute.</p>
      <p class="hint">Attach the profiler's JSON to a note in the Feed (the team gets it too), or add it here. Ballast reads any JSON with a <code>budgets</code> list of <code>{ name, value, limit, unit, pass }</code>, plus <code>samples</code> over time if it has them.</p></div>`;
    return;
  }
  const runs = all.filter((r) => !r.hidden);
  const sel = PERF.sel[gid] ||= {};
  const ids = runs.map((r) => r.id);
  if (!ids.includes(sel.run)) sel.run = ids[ids.length - 1];
  if (!ids.includes(sel.b)) sel.b = ids[ids.length - 1];
  if (!ids.includes(sel.a) || sel.a === sel.b) sel.a = ids[Math.max(0, ids.indexOf(sel.b) - 1)];
  const latest = runs[runs.length - 1];
  // What's over budget in the latest run comes first, the rest in the profiler's own order.
  const names = [...new Set(runs.flatMap((r) => r.budgets.map((b) => b.name)))];
  const failing = (n) => latest?.budgets.find((b) => b.name === n)?.pass === false;
  const ordered = [...names.filter(failing), ...names.filter((n) => !failing(n))];
  const opt = (id) => runs.map((r) => `<option value="${esc(r.id)}"${r.id === id ? ' selected' : ''}>${esc(runName(r))}${r.noteNum ? ` · note #${r.noteNum}` : ''}</option>`).join('');
  const A = runs.find((r) => r.id === sel.a), B = runs.find((r) => r.id === sel.b), R = runs.find((r) => r.id === sel.run);
  const landed = A && B && A !== B ? all.filter((r) => r.at > Math.min(A.at, B.at) && r.at <= Math.max(A.at, B.at)).flatMap((r) => r.landed) : [];
  const cmpRows = A && B && A !== B ? ordered.map((n) => {
    const a = A.budgets.find((b) => b.name === n), b = B.budgets.find((x) => x.name === n);
    const unit = (b || a).unit;
    return `<tr><td>${esc(cap(n))}</td><td>${pfmt(a?.value, unit)}</td><td>${pfmt(b?.value, unit)}</td><td>${deltaHtml(b?.value, a?.value, perfDirection(runs, n), unit, !!(a?.pass && b?.pass)) || '–'}</td><td>${pfmt((b || a).limit, unit)}</td><td>${b ? `<span class="pf-status ${b.pass ? 'pass' : 'fail'}">${b.pass ? '✓ in' : '✗ over'}</span>` : '–'}</td></tr>`;
  }).join('') : '';
  el.innerHTML = `
    <div class="row pf-top"><h2 class="grow" style="margin:0">Performance</h2><span class="hint" style="margin:0">${runs.length} run${runs.length === 1 ? '' : 's'}${all.length > runs.length ? ` · ${all.length - runs.length} hidden` : ''}${latest ? ` · latest ${esc(ago(latest.at))}` : ''}</span>${add}</div>

    <h3 class="pf-h">How we're trending <span class="hint">each dot is a test run, oldest to newest; anything over budget comes first</span></h3>
    ${runs.length ? `<div class="pf-cards">${ordered.map((n) => trendCard(runs, n)).join('')}</div>` : '<p class="hint">Every run is hidden. Tick one under All runs.</p>'}

    <h3 class="pf-h">Compare two runs</h3>
    ${runs.length < 2 ? '<p class="hint">Needs a second run.</p>' : `<div class="card">
      <div class="row" style="gap:8px;flex-wrap:wrap"><select class="mini" data-perf-sel="a">${opt(sel.a)}</select><span class="hint" style="margin:0">→</span><select class="mini" data-perf-sel="b">${opt(sel.b)}</select></div>
      <div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>Measure</th><th>Before</th><th>After</th><th>Change</th><th>Budget</th><th>After</th></tr></thead><tbody>${cmpRows}</tbody></table></div>
      ${landed.length ? `<details class="pf-landed"><summary>${landed.length} ticket${landed.length === 1 ? '' : 's'} landed between these runs</summary><ul>${landed.map((t) => `<li>#${t.num} ${esc(t.title)}</li>`).join('')}</ul></details>` : ''}
    </div>`}

    <h3 class="pf-h">One run over time</h3>
    ${R ? `<div class="card">
      <div class="row" style="gap:8px;flex-wrap:wrap"><select class="mini" data-perf-sel="run">${opt(sel.run)}</select>
        <span class="hint grow" style="margin:0">${esc([R.summary, R.frameSummary].filter(Boolean).join(' · '))}${R.noteNum ? ` · from note #${R.noteNum}` : ''}</span><a class="hint" style="margin:0" href="${esc(R.url)}" target="_blank">JSON</a></div>
      ${R.samples.rows.length ? `<div class="pf-run">${runCharts(R)}</div>` : '<p class="hint">This run has no samples over time.</p>'}
    </div>` : ''}

    <h3 class="pf-h">All runs</h3>
    <div class="card"><div class="pf-table-wrap"><table class="pf-table pf-runs"><thead><tr><th>When</th><th>Label</th><th>From</th><th>Length</th><th>Result</th><th>Over budget</th><th>Show</th></tr></thead><tbody>
      ${[...all].reverse().map((r) => {
        const over = r.budgets.filter((b) => !b.pass);
        return `<tr class="${r.hidden ? 'pf-hidden' : ''}"><td>${esc(runName({ ...r, label: '' }))}</td>
          <td><input class="mini pf-label" data-perf-label="${esc(r.id)}" value="${esc(r.label)}" placeholder="e.g. after #344"></td>
          <td>${r.noteNum ? `note #${r.noteNum}` : '<span class="hint" style="margin:0">added here</span>'}</td>
          <td>${r.seconds != null ? mmssP(r.seconds) : '–'}</td><td>${esc(r.state || '')}</td>
          <td>${over.length ? esc(over.map((b) => b.name).join(', ')) : '<span class="pf-status pass">✓ none</span>'}</td>
          <td><input type="checkbox" data-perf-hide="${esc(r.id)}"${r.hidden ? '' : ' checked'} title="Leave it out of the charts (a broken run, another device)"></td></tr>`;
      }).join('')}
    </tbody></table></div><p class="hint">Untick a run to leave it out of the charts, for example one where walls didn't render and the numbers look better than they are.</p></div>
    <div id="pf-tip" class="pf-tip hidden"></div>`;
}

document.addEventListener('mousemove', (e) => {
  if (S.tab === 'perf' && $('#perf')?.contains(e.target)) perfHover(e);
  else $('#pf-tip')?.classList.add('hidden');
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!t.closest?.('#perf')) return;
  const gid = S.gameId;
  try {
    if (t.dataset.perfSel) { PERF.sel[gid][t.dataset.perfSel] = t.value; renderPerf(); }
    else if (t.dataset.perfLabel !== undefined) { await api('PATCH', `/api/games/${gid}/perf/${encodeURIComponent(t.dataset.perfLabel)}`, { label: t.value }); loadPerf(gid); }
    else if (t.dataset.perfHide !== undefined) { await api('PATCH', `/api/games/${gid}/perf/${encodeURIComponent(t.dataset.perfHide)}`, { hidden: !t.checked }); loadPerf(gid); }
    else if (t.dataset.perfAdd !== undefined) {
      const before = (PERF.data[gid] || []).length;
      for (const file of t.files) await sendFile(`/api/games/${gid}/upload`, file, () => {}).done;
      await loadPerf(gid);
      const added = (PERF.data[gid] || []).length - before;
      toast(added ? `Added ${added} run${added > 1 ? 's' : ''}` : 'That file isn\'t a profiler run Ballast can read: it needs a "budgets" list.', !added);
    }
  } catch (err) { fail(err); }
});

// ---------------------------------------------------------------------------
// Gameplay Loop: each loop's stage tests, a live model (sliders → graphs, computed here as they move),
// what playtests and reviews say about it, a conversation per loop that can add sliders and graphs,
// and Lock In Changes, which turns the tuning and decisions into board tasks (see src/loops.mjs).

const LOOPS = { data: {}, loading: {}, open: new Set(), dragging: false, stale: false, timers: {}, reload: null, pts: {} };
const LP_COLORS = ['var(--blue)', 'var(--accent)', 'var(--violet)', 'var(--green)'];
const LP_SCORE = ['missing', 'weak', 'holds', 'strong'];
const LP_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const lpNum = (v, step) => {
  if (v == null || !Number.isFinite(v)) return '–';
  if (step) { const own = (String(v).split('.')[1] || '').length; const d = Math.min(6, Math.max(own, -Math.floor(Math.log10(step) + 1e-9), 0)); return Number(v.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d }); }
  const a = Math.abs(v);
  return a >= 1000 ? Math.round(v).toLocaleString() : a >= 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v * 1000) / 1000);
};
const lpText = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const lpLoop = (lid) => (LOOPS.data[S.gameId]?.loops || []).find((l) => l.id === lid);
const lpChanged = (p) => p.value !== p.base && !(p.locked && p.locked.value === p.value);

async function loadLoops(gid = S.gameId) {
  LOOPS.loading[gid] = true;
  try { LOOPS.data[gid] = await api('GET', `/api/games/${gid}/loops`); } catch (err) { fail(err); LOOPS.data[gid] = null; }
  LOOPS.loading[gid] = false;
  if (S.tab === 'loops' && S.gameId === gid) renderLoops();
}

// Server says something changed (an audit, an answer, a lock-in): reload, but never mid-drag.
function loopsChanged(gid) {
  if (S.tab !== 'loops' || S.gameId !== gid) { delete LOOPS.data[gid]; return; }
  if (LOOPS.dragging) { LOOPS.stale = true; return; }
  clearTimeout(LOOPS.reload);
  LOOPS.reload = setTimeout(() => loadLoops(gid), 250);
}

function lpSchedule(d) {
  const every = d.every || 'off';
  return `<div class="lp-sched">
    <label class="hint" style="margin:0">Audit</label>
    <select class="mini" data-lp-sched="every">${Object.entries(d.schedules).map(([k, v]) => `<option value="${k}"${k === every ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
    ${every === 'daily' || every === 'weekly' ? `${every === 'weekly' ? `<select class="mini" data-lp-sched="day">${LP_DAYS.map((n, i) => `<option value="${i}"${i === (d.day ?? 1) ? ' selected' : ''}>${n}</option>`).join('')}</select>` : ''}<input class="mini" type="time" data-lp-sched="at" value="${esc(d.at || '09:00')}">` : ''}
    <select class="mini" data-lp-sched="model" title="Model for the audit">${[['', `Default (${d.defaultModel})`], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['fable', 'Fable']].map(([k, v]) => `<option value="${k}"${k === (d.model || '') ? ' selected' : ''}>${v}</option>`).join('')}</select>
    ${d.nextAt && every !== 'off' ? `<span class="hint" style="margin:0">next ${esc(new Date(d.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` : ''}
  </div>`;
}

function renderLoops() {
  const el = $('#loops');
  if (!el) return;
  const gid = S.gameId;
  const d = LOOPS.data[gid];
  if (!d) { el.innerHTML = '<p class="hint">Reading the loops…</p>'; if (!LOOPS.loading[gid]) loadLoops(gid); return; }
  // Keep what's being typed, and where the focus is, across re-renders.
  const drafts = Object.fromEntries($$('[data-lp-keep]', el).map((x) => [x.dataset.lpKeep, x.value]));
  const focus = document.activeElement?.dataset?.lpKeep || document.activeElement?.dataset?.lpNum;
  const scroll = el.scrollTop;
  const live = d.loops.filter((l) => !l.retired);
  const status = d.running ? `<span class="pill running">Auditing… ${esc(ago(d.startedAt))}</span>`
    : d.status === 'error' ? `<span class="pill error" title="${esc(d.error)}">Last audit failed</span>`
      : d.lastRunAt ? `<span class="hint" style="margin:0">Audited ${esc(ago(d.lastRunAt))}${d.lastModel ? ` · ${esc(d.lastModel)}` : ''}</span>` : '';
  el.innerHTML = `
    <div class="row pf-top"><h2 class="grow" style="margin:0">Gameplay Loop</h2>${status}
      <button class="primary small" data-lp="audit"${d.running ? ' disabled' : ''}>${d.lastRunAt ? 'Audit again' : 'Audit the loops'}</button></div>
    <p class="hint">A loop is a readable question with an uncertain answer, asked at several time scales, where every answer changes what the player knows or wants. Each loop is scored on six tests, modelled from the code so you can tune it here, and checked against playtests and your reviews. <b>Lock In Changes</b> turns your tuning and decisions into board tasks.</p>
    ${lpSchedule(d)}
    ${d.status === 'error' && d.error ? `<div class="card lp-err">${esc(d.error)}</div>` : ''}
    ${live.length ? lpOverview(d) : `<div class="card"><p style="margin:0">No audit yet. <b>Audit the loops</b> reads the GDD, the code, your playtest notes and reviews, and finds the game's loops across moment, encounter, session and meta time scales. It takes a few minutes.</p></div>`}
    <div id="lp-lockbar">${lpLockBar(d)}</div>
    ${d.loops.map((l) => lpSection(d, l)).join('')}`;
  for (const [k, v] of Object.entries(drafts)) { const x = $(`[data-lp-keep="${CSS.escape(k)}"]`, el); if (x) x.value = v; }
  if (focus) $(`[data-lp-keep="${CSS.escape(focus)}"], [data-lp-num="${CSS.escape(focus)}"]`, el)?.focus();
  el.scrollTop = scroll;
  for (const l of d.loops) lpDraw(l);
  for (const t of $$('.lp-thread', el)) t.scrollTop = t.scrollHeight;
}

const LP_VERDICT = { coherent: ['success', 'The loop holds together'], strained: ['warn', 'The loop is strained'], broken: ['error', 'The loop is broken'] };
const LP_KIND = { playtest: 'Play it', tune: 'Tune', design: 'Design', park: 'Park' };
const LP_PRIORITY = { now: 'Now', next: 'Next', later: 'Later' };

function lpChain(chain) {
  return String(chain || '').split(/\s*(?:→|->)\s*/).filter(Boolean).map((step) => {
    const m = step.match(/\(\s*weak(?:\s*[:,-]\s*([^)]*))?\)/i);
    const text = step.replace(/\s*\(\s*weak[^)]*\)\s*/i, ' ').trim();
    return m ? `<span class="lp-step weak" title="Weak link${m[1] ? `: ${esc(m[1])}` : ''}">${esc(text)}${m[1] ? `<small>${esc(m[1])}</small>` : ''}</span>` : `<span class="lp-step">${esc(text)}</span>`;
  }).join('<span class="lp-to">→</span>');
}

function lpAction(d, a, i) {
  const loop = d.loops.find((l) => l.id === a.loopId);
  const st = a.state;
  const btns = st ? `<span class="hint" style="margin:0">${st === 'queued' ? 'Queued for Lock In' : st === 'locked' ? `On the board: ${(a.tasks || []).map((t) => `#${t}${d.tasks[t] ? ` (${esc(d.tasks[t].status)})` : ''}`).join(', ') || 'locked in'}` : st === 'done' ? 'Done' : 'Set aside'}</span>${st === 'locked' ? '' : `<a href="#" class="lp-x" data-lp="act" data-do="restore" data-action="${esc(a.id)}">undo</a>`}`
    : `${a.values?.length ? `<button class="ghost small" data-lp="act-try" data-action="${esc(a.id)}">Try on the sliders</button>` : ''}
       ${a.kind === 'playtest' ? `<button class="ghost small" data-lp="act" data-do="done" data-action="${esc(a.id)}">I played it</button>` : ''}
       <button class="${a.kind === 'playtest' ? 'ghost' : 'primary'} small" data-lp="act" data-do="adopt" data-action="${esc(a.id)}" title="Queue it for Lock In Changes, which turns it into board tasks">${a.kind === 'playtest' ? 'Have the team prep it' : a.kind === 'park' ? 'Queue: park it' : 'Queue for Lock In'}</button>
       <a href="#" class="lp-x" data-lp="act" data-do="dismiss" data-action="${esc(a.id)}" title="Set it aside">✕</a>`;
  return `<li class="lp-act${st ? ` is-${st}` : ''}">
    <span class="lp-n">${i + 1}</span>
    <div class="grow">
      <div class="row" style="gap:6px;flex-wrap:wrap"><span class="lp-prio p-${a.priority}">${LP_PRIORITY[a.priority]}</span><span class="lp-kind">${LP_KIND[a.kind]}</span><b>${esc(a.title)}</b></div>
      <div class="lp-actwhy">${lpText(a.why)}${loop ? ` <a href="#" class="lp-loopref" data-lp="goto" data-loop="${esc(loop.id)}">${esc(loop.name)}</a>` : ''}</div>
    </div>
    <div class="lp-actbtns">${btns}</div>
  </li>`;
}

function lpOverview(d) {
  const live = d.loops.filter((l) => !l.retired);
  const c = d.coherence;
  const verdict = c && LP_VERDICT[c.verdict];
  const name = (id) => d.loops.find((l) => l.id === id)?.name || '';
  const weakest = (l) => { const m = Math.min(...l.stages.map((s) => s.score)); return l.stages.filter((s) => s.score === m).map((s) => d.stages.find((x) => x.id === s.stage)?.name).join(', '); };
  const f = d.focus;
  return `
    ${c ? `<div class="card lp-verdict v-${esc(c.verdict)}">
      <div class="row" style="gap:10px;align-items:flex-start"><span class="pill ${verdict[0]}">${verdict[1]}</span><b class="grow lp-headline">${lpText(c.headline)}</b></div>
      ${c.chain ? `<div class="lp-chainrow"><span class="hint" style="margin:0">The loop today</span><div class="lp-chain">${lpChain(c.chain)}</div></div>` : ''}
      ${c.breaks?.length ? `<div class="lp-breaks">${c.breaks.map((b) => `<div class="lp-break"><b>${lpText(b.problem)}</b><span>${lpText(b.fix)}</span>${b.loopId ? `<a href="#" class="lp-loopref" data-lp="goto" data-loop="${esc(b.loopId)}">${esc(name(b.loopId))}</a>` : ''}</div>`).join('')}</div>` : ''}
      ${c.changes ? `<p class="hint" style="margin:10px 0 0"><b>Recent mechanic changes:</b> ${lpText(c.changes)}</p>` : ''}
    </div>` : live.length ? `<div class="card lp-summary"><p style="margin:0 0 8px">${lpText(d.summary)}</p><button class="primary small" data-lp="digest"${d.digesting ? ' disabled' : ''}>${d.digesting ? 'Rewriting…' : 'Rewrite as a verdict and actions'}</button> <span class="hint" style="margin:0;display:inline">Quick: Sonnet, from what this audit already found.</span></div>` : ''}

    ${d.actions?.length ? `<div class="card"><h4 class="sub-h" style="margin-top:0">What to do</h4><p class="hint lp-sub">Ranked across all loops. Queued items become board tasks when you press Lock In Changes.</p><ol class="lp-acts">${d.actions.map((a, i) => lpAction(d, a, i)).join('')}</ol></div>` : ''}

    <div class="card"><h4 class="sub-h" style="margin-top:0">Loops</h4><p class="hint lp-sub">Open one to see its tests, tune it, or ask about it.</p>
      <table class="lp-table"><thead><tr><th>Loop</th><th>Time scale</th><th>Health</th><th>Weakest test</th></tr></thead><tbody>
      ${live.map((l) => `<tr data-lp="goto" data-loop="${esc(l.id)}"><td><b>${esc(l.name)}</b>${l.core ? ' <span class="pill success">core</span>' : ''}<div class="hint" style="margin:0">${lpText(l.question)}</div></td><td>${esc(l.scale)}</td><td><span class="lp-hbar"><span style="width:${l.health || 0}%"></span></span> ${l.health ?? '–'}%</td><td>${esc(weakest(l))}</td></tr>`).join('')}
      </tbody></table>
      ${d.core ? `<details class="lp-coredet"><summary class="hint">The core skill, skill curve and retention</summary><dl class="lp-core"><dt>Skill</dt><dd>${lpText(d.core.skill)}</dd><dt>Skill curve</dt><dd>${lpText(d.core.skillCurve)}</dd><dt>Retention</dt><dd>${lpText(d.core.retention)}</dd>${d.core.drift ? `<dt>Coherence risk</dt><dd>${lpText(d.core.drift)}</dd>` : ''}</dl></details>` : ''}
    </div>

    ${f ? `<details class="card lp-focusdet"><summary><b>Ticket focus</b> <span class="hint" style="margin:0;display:inline">· ${f.onLoop ?? '–'}% of non-groundwork tickets fed a loop · ${f.support.length} groundwork · ${f.off.length} fed no loop</span></summary>
      <p class="hint lp-sub" style="margin-top:8px">Changing mechanics is expected. This only shows where effort went, so systems that feed no loop are easy to spot.</p>
      ${lpFocusBars(d)}${lpHistory(d)}
      ${f.off.length ? `<h4 class="sub-h">Fed no loop</h4><ul class="lp-off">${f.off.map((o) => `<li><b>#${o.num}</b> ${esc(d.tasks[o.num]?.title || o.title)} <span class="hint" style="margin:0;display:inline">· ${esc(d.tasks[o.num]?.status || o.status)} · ${esc(o.why)}</span></li>`).join('')}</ul>` : ''}
    </details>` : ''}`;
}

function lpFocusBars(d) {
  const f = d.focus;
  const live = d.loops.filter((l) => !l.retired);
  const counts = live.map((l) => ({ l, n: (f.byLoop.find((b) => b.loopId === l.id)?.nums || []).length }));
  const max = Math.max(1, ...counts.map((x) => x.n), f.support.length, f.off.length);
  const bar = (label, n, cls) => `<div class="lp-fbar"><span class="lp-flabel">${label}</span><span class="lp-ftrack"><span class="lp-ffill ${cls}" style="width:${(n / max) * 100}%"></span></span><b>${n}</b></div>`;
  return counts.map(({ l, n }) => bar(esc(l.name), n, l.core ? 'core' : '')).join('') + bar('Groundwork', f.support.length, 'support') + bar('No loop', f.off.length, 'off');
}

// On-loop share and each loop's health across audits.
function lpHistory(d) {
  const h = (d.history || []).filter((x) => x.onLoop != null);
  if (h.length < 2) return '<p class="hint" style="margin:8px 0 0">The trend shows here from the second audit on.</p>';
  const w = 360, ht = 90, m = { l: 28, r: 8, t: 8, b: 18 };
  const x = (i) => m.l + (i / (h.length - 1)) * (w - m.l - m.r);
  const y = (v) => m.t + (1 - v / 100) * (ht - m.t - m.b);
  const line = (key, color, dash = '') => `<path d="${h.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key] ?? 0).toFixed(1)}`).join('')}" fill="none" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  return `<svg viewBox="0 0 ${w} ${ht}" class="lp-trend" role="img" aria-label="Share of work on the loops across audits">
    ${[0, 50, 100].map((v) => `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}" class="lp-grid"/><text x="${m.l - 4}" y="${y(v) + 3}" class="lp-tick" text-anchor="end">${v}%</text>`).join('')}
    ${line('onLoop', 'var(--blue)')}${line('core', 'var(--accent)', '4 3')}
    ${h.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.onLoop)}" r="3" fill="var(--blue)"><title>${new Date(p.at).toLocaleDateString()}: ${p.onLoop}% on a loop, ${p.core}% core</title></circle>`).join('')}
  </svg><div class="lp-legend"><span><i style="background:var(--blue)"></i>on a loop</span><span><i class="dash" style="border-color:var(--accent)"></i>core loops</span></div>`;
}

function lpLockBar(d) {
  const pend = (d.loops || []).map((l) => ({ l, p: l.params.filter(lpChanged).length, n: (l.pending || []).length })).filter((x) => x.p || x.n);
  const params = pend.reduce((s, x) => s + x.p, 0);
  const notes = pend.reduce((s, x) => s + x.n, 0);
  const lk = d.lock || {};
  if (lk.status === 'running') return '<div class="lp-lock running"><span class="pill running">Locking in</span><span class="grow">Turning your changes into board tasks…</span></div>';
  const last = lk.status === 'done' ? `Last locked in ${esc(ago(lk.at))}: ${lk.tasks.map((t) => `#${t.num}`).join(', ') || 'nothing new'}.` : lk.status === 'error' ? `<span style="color:var(--red)">Lock-in failed: ${esc(lk.error)}</span>` : '';
  if (!params && !notes) return last ? `<div class="lp-lock idle"><span class="hint grow" style="margin:0">${last}</span></div>` : '';
  const parts = [params && `${params} slider change${params > 1 ? 's' : ''}`, notes && `${notes} decided change${notes > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
  return `<div class="lp-lock"><span class="grow"><b>${parts}</b> across ${pend.map((x) => esc(x.l.name)).join(', ')}, not on the board yet.${last ? ` <span class="hint" style="margin:0;display:inline">${last}</span>` : ''}</span>
    <button class="primary" data-lp="lock">Lock In Changes</button></div>`;
}

function lpSection(d, l) {
  const open = LOOPS.open.has(l.id);
  const stages = d.stages.map((s) => {
    const x = l.stages.find((y) => y.stage === s.id) || { score: 0, basis: 'assumption', finding: '' };
    return `<div class="lp-stage s${x.score}" title="${esc(s.test)}">
      <div class="row" style="gap:6px"><b class="grow">${esc(s.name)}</b><span class="lp-score">${'●'.repeat(x.score)}${'○'.repeat(3 - x.score)}</span></div>
      <span class="lp-basis">${LP_SCORE[x.score]} · ${esc(x.basis)}</span>
      <p>${lpText(x.finding)}</p>${x.fix ? `<p class="lp-fix">${lpText(x.fix)}</p>` : ''}</div>`;
  }).join('');
  const weakest = Math.min(...l.stages.map((s) => s.score));
  const asking = d.asking.includes(l.id);
  return `<section class="card lp-loop${l.retired ? ' retired' : ''}" id="lp-${esc(l.id)}" data-loop="${esc(l.id)}">
    <div class="lp-head" data-lp="toggle" data-loop="${esc(l.id)}">
      <span class="lp-caret">${open ? '▾' : '▸'}</span>
      <div class="grow"><div class="row" style="gap:8px;flex-wrap:wrap"><h3 style="margin:0">${esc(l.name)}</h3><span class="pill">${esc(l.scale)}</span>${l.core ? '<span class="pill success">core</span>' : ''}${l.retired ? '<span class="pill">no longer found by the audit</span>' : ''}</div>
        <div class="hint" style="margin:2px 0 0"><b>Skill:</b> ${lpText(l.skill)} · <b>Question:</b> ${lpText(l.question)}</div></div>
      <div class="lp-health" title="Mean of the six stage scores"><b>${l.health ?? '–'}%</b><span class="lp-hbar"><span style="width:${l.health || 0}%"></span></span></div>
    </div>
    ${open ? `
    ${l.description ? `<p class="lp-desc">${lpText(l.description)}</p>` : ''}
    <div class="lp-stages">${stages}</div>
    ${weakest <= 1 ? `<p class="hint">Weakest: ${l.stages.filter((s) => s.score === weakest).map((s) => esc(d.stages.find((x) => x.id === s.stage).name.toLowerCase())).join(', ')}. That's usually where the loop leaks.</p>` : ''}
    <div class="lp-model">
      <div class="lp-tune">
        <div class="row"><h4 class="sub-h grow" style="margin:0">Tune</h4>${l.params.some((p) => p.value !== p.base) ? `<a href="#" data-lp="reset-loop" data-loop="${esc(l.id)}">Back to the code's values</a>` : ''}</div>
        ${l.params.map((p) => lpSlider(l, p)).join('') || '<p class="hint">No tunable numbers found yet. Ask below for the ones you want.</p>'}
        <div class="lp-tiles" data-lp-tiles="${esc(l.id)}">${lpTiles(l)}</div>
      </div>
      <div class="lp-charts">${l.charts.map((c) => `<div class="lp-chart" data-chart="${esc(l.id)}|${esc(c.id)}">
          <div class="row" style="gap:6px"><b class="grow">${esc(c.title)}</b><a href="#" class="hint lp-x" data-lp="rm-chart" data-loop="${esc(l.id)}" data-chart="${esc(c.id)}" title="Remove this graph">✕</a></div>
          <div class="lp-plot" data-plot="${esc(l.id)}|${esc(c.id)}"></div>
          ${c.why ? `<p class="hint lp-why">${lpText(c.why)}</p>` : ''}</div>`).join('') || '<p class="hint">No graphs yet. Ask below for the one you want.</p>'}</div>
    </div>
    ${l.playtest?.length ? `<h4 class="sub-h">What playtests and reviews say</h4><div class="lp-evid">${l.playtest.map((p) => `<div><span class="lp-src">${esc(p.source)}</span><p><b>Says:</b> ${lpText(p.says)}</p><p><b>Reads as:</b> ${lpText(p.interpretation)}</p>${p.implication ? `<p><b>So:</b> ${lpText(p.implication)}</p>` : ''}</div>`).join('')}</div>` : ''}
    ${l.iterate?.length ? `<h4 class="sub-h">Next iterations</h4><ul class="lp-iter">${l.iterate.map((x, i) => `<li><b>${esc(x.title)}</b> <span class="hint" style="margin:0;display:inline">${lpText(x.why)}</span>
        <span class="lp-iter-acts">${x.values?.length ? `<button class="ghost small" data-lp="try" data-loop="${esc(l.id)}" data-idx="${i}" title="${esc(x.values.map((v) => `${l.params.find((p) => p.key === v.key)?.label || v.key} → ${v.value}`).join(', '))}">Try it on the sliders</button>` : ''}<button class="ghost small" data-lp="adopt" data-loop="${esc(l.id)}" data-idx="${i}">Add to changes</button></span></li>`).join('')}</ul>` : ''}
    <h4 class="sub-h">Changes to lock in</h4>
    ${(l.pending || []).length ? `<ul class="lp-pending">${l.pending.map((n) => `<li>${lpText(n.text)} <span class="hint" style="margin:0;display:inline">· ${n.from === 'chat' ? 'from the conversation' : n.from === 'action' ? 'from the audit' : n.from === 'suggestion' ? 'from a suggestion' : 'yours'}</span> <a href="#" class="lp-x" data-lp="drop-change" data-loop="${esc(l.id)}" data-change="${esc(n.id)}" title="Drop it">✕</a></li>`).join('')}</ul>` : ''}
    <form class="lp-addchange" data-lp-form="change" data-loop="${esc(l.id)}"><input data-lp-keep="chg-${esc(l.id)}" placeholder="A design change for this loop, e.g. Show the wind before the swing, not after" autocomplete="off"><button class="ghost small">Add</button></form>
    ${(l.locked || []).length ? `<details class="lp-locked"><summary class="hint">Locked in before (${l.locked.length})</summary><ul>${l.locked.slice().reverse().map((n) => `<li>${lpText(n.text)} → ${n.tasks.map((t) => `#${t}${d.tasks[t] ? ` (${esc(d.tasks[t].status)})` : ''}`).join(', ') || 'no task'}</li>`).join('')}</ul></details>` : ''}
    <h4 class="sub-h">Ask about this loop</h4><p class="hint lp-sub">Answers can add sliders and graphs, or move them.</p>
    <div class="lp-thread">${(l.chat || []).map(lpMsg).join('') || '<p class="hint" style="margin:0">e.g. "How does the hole length change how many shots a new player needs?" or "Show me how often a mid player nearly wins a duel."</p>'}</div>
    <form class="lp-ask" data-lp-form="ask" data-loop="${esc(l.id)}"><textarea rows="2" data-lp-keep="ask-${esc(l.id)}" placeholder="Ask about ${esc(l.name)}…"${asking ? ' disabled' : ''}></textarea><button class="primary small"${asking ? ' disabled' : ''}>${asking ? 'Thinking…' : 'Ask'}</button></form>` : ''}
  </section>`;
}

function lpMsg(m) {
  if (m.role === 'director') return `<div class="lp-msg me"><p>${lpText(m.text).replace(/\n/g, '<br>')}</p></div>`;
  if (m.status === 'thinking') return '<div class="lp-msg"><p class="hint" style="margin:0">Reading the code and working it out…</p></div>';
  return `<div class="lp-msg${m.status === 'error' ? ' err' : ''}">${m.status === 'error' ? `<p>${esc(m.text)}</p>` : md(m.text)}${m.did?.length ? `<p class="lp-did">${esc(m.did.join(' · '))}</p>` : ''}</div>`;
}

function lpSlider(l, p) {
  const changed = p.value !== p.base;
  const id = `${l.id}|${p.key}`;
  const pos = ((p.base - p.min) / (p.max - p.min || 1)) * 100;
  return `<div class="lp-param${changed ? ' changed' : ''}">
    <div class="row" style="gap:6px"><label class="grow" for="lp-r-${esc(id)}">${esc(p.label)}</label>
      <input class="mini lp-numin" type="number" step="${p.step}" min="${p.min}" max="${p.max}" value="${p.value}" data-lp-num="${esc(id)}">${p.unit ? `<span class="hint" style="margin:0">${esc(p.unit)}</span>` : ''}
      ${changed ? `<a href="#" class="lp-x" data-lp="reset-param" data-loop="${esc(l.id)}" data-key="${esc(p.key)}" title="Back to the code's value">↺</a>` : ''}</div>
    <div class="lp-range"><input type="range" id="lp-r-${esc(id)}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.value}" data-lp-range="${esc(id)}"><span class="lp-basemark" style="left:${pos}%" title="In the code: ${lpNum(p.base, p.step)}"></span></div>
    <div class="lp-pmeta"><span>code: ${lpNum(p.base, p.step)}${changed ? ` → <b>${lpNum(p.value, p.step)}</b>` : ''}</span>${p.locked ? `<span class="pill success" title="Locked in ${esc(new Date(p.locked.at).toLocaleString())}">locked → ${p.locked.tasks.map((t) => `#${t}`).join(', ') || lpNum(p.locked.value, p.step)}</span>` : ''}${p.source ? `<code title="${esc(p.source)}">${esc(p.source.split(/[\\/]/).pop())}</code>` : ''}</div>
    ${p.affects ? `<div class="hint lp-affects">${lpText(p.affects)}</div>` : ''}
  </div>`;
}

function lpTiles(l) {
  const base = LoopMath.scope(l.params, 'base');
  const draft = LoopMath.scope(l.params, 'draft');
  return (l.tiles || []).map((t) => {
    const b = LoopMath.value(t.expr, base);
    const v = LoopMath.value(t.expr, draft);
    const has = t.targetMin != null || t.targetMax != null;
    const ok = v != null && (t.targetMin == null || v >= t.targetMin) && (t.targetMax == null || v <= t.targetMax);
    return `<div class="lp-tile${has ? (ok ? ' ok' : ' out') : ''}" title="${esc(t.why || '')}${has ? `\nTarget: ${t.targetMin ?? '…'} to ${t.targetMax ?? '…'}` : ''}">
      <span class="hint" style="margin:0">${esc(t.label)}</span><b>${lpNum(v)}${t.unit ? ` <small>${esc(t.unit)}</small>` : ''}</b>
      <span class="hint" style="margin:0">${b !== v ? `code: ${lpNum(b)} · ` : ''}${has ? `${ok ? '✓' : '✗'} target ${t.targetMin ?? '…'}–${t.targetMax ?? '…'}` : ''}</span></div>`;
  }).join('');
}

// One graph: the director's values solid, the code's values dashed (only where they differ).
function lpChartSvg(l, c) {
  const W = 480, H = 220, m = { l: 46, r: 12, t: 12, b: 36 };
  const base = LoopMath.scope(l.params, 'base');
  const draft = LoopMath.scope(l.params, 'draft');
  const uses = new Set(c.series.flatMap((s) => { try { return LoopMath.compile(s.expr).uses; } catch { return []; } }));
  const changed = l.params.some((p) => p.value !== p.base && uses.has(p.key));
  const lines = c.series.map((s, i) => ({ s, color: LP_COLORS[i % 4], draft: LoopMath.sample(s.expr, draft, c.xMin, c.xMax), base: changed ? LoopMath.sample(s.expr, base, c.xMin, c.xMax) : null }));
  const ys = lines.flatMap((x) => [...x.draft, ...(x.base || [])].map((p) => p[1]).filter((v) => v != null));
  let y0 = c.yMin ?? Math.min(0, ...ys), y1 = c.yMax ?? Math.max(...ys, c.bandTo ?? -Infinity);
  if (!ys.length) return '<p class="hint">This formula gives no numbers at these values.</p>';
  if (c.yMin == null && Math.min(...ys) > 0 && Math.min(...ys) > (y1 - Math.min(...ys)) * 2) y0 = Math.min(...ys) * 0.9;
  if (!(y1 > y0)) y1 = y0 + 1;
  if (c.yMax == null) y1 += (y1 - y0) * 0.06;
  const X = (v) => m.l + ((v - c.xMin) / (c.xMax - c.xMin)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (Math.min(y1, Math.max(y0, v)) - y0) / (y1 - y0)) * (H - m.t - m.b);
  const path = (pts) => { let d = '', pen = false; for (const [x, y] of pts) { if (y == null) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`; pen = true; } return d; };
  const ticks = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  LOOPS.pts[`${l.id}|${c.id}`] = { lines, X, Y, m, W, H, c };
  return `<svg viewBox="0 0 ${W} ${H}" class="lp-svg" role="img" aria-label="${esc(c.title)}">
    ${c.bandFrom != null ? `<rect x="${m.l}" width="${W - m.l - m.r}" y="${Y(c.bandTo)}" height="${Math.max(0, Y(c.bandFrom) - Y(c.bandTo))}" class="lp-band"/><text x="${W - m.r - 4}" y="${Y(c.bandTo) + 12}" text-anchor="end" class="lp-bandlabel">${esc(c.bandLabel || '')}</text>` : ''}
    ${ticks(y0, y1, 4).map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="lp-grid"/><text x="${m.l - 6}" y="${Y(v) + 3}" text-anchor="end" class="lp-tick">${lpNum(v)}</text>`).join('')}
    ${ticks(c.xMin, c.xMax, 5).map((v) => `<text x="${X(v)}" y="${H - m.b + 14}" text-anchor="middle" class="lp-tick">${lpNum(v)}</text>`).join('')}
    <text x="${(m.l + W - m.r) / 2}" y="${H - 4}" text-anchor="middle" class="lp-axis">${esc(c.xLabel)}</text>
    <text transform="translate(11 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle" class="lp-axis">${esc(c.yLabel)}</text>
    ${lines.map((x) => (x.base ? `<path d="${path(x.base)}" fill="none" stroke="${x.color}" stroke-width="1.5" stroke-dasharray="5 4" opacity=".55"/>` : '')).join('')}
    ${lines.map((x) => `<path d="${path(x.draft)}" fill="none" stroke="${x.color}" stroke-width="2" stroke-linejoin="round"/>`).join('')}
    <g class="lp-hover" style="display:none"><line class="lp-cross" y1="${m.t}" y2="${H - m.b}"/>${lines.map((x) => `<circle r="4" fill="${x.color}" stroke="var(--panel)" stroke-width="2"/>`).join('')}</g>
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" class="lp-hit"/>
  </svg>
  <div class="lp-legend">${lines.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.s.label)}</span>`).join('')}${changed ? '<span><i class="dash" style="border-color:var(--muted)"></i>the code today</span>' : ''}</div>
  <div class="lp-tip" hidden></div>`;
}

function lpDraw(l) {
  for (const c of l.charts) { const box = $(`[data-plot="${CSS.escape(`${l.id}|${c.id}`)}"]`); if (box) box.innerHTML = lpChartSvg(l, c); }
  const tiles = $(`[data-lp-tiles="${CSS.escape(l.id)}"]`);
  if (tiles) tiles.innerHTML = lpTiles(l);
}

// A slider moved: graphs and numbers follow at once; the value is saved when the slider is let go.
function lpSet(id, value, { save = false } = {}) {
  const [lid, key] = id.split('|');
  const l = lpLoop(lid);
  const p = l?.params.find((x) => x.key === key);
  if (!p || !Number.isFinite(value)) return;
  p.value = Math.min(p.max, Math.max(p.min, value));
  const num = $(`[data-lp-num="${CSS.escape(id)}"]`);
  if (num && document.activeElement !== num) num.value = p.value;
  const rng = $(`[data-lp-range="${CSS.escape(id)}"]`);
  if (rng && document.activeElement !== rng) rng.value = p.value;
  const row = rng?.closest('.lp-param');
  if (row) {
    row.classList.toggle('changed', p.value !== p.base);
    const meta = $('.lp-pmeta span', row);
    if (meta) meta.innerHTML = `code: ${lpNum(p.base, p.step)}${p.value !== p.base ? ` → <b>${lpNum(p.value, p.step)}</b>` : ''}`;
  }
  lpDraw(l);
  $('#lp-lockbar').innerHTML = lpLockBar(LOOPS.data[S.gameId]);
  if (save) lpSave(lid);
}

function lpSave(lid) {
  const gid = S.gameId;
  clearTimeout(LOOPS.timers[lid]);
  LOOPS.timers[lid] = setTimeout(async () => {
    const l = lpLoop(lid);
    if (!l) return;
    try { await api('PATCH', `/api/games/${gid}/loops/${encodeURIComponent(lid)}/params`, { values: Object.fromEntries(l.params.map((p) => [p.key, p.value])) }); } catch (err) { fail(err); }
  }, 350);
}

function lpHover(e) {
  const svg = e.target.closest('.lp-svg');
  const box = svg?.closest('.lp-plot');
  if (!box) return;
  const k = box.dataset.plot;
  const g = LOOPS.pts[k];
  const hov = $('.lp-hover', svg);
  const tip = $('.lp-tip', box);
  if (!g || e.type === 'mouseleave') { if (hov) hov.style.display = 'none'; if (tip) tip.hidden = true; return; }
  const r = svg.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * g.W;
  const n = g.lines[0].draft.length - 1;
  const i = Math.round(Math.min(1, Math.max(0, (px - g.m.l) / (g.W - g.m.l - g.m.r))) * n);
  const xv = g.lines[0].draft[i][0];
  hov.style.display = '';
  const cross = $('.lp-cross', hov);
  cross.setAttribute('x1', g.X(xv)); cross.setAttribute('x2', g.X(xv));
  $$('circle', hov).forEach((dot, j) => { const y = g.lines[j].draft[i][1]; dot.style.display = y == null ? 'none' : ''; if (y != null) { dot.setAttribute('cx', g.X(xv)); dot.setAttribute('cy', g.Y(y)); } });
  tip.hidden = false;
  tip.innerHTML = `<b>${esc(g.c.xLabel)}: ${lpNum(xv)}</b>${g.lines.map((x) => `<div><i style="background:${x.color}"></i>${esc(x.s.label)}: <b>${lpNum(x.draft[i][1])}</b>${x.base && x.base[i][1] !== x.draft[i][1] ? ` <span class="hint" style="margin:0;display:inline">(code ${lpNum(x.base[i][1])})</span>` : ''}</div>`).join('')}`;
  const left = ((g.X(xv) / g.W) * box.clientWidth);
  tip.style.left = `${Math.min(box.clientWidth - tip.offsetWidth - 4, Math.max(4, left + 12))}px`;
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset?.lpRange) { LOOPS.dragging = true; lpSet(t.dataset.lpRange, Number(t.value)); }
  else if (t.dataset?.lpNum && t.value !== '') lpSet(t.dataset.lpNum, Number(t.value));
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset?.lpRange || t.dataset?.lpNum) {
    lpSet(t.dataset.lpRange || t.dataset.lpNum, Number(t.value), { save: true });
    LOOPS.dragging = false;
    if (LOOPS.stale) { LOOPS.stale = false; loopsChanged(S.gameId); }
  }
  if (t.dataset?.lpSched) {
    const v = t.dataset.lpSched === 'day' ? Number(t.value) : t.value;
    api('PATCH', `/api/games/${S.gameId}/loops/schedule`, { [t.dataset.lpSched]: v }).then((d) => { LOOPS.data[S.gameId] = d; renderLoops(); }).catch(fail);
  }
});
document.addEventListener('pointerup', () => { if (LOOPS.dragging) setTimeout(() => { LOOPS.dragging = false; if (LOOPS.stale) { LOOPS.stale = false; loopsChanged(S.gameId); } }, 50); });
document.addEventListener('mousemove', (e) => { if (S.tab === 'loops' && e.target.closest?.('.lp-svg')) lpHover(e); });
document.addEventListener('mouseout', (e) => { if (S.tab === 'loops' && e.target.classList?.contains('lp-hit') && !e.relatedTarget?.closest?.('.lp-svg')) lpHover({ ...e, type: 'mouseleave', target: e.target }); });

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-lp]');
  if (!el || !$('#loops')?.contains(el)) return;
  if (el.dataset.lp === 'toggle' && e.target.closest('a, button, input')) return;
  if (el.dataset.lp === 'goto' && el.tagName === 'TR' && e.target.closest('a, button')) return;
  e.preventDefault();
  const gid = S.gameId;
  const lid = el.dataset.loop;
  const base = `/api/games/${gid}/loops`;
  try {
    switch (el.dataset.lp) {
      case 'audit': LOOPS.data[gid] = await api('POST', `${base}/audit`); renderLoops(); toast('Auditing the loops. It takes a few minutes; the result also goes to the Feed.'); break;
      case 'lock': await api('POST', `${base}/lock`); toast('Locking in: the tasks land on the board in a minute.'); break;
      case 'toggle': LOOPS.open.has(lid) ? LOOPS.open.delete(lid) : LOOPS.open.add(lid); renderLoops(); break;
      case 'goto': LOOPS.open.add(lid); renderLoops(); $(`#lp-${CSS.escape(lid)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
      case 'digest': LOOPS.data[gid].digesting = true; renderLoops(); try { LOOPS.data[gid] = await api('POST', `${base}/digest`); } finally { if (LOOPS.data[gid]) delete LOOPS.data[gid].digesting; renderLoops(); } break;
      case 'act': await api('POST', `${base}/actions/${encodeURIComponent(el.dataset.action)}`, { do: el.dataset.do }); break;
      case 'act-try': {
        const a = LOOPS.data[gid].actions.find((x) => x.id === el.dataset.action);
        const l = lpLoop(a.loopId);
        for (const v of a.values || []) { const p = l?.params.find((x) => x.key === v.key); if (p) p.value = Math.min(p.max, Math.max(p.min, v.value)); }
        LOOPS.open.add(a.loopId); renderLoops(); lpSave(a.loopId);
        $(`#lp-${CSS.escape(a.loopId)} .lp-model`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('Sliders moved: the solid lines are the change, the dashed ones the code today.');
        break;
      }
      case 'reset-param': { const p = lpLoop(lid)?.params.find((x) => x.key === el.dataset.key); if (p) { lpSet(`${lid}|${p.key}`, p.base, { save: true }); renderLoops(); } break; }
      case 'reset-loop': await api('PATCH', `${base}/${encodeURIComponent(lid)}/params`, { reset: true }); for (const p of lpLoop(lid).params) p.value = p.base; renderLoops(); break;
      case 'try': {
        const l = lpLoop(lid);
        for (const v of l.iterate[Number(el.dataset.idx)].values || []) { const p = l.params.find((x) => x.key === v.key); if (p) p.value = Math.min(p.max, Math.max(p.min, v.value)); }
        renderLoops(); lpSave(lid); toast('Sliders moved: compare the solid lines with the dashed ones (the code today).');
        break;
      }
      case 'adopt': { const x = lpLoop(lid).iterate[Number(el.dataset.idx)]; await api('POST', `${base}/${encodeURIComponent(lid)}/changes`, { text: `${x.title}: ${x.why}` }); break; }
      case 'drop-change': await api('DELETE', `${base}/${encodeURIComponent(lid)}/changes/${encodeURIComponent(el.dataset.change)}`); break;
      case 'rm-chart': await api('DELETE', `${base}/${encodeURIComponent(lid)}/charts/${encodeURIComponent(el.dataset.chart)}`); break;
    }
  } catch (err) { fail(err); }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-lp-form]');
  if (!f) return;
  e.preventDefault();
  const field = $('input, textarea', f);
  const text = field.value.trim();
  if (!text) return;
  const lid = f.dataset.loop;
  field.value = ''; // before the request: the reply's re-render would otherwise keep the text
  try {
    if (f.dataset.lpForm === 'ask') await api('POST', `/api/games/${S.gameId}/loops/${encodeURIComponent(lid)}/chat`, { text });
    else await api('POST', `/api/games/${S.gameId}/loops/${encodeURIComponent(lid)}/changes`, { text });
  } catch (err) {
    const again = $(`[data-lp-keep="${CSS.escape(field.dataset.lpKeep)}"]`);
    if (again && !again.value) again.value = text;
    fail(err);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches?.('.lp-ask textarea')) { e.preventDefault(); e.target.form.requestSubmit(); }
});

// ---------------------------------------------------------------------------
// Work split with Jungle Studio, strict Jungle Engine mode, repo work, and spend per project
// (src/worksplit.mjs, /api/token-totals).

const SPLIT_ROWS = [['gameplay', 'Gameplay'], ['backend', 'Backend and tech'], ['art', 'Art'], ['audio', 'Audio'], ['other', 'Untagged']];
const needsRepair = (a) => !!(a.authBroken || (!a.loggedIn && a.email && !a.signedInAs));
const taskOwner = (g, t) => (t.repoWide ? 'ballast' : t.owner === 'jungle' || t.owner === 'ballast' ? t.owner : g?.split?.[t.discipline || 'other'] === 'jungle' ? 'jungle' : 'ballast');
const splitOn = (g) => SPLIT_ROWS.some(([k]) => g?.split?.[k] === 'jungle');
const repoKeyOf = (g) => { const gh = typeof g?.github === 'string' ? g.github : g?.github?.repo || g?.jungle?.repo; return (gh || g?.repoPath || '').toLowerCase().replace(/\\/g, '/').replace(/\.git$/, '') || null; };

function jungleSettings(g) {
  const sel = (k) => g.split?.[k] === 'jungle';
  return `<h3>Jungle Engine and Jungle Studio</h3>
    <p class="hint" style="margin-top:-4px">Split the work with Jungle Studio, and set how closely Ballast keeps to Jungle Engine's way of doing things.</p>
    <div class="field"><span class="field-label">Who does what</span>
      <div class="split-grid">${SPLIT_ROWS.map(([k, label]) => `<label class="split-row"><span>${label}</span><select name="split_${k}"><option value="ballast">Ballast</option><option value="jungle"${sel(k) ? ' selected' : ''}>Jungle Studio</option></select></label>`).join('')}</div>
      <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap"><button type="button" class="ghost small" data-act="split-preset" data-preset="code">Programming in Jungle Studio, art and audio in Ballast</button><button type="button" class="ghost small" data-act="split-preset" data-preset="none">Everything in Ballast</button></div>
      <small>Tickets for Jungle Studio stay on the board, marked, but no Ballast agent takes them. The Board tab gives you a brief to paste into Jungle Studio, and you mark them done when Jungle Studio has done them. Ballast's agents are told not to write that department's code beyond what their own work needs to load.</small></div>
    <div class="two">
      <label class="field"><span>Engine rules</span><select name="jungleMode"><option value="guided">Guided: follow the engine's docs, change what the work needs</option><option value="strict"${g.jungleMode === 'strict' ? ' selected' : ''}>Strict: the engine's way only, inside the game's folder</option></select>
        <small>Strict is for games set up with Jungle. Agents change only ${g.subdir ? `<code>${esc(g.subdir)}/</code>` : 'the game\'s own files'}, use the engine's documented APIs and Game Pack conventions, and ask you instead of building around the engine. Every finished pull request is checked; files changed outside the folder come back as a ticket to move or revert them. Repo work is exempt.</small></label>
      <label class="field"><span>Also allowed in strict mode</span><textarea name="jungleAllow" rows="3" placeholder="One path per line, e.g. apps/client/src/room.worker.ts">${esc((g.jungleAllow || []).join('\n'))}</textarea><small>Files or folders outside the game's folder that agents may still change.</small></label>
    </div>`;
}

function jungleBar(g) {
  const mine = tasksOf(g.id).filter((t) => ['open', 'blocked'].includes(t.status) && taskOwner(g, t) === 'jungle');
  const strict = g.jungleMode === 'strict' ? `<span class="pill js-strict" title="Agents stay inside ${esc(g.subdir || 'the game folder')} and work the engine's way; finished PRs are checked">Jungle strict</span>` : '';
  if (!splitOn(g) && !mine.length) return strict ? `<div class="js-bar">${strict}</div>` : '';
  const who = SPLIT_ROWS.filter(([k]) => g.split?.[k] === 'jungle').map(([, l]) => l.toLowerCase()).join(', ');
  return `<div class="js-bar">${strict}<span class="pill js-pill">Jungle Studio</span>
    <span class="grow">${who ? `Jungle Studio does ${esc(who)} on this game. ` : ''}<b>${mine.length}</b> ticket${mine.length === 1 ? '' : 's'} waiting for it.</span>
    ${mine.length ? `<button class="ghost small" data-act="jungle-brief" data-id="${g.id}" title="Copy every Jungle Studio ticket as one brief">Copy brief for Jungle Studio</button>` : ''}</div>`;
}

function ownerPill(g, t) {
  if (t.repoWide) return '<span class="pill js-repo" title="Repo-wide maintenance: any game\'s agents in this repo can take it">repo-wide</span>';
  return ['open', 'blocked', 'claimed'].includes(t.status) && taskOwner(g, t) === 'jungle' ? '<span class="pill js-pill">Jungle Studio</span>' : '';
}

function ownerActs(g, t, status) {
  if (status === 'done' || t.repoWide) return '';
  if (taskOwner(g, t) === 'jungle') return `<button class="primary small" data-act="task-owner" data-id="${t.id}" data-owner="done-in-jungle">Done in Jungle Studio</button><button class="ghost small" data-act="task-owner" data-id="${t.id}" data-owner="ballast" title="Let Ballast's agents do this one">Ballast does it</button>`;
  return splitOn(g) && status === 'open' ? `<button class="ghost small" data-act="task-owner" data-id="${t.id}" data-owner="jungle">Send to Jungle Studio</button>` : '';
}

// --- Repo work (Studio)

function repoList() {
  const map = new Map();
  for (const g of S.st.games.filter((x) => statusOf(x) !== 'archived')) {
    const k = repoKeyOf(g);
    if (!k) continue;
    if (!map.has(k)) map.set(k, { key: k, games: [] });
    map.get(k).games.push(g);
  }
  return [...map.values()].sort((a, b) => b.games.length - a.games.length);
}

function repoWorkForm() {
  const repos = repoList();
  if (!repos.length) return '<p class="hint">No games with a repo yet.</p>';
  return `<form class="card" id="st-repo-form">
    <div class="row" style="gap:8px;flex-wrap:wrap"><label class="hint" style="margin:0">Repo</label><select name="repo">${repos.map((r) => `<option value="${esc(r.key)}">${esc(r.key)} · ${esc(r.games.map((g) => g.name).join(', '))}</option>`).join('')}</select></div>
    <textarea name="text" rows="3" placeholder="e.g. Unblock and resolve all the PR merge issues in the repo" style="margin-top:8px"></textarea>
    <div class="row" style="margin-top:8px"><span class="hint grow" style="margin:0">Becomes a high-priority [repo] ticket that any of the repo's game agents can take. It may touch any folder, so strict mode doesn't apply to it.</span><button class="primary small">Send</button></div>
  </form>`;
}

function renderRepoWork() {
  const el = $('#st-repo-list');
  if (!el) return;
  const list = S.st.tasks.filter((t) => t.repoWide).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  el.innerHTML = list.length ? `<div class="card"><table class="tbl"><thead><tr><th>Ticket</th><th>Status</th><th>On the board of</th><th>Who</th></tr></thead><tbody>
    ${list.map((t) => `<tr><td><b>#${t.num}</b> ${esc(t.title.replace(/^\[repo\]\s*/i, ''))}${t.pr ? ` <a href="${esc(t.pr)}" target="_blank" rel="noopener">PR</a>` : ''}</td><td><span class="pill ${t.status === 'done' ? 'success' : t.status === 'blocked' ? 'error' : t.status === 'claimed' ? 'running' : ''}">${esc(t.status)}</span></td>
      <td><span class="link" data-act="game" data-id="${t.gameId}">${esc(S.st.games.find((g) => g.id === t.gameId)?.name || '?')}</span></td><td>${esc(agentOf(t.claimedBy || t.doneBy)?.name || '–')}</td></tr>`).join('')}
  </tbody></table></div>` : '';
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'st-repo-form') return;
  e.preventDefault();
  const f = formData(e.target);
  if (!f.text.trim()) return;
  try {
    const t = await api('POST', '/api/repo-work', { repo: f.repo, text: f.text });
    e.target.text.value = '';
    toast(`Added #${t.num} (repo-wide). The first free agent in the repo takes it.`);
  } catch (err) { fail(err); }
});

// --- Spend per project

const TOKENS = { data: null, at: 0, loading: false };
const KIND_NAMES = { agent: 'local agent turns', ask: 'conversation mode', triage: 'note triage', unblock: 'blocked-ticket triage', ticket: 'ticket threads', 'gdd-review': 'GDD re-evaluation', 'level-audit': 'level audit', 'loop-audit': 'loop audit', 'loop-chat': 'loop questions', 'loop-lock': 'loop lock-in', 'loop-digest': 'loop rewrite', roadmap: 'roadmap breakdown', video: 'video reviews', 'jungle-docs': 'Jungle docs', audit: 'Bartle audit', sync: 'artifact sync', probe: 'limit checks', feedback: 'feedback checks', daily: 'daily update', settle: 'question settling' };
const acctWeeks = (pct) => (pct == null ? '–' : pct >= 100 ? `${(pct / 100).toFixed(1)} account-weeks` : `${pct}% of an account-week`);
const kindName = (k) => KIND_NAMES[k] || k.replace(/-/g, ' ');

async function loadTokens(force = false) {
  if (TOKENS.loading || (!force && TOKENS.data && Date.now() - TOKENS.at < 60e3)) return;
  TOKENS.loading = true;
  try { TOKENS.data = await api('GET', '/api/token-totals'); TOKENS.at = Date.now(); } catch (err) { console.error(err); }
  TOKENS.loading = false;
  if ($('#st-tokens')) $('#st-tokens').innerHTML = tokensTable();
  if (S.tab === 'budget' && $('#bd-tokens')) $('#bd-tokens').outerHTML = tokensSection(S.gameId);
}

function tokensTable() {
  const d = TOKENS.data;
  if (!d) { loadTokens(); return '<p class="hint">Adding up…</p>'; }
  loadTokens();
  const rows = [...d.games.filter((g) => g.all || g.cloudPct), d.housekeeping].filter((g) => g.all || g.cloudPct);
  const total = rows.reduce((n, g) => n + (g.all?.tokens || 0), 0);
  const cost = rows.reduce((n, g) => n + (g.all?.cost || 0), 0);
  return `<div class="pf-table-wrap"><table class="tbl tk-table"><thead><tr><th>Project</th><th>Tokens, all time</th><th>Input · output · cache</th><th>API-equivalent</th><th>Last 30 days</th><th title="Cloud sessions don't report tokens: estimated from account limit readings">Cloud agents (est.)</th><th>Biggest uses</th></tr></thead><tbody>
    ${rows.map((g) => `<tr${g.status === 'archived' ? ' class="archived"' : ''}><td>${g.id === '_none' ? esc(g.name) : `<span class="link" data-act="game" data-id="${g.id}">${esc(g.name)}</span>`}${g.status === 'archived' ? ' <span class="pill archived">archived</span>' : ''}</td>
      <td><b>${fmtTokens(g.all?.tokens || 0)}</b></td>
      <td class="hint" style="margin:0">${g.all ? `${fmtTokens(g.all.input)} · ${fmtTokens(g.all.output)} · ${fmtTokens(g.all.cacheRead + g.all.cacheWrite)}` : '–'}</td>
      <td>${g.all ? money(g.all.cost) : '–'}</td>
      <td>${g.month ? `${fmtTokens(g.month.tokens)} · ${money(g.month.cost)}` : '–'}</td>
      <td>${acctWeeks(g.cloudPct)}</td>
      <td class="hint" style="margin:0">${g.kinds.slice(0, 3).map((k) => `${esc(kindName(k.kind))} ${fmtTokens(k.tokens)}`).join(' · ')}</td></tr>`).join('')}
    <tr class="tk-total"><td><b>All projects</b></td><td><b>${fmtTokens(total)}</b></td><td></td><td><b>${money(cost)}</b></td><td></td><td></td><td></td></tr>
  </tbody></table></div>
  <p class="hint" style="margin:8px 0 0">Tokens are exact for every Claude run Ballast makes itself (triage, audits, conversation mode, reviews, local agent turns) since ${d.since ? esc(new Date(d.since).toLocaleDateString()) : 'it started recording'}. API-equivalent is what those tokens would cost on the API; on a subscription they come out of account limits instead. Cloud agent sessions don't report tokens to Ballast, so their work is estimated from account limit readings${d.cloudSince ? ` since ${esc(new Date(d.cloudSince).toLocaleDateString())}` : ''}, in account-weeks (one account's full weekly limit).</p>`;
}

function tokensSection(gid) {
  const d = TOKENS.data;
  if (!d) { loadTokens(); return '<div id="bd-tokens"><h3 class="pf-h">Token spend</h3><p class="hint">Adding up…</p></div>'; }
  const g = d.games.find((x) => x.id === gid);
  if (!g) return '<div id="bd-tokens"></div>';
  return `<div id="bd-tokens"><h3 class="pf-h">Token spend <span class="hint">all time, every Claude run Ballast made for this game</span></h3>
    <div class="bd-tiles">
      ${tile('Tokens, all time', fmtTokens(g.all?.tokens || 0), g.all ? `${g.all.runs} runs since ${esc(new Date(g.since).toLocaleDateString())}` : 'none recorded')}
      ${tile('API-equivalent', g.all ? money(g.all.cost) : '–', 'what these tokens would cost on the API')}
      ${tile('Last 30 days', g.month ? fmtTokens(g.month.tokens) : '–', g.month ? money(g.month.cost) : '')}
      ${tile('Cloud agents (est.)', acctWeeks(g.cloudPct), 'all time, from limit readings: cloud sessions don\'t report tokens')}
    </div>
    ${g.kinds.length ? `<div class="card"><div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>What</th><th>Runs</th><th>Tokens</th><th>Input · output · cache</th><th>API-equivalent</th></tr></thead><tbody>
      ${g.kinds.map((k) => `<tr><td>${esc(kindName(k.kind))}</td><td>${k.runs}</td><td>${fmtTokens(k.tokens)}</td><td>${fmtTokens(k.input)} · ${fmtTokens(k.output)} · ${fmtTokens(k.cacheRead + k.cacheWrite)}</td><td>${money(k.cost)}</td></tr>`).join('')}
    </tbody></table></div></div>` : ''}</div>`;
}

// --- Director's Inbox: one column per project

function inboxColumns(open, human) {
  const games = S.st.games.filter((g) => statusOf(g) !== 'archived').sort((a, b) => (b.priority ?? 2) - (a.priority ?? 2) || a.name.localeCompare(b.name));
  const cols = [...games.map((g) => ({ id: g.id, name: g.name })), { id: null, name: 'Studio' }]
    .map((c) => ({ ...c, human: human.filter((i) => (i.gameId || null) === c.id), qs: open.filter((q) => (q.gameId || null) === c.id) }))
    .filter((c) => c.human.length || c.qs.length);
  return `<div class="ib-cols">${cols.map((c) => `<div class="ib-col">
    <div class="ib-head">${c.id ? `<b class="link" data-act="game" data-id="${c.id}">${esc(c.name)}</b>` : `<b>${esc(c.name)}</b>`}
      <span class="hint" style="margin:0">${[c.human.length && `${c.human.length} need${c.human.length === 1 ? 's' : ''} you`, c.qs.length && `${c.qs.length} question${c.qs.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span></div>
    ${c.human.map(interventionCard).join('')}${c.qs.map(questionCard).join('')}
  </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Sections: the GDD in sections, each held at a quality gate only the director passes, production
// gate sets that move many gates at once, and department focus (src/gates.mjs).

const SEC = { open: new Set() };
const GATE_NAMES = ['Greybox', 'Functional', 'Polished', 'Ship'];
const gateLabel = (n) => (n < 0 ? 'Hold' : `L${n} ${GATE_NAMES[n]}`);
const FOCUS_DEPTS = [['gameplay', 'Gameplay'], ['art', 'Art'], ['audio', 'Audio'], ['backend', 'Backend']];

function sectionHeld(g, r, t) {
  if (t.repoWide || !r?.gates?.on) return null;
  const f = t.featureId && r.features.find((x) => x.id === t.featureId);
  if (f) {
    if ((f.gate ?? -1) < 0) return 'section on hold';
    if (t.level != null && t.level > f.gate) return `L${t.level} work, gate is L${f.gate}`;
  }
  const fx = r.gates.focus?.[t.discipline || 'other'];
  if (fx?.mode === 'only' && fx.sections?.length && !fx.sections.includes(t.featureId)) return 'outside the department\'s focus';
  return null;
}

function renderSections() {
  const el = $('#sections');
  if (!el) return;
  if (el.contains(document.activeElement) && /TEXTAREA|SELECT|INPUT/.test(document.activeElement.tagName)) return; // don't disturb what you're editing
  if ($('#scheme-form', el)?.contains(document.activeElement)) return;
  const g = game();
  const r = S.st.roadmaps?.[g.id];
  if (!r?.features?.length) {
    el.innerHTML = `<h2 style="margin-top:0">Sections</h2>
      <p class="hint">Ballast reads the GDD and the code and splits the design into 8–25 sections, each with what Greybox, Functional, Polished and Ship mean for it. Then you set each section's gate. Choose how it's cut first.</p>
      ${schemeCard(g, r)}
      ${r?.error ? `<p style="color:var(--red)">${esc(r.error)}</p>` : ''}`;
    return;
  }
  const tasks = tasksOf(g.id);
  // Nothing this tab shows changed: leave the page alone (live updates come several times a second).
  const view = JSON.stringify([r, g.gyms, [...SEC.open], tasks.map((t) => [t.id, t.status, t.level, t.featureId, t.priority, t.title])]);
  if (el.dataset.view === view) return;
  el.dataset.view = view;
  const gs = r.gates || { on: false, sets: [], focus: {} };
  const name = (id) => r.features.find((f) => f.id === id)?.name || '?';
  el.innerHTML = `
    <div class="row pf-top"><h2 class="grow" style="margin:0">Sections</h2>
      ${gs.unlinked ? `<button class="ghost small" data-act="gates-sort"${gs.sorting ? ' disabled' : ''} title="Have Claude put open tickets without a section into the right one">${gs.sorting ? 'Sorting…' : `Sort ${gs.unlinked} ticket${gs.unlinked === 1 ? '' : 's'} into sections`}</button>` : ''}
      <label class="check" style="margin:0"><input type="checkbox" data-gates-on ${gs.on ? 'checked' : ''}><span>Production gates</span></label></div>
    <p class="hint">Each section is built up to its gate and no further. Tickets above a gate wait, and a section that meets its gate waits for you. Only you pass a gate${gs.on ? '' : ' <b>(gates are off: the roadmap\'s milestones drive the work)</b>'}. ${gs.held ? `<b>${gs.held}</b> ticket${gs.held === 1 ? ' is' : 's are'} waiting on a gate or a focus.` : ''}</p>

    ${schemeCard(g, r)}
    <div class="sec-top">
      <div class="card"><div class="row"><h4 class="sub-h grow" style="margin:0">Production gate sets</h4><button class="ghost small" data-act="gateset-edit">+ New gate set</button></div>
        <p class="hint lp-sub">A named set of section targets, e.g. "Vertical slice". Applying it moves every gate it lists at once.</p>
        ${gs.sets.length ? `<ol class="gs-list">${gs.sets.map((s, i) => `<li class="${s.id === gs.activeSet ? 'active' : ''}">
          <div class="grow"><b>${esc(s.name)}</b>${s.id === gs.activeSet ? ' <span class="pill success">applied</span>' : ''}
            <div class="hint" style="margin:0">${s.met} of ${s.of} sections at target · ${Object.entries(s.targets).slice(0, 6).map(([id, v]) => `${esc(name(id))} ${v < 0 ? 'hold' : `L${v}`}`).join(', ')}${Object.keys(s.targets).length > 6 ? ', …' : ''}</div>${s.note ? `<div class="hint" style="margin:0">${esc(s.note)}</div>` : ''}</div>
          <span class="gs-acts"><button class="${s.id !== gs.activeSet && (gs.sets.findIndex((x) => x.id === gs.activeSet) === i - 1 || (!gs.activeSet && i === 0)) ? 'primary' : 'ghost'} small" data-act="gateset-apply" data-id="${s.id}">Apply</button>
            <button class="icon-btn" data-act="gateset-move" data-id="${s.id}" data-dir="up" ${i === 0 ? 'disabled' : ''} title="Earlier">▲</button><button class="icon-btn" data-act="gateset-move" data-id="${s.id}" data-dir="down" ${i === gs.sets.length - 1 ? 'disabled' : ''} title="Later">▼</button>
            <button class="ghost small" data-act="gateset-edit" data-id="${s.id}">Edit</button><a href="#" class="lp-x" data-act="gateset-delete" data-id="${s.id}" title="Delete">✕</a></span></li>`).join('')}</ol>` : '<p class="hint">None yet. Start one from the gates you have now.</p>'}
      </div>
      <div class="card"><h4 class="sub-h" style="margin-top:0">Focus</h4><p class="hint lp-sub">Point a department at a few sections. <b>Only these</b> holds its other tickets; <b>These first</b> just orders them.</p>
        ${FOCUS_DEPTS.map(([d, label]) => { const fx = gs.focus?.[d] || { mode: 'off', sections: [] }; return `<div class="focus-row">
          <div class="row" style="gap:8px"><b style="min-width:76px">${label}</b><select class="mini" data-focus-mode="${d}">${[['off', 'No focus'], ['first', 'These first'], ['only', 'Only these']].map(([v, l]) => `<option value="${v}"${(fx.mode || 'off') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
          ${fx.mode && fx.mode !== 'off' ? `<div class="chip-row">${r.features.map((f) => `<button type="button" class="chip-btn${fx.sections?.includes(f.id) ? ' on' : ''}" data-focus-dept="${d}" data-focus-id="${f.id}">${esc(f.name)}</button>`).join('')}</div>` : ''}</div>`; }).join('')}
      </div>
    </div>

    <div class="sec-list">${r.features.map((f) => sectionCard(g, r, f, tasks)).join('')}</div>`;
}

function sectionCard(g, r, f, tasks) {
  const gate = f.gate ?? -1;
  const open = SEC.open.has(f.id);
  const mine = tasks.filter((t) => t.featureId === f.id && t.status !== 'done');
  const atGate = gate >= 0 && f.level >= gate;
  const building = mine.filter((t) => !sectionHeld(g, r, t)).length;
  const focusBy = FOCUS_DEPTS.filter(([d]) => r.gates?.focus?.[d]?.mode !== 'off' && r.gates?.focus?.[d]?.sections?.includes(f.id)).map(([, l]) => l);
  const gb = gymBits(g, f);
  const state = !r.gates?.on ? '' : gate < 0 ? '<span class="pill">on hold</span>'
    : atGate ? `<span class="pill warn" title="It meets its gate. Iterate on it, or pass it to the next level.">at its gate · your call</span>`
      : `<span class="pill running">building to L${gate}</span>`;
  return `<div class="card sec-card${atGate && r.gates?.on ? ' at-gate' : ''}${gate < 0 ? ' held' : ''}">
    <div class="sec-head">
      <div class="grow" data-act="section-toggle" data-id="${f.id}" style="cursor:pointer"><span class="lp-caret">${open ? '▾' : '▸'}</span> <b>${esc(f.name)}</b> ${f.kind && f.kind !== 'feature' ? `<span class="pill">${esc(f.kind)}</span> ` : ''}<span class="pill">${esc(f.area)}</span>${f.core ? ' <span class="pill success">core</span>' : ''}${gb.pill ? ` ${gb.pill}` : ''}${focusBy.map((l) => ` <span class="pill js-repo">${l} focus</span>`).join('')}
        <div class="hint" style="margin:2px 0 0 18px">Now ${f.level < 0 ? 'not started' : gateLabel(f.level)}${f.verified ? ' (verified)' : ''} · ${building} open${f.held ? ` · ${f.held} waiting` : ''}</div></div>
      ${state}
      <label class="sec-gate"><span class="hint" style="margin:0">Gate</span><select class="mini" data-gate="${f.id}">${[-1, 0, 1, 2, 3].map((n) => `<option value="${n}"${n === gate ? ' selected' : ''}>${gateLabel(n)}</option>`).join('')}</select></label>
      ${r.gates?.on && atGate && gate < 3 ? `<button class="primary small" data-act="gate-pass" data-id="${f.id}" data-gate="${gate + 1}">Pass to L${gate + 1}</button>` : ''}
    </div>
    ${open ? `<div class="sec-body">
      <p style="margin:6px 0">${esc(f.summary || '')}${f.gdd ? ` <span class="hint" style="display:inline">GDD: ${esc(f.gdd)}</span>` : ''}</p>
      ${gb.body}
      <div class="sec-levels">${[0, 1, 2, 3].map((n) => `<div class="sec-lvl${n === gate ? ' gate' : ''}${n <= f.level ? ' met' : ''}"><b>L${n} ${GATE_NAMES[n]}</b>${n === gate ? ' <span class="hint" style="display:inline">← gate</span>' : ''}<p>${esc(f.levels?.[n]?.done || '')}</p><span class="hint" style="margin:0">${f.doneCount?.[n] || 0} done · ${f.open?.[n] || 0} open</span></div>`).join('')}</div>
      ${mine.length ? `<ul class="sec-tickets">${mine.sort((a, b) => (a.level ?? 9) - (b.level ?? 9) || a.num - b.num).map((t) => { const h = sectionHeld(g, r, t); return `<li class="${h ? 'held' : ''}"><span class="link" data-act="thread-open" data-id="${t.id}">#${t.num}</span> ${t.level != null ? `<span class="pill">L${t.level}</span> ` : ''}${esc(t.title)} <span class="hint" style="margin:0;display:inline">· ${esc(t.status)}${h ? ` · waiting: ${esc(h)}` : ''}</span></li>`; }).join('')}</ul>` : '<p class="hint">No open tickets in this section.</p>'}
      <form class="sec-note" data-sec-note="${f.id}"><textarea name="text" rows="2" placeholder="A note about ${esc(f.name)} only: what to change, what felt off…"></textarea><button class="primary small">Send to the team</button></form>
      <p class="hint" style="margin:4px 0 0">Its tickets land in this section, at or under its gate unless the note asks for the next level.</p>
    </div>` : ''}
  </div>`;
}

function gateSetModal(id) {
  const g = game();
  const r = S.st.roadmaps[g.id];
  const s = r.gates.sets.find((x) => x.id === id) || { name: '', targets: Object.fromEntries(r.features.map((f) => [f.id, f.gate ?? -1])), note: '' };
  modal({
    title: id ? 'Edit gate set' : 'New production gate set',
    wide: true,
    body: `<label class="field"><span>Name</span><input name="name" value="${esc(s.name)}" placeholder="e.g. First playable, Vertical slice, Art pass 1"></label>
      <label class="field"><span>Note (optional)</span><input name="note" value="${esc(s.note || '')}" placeholder="What this stage is for"></label>
      <p class="hint">Target gate for each section. "Leave" keeps a section's gate as it is when the set is applied.</p>
      <div class="gs-grid">${r.features.map((f) => `<label class="gs-row"><span>${esc(f.name)} <span class="hint" style="display:inline">now ${f.level < 0 ? '–' : `L${f.level}`}</span></span><select name="t_${f.id}"><option value="">Leave</option>${[-1, 0, 1, 2, 3].map((n) => `<option value="${n}"${s.targets[f.id] === n ? ' selected' : ''}>${gateLabel(n)}</option>`).join('')}</select></label>`).join('')}</div>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', kind: 'primary',
      onClick: async (root) => {
        const f = formData(root);
        const targets = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('t_')).map(([k, v]) => [k.slice(2), v]));
        await api('PATCH', `/api/games/${g.id}/gates`, { saveSet: { id: id || null, name: f.name, note: f.note, targets } });
      },
    }],
  });
}

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!$('#sections')?.contains(t)) return;
  const gid = S.gameId;
  try {
    if (t.dataset.gate) { await api('PATCH', `/api/games/${gid}/gates`, { gate: { featureId: t.dataset.gate, gate: Number(t.value) } }); t.blur(); }
    else if (t.dataset.focusMode) {
      const cur = S.st.roadmaps[gid].gates.focus?.[t.dataset.focusMode] || { sections: [] };
      await api('PATCH', `/api/games/${gid}/gates`, { focus: { dept: t.dataset.focusMode, mode: t.value, sections: cur.sections || [] } }); t.blur();
    } else if (t.matches('[data-gates-on]')) await api('PATCH', `/api/games/${gid}/gates`, { on: t.checked });
  } catch (err) { fail(err); }
});
document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-focus-dept]');
  if (!chip || !$('#sections')?.contains(chip)) return;
  const gid = S.gameId;
  const d = chip.dataset.focusDept;
  const cur = S.st.roadmaps[gid].gates.focus?.[d] || { mode: 'first', sections: [] };
  const sections = cur.sections?.includes(chip.dataset.focusId) ? cur.sections.filter((x) => x !== chip.dataset.focusId) : [...(cur.sections || []), chip.dataset.focusId];
  try { await api('PATCH', `/api/games/${gid}/gates`, { focus: { dept: d, mode: cur.mode || 'first', sections } }); } catch (err) { fail(err); }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-sec-note]');
  if (!f) return;
  e.preventDefault();
  const text = f.text.value.trim();
  if (!text) return;
  f.text.value = '';
  try { await api('POST', `/api/games/${S.gameId}/sections/${f.dataset.secNote}/note`, { text }); toast('Sent: triage puts its tickets in this section.'); } catch (err) { f.text.value = text; fail(err); }
});

// ---------------------------------------------------------------------------
// Focus: what the director wants worked on right now, in their own words (src/focus.mjs).

const focusesOf = (g) => S.st.focus?.[g.id]?.focuses || [];
const activeFocuses = (g) => focusesOf(g).filter((f) => f.on && !f.expired);

function focusBar(g) {
  const fx = S.st.focus?.[g.id];
  const list = focusesOf(g);
  return `<div class="fx-bar">
    <div class="row" style="gap:8px"><b>Focus</b><span class="hint grow" style="margin:0">${list.length ? 'What you want worked on right now. Matching tickets go first; with "Only", other work waits (urgent tickets still go).' : 'Write what you want worked on right now, in your own words. Claude matches the board to it, agents take that work first, and Plan adds what\'s missing.'}${fx?.matching ? ' <span class="pill queued">matching tickets…</span>' : ''}</span>
      <button class="primary small" data-act="focus-edit">+ Write a focus</button></div>
    ${list.map((f) => `<div class="fx-card${f.on && !f.expired ? '' : ' off'}">
      <div class="row" style="gap:8px;flex-wrap:wrap"><span class="fx-star">★</span><b class="grow">${esc(f.title)}</b>
        <span class="pill${f.mode === 'only' ? ' warn' : ''}">${f.mode === 'only' ? 'only this' : 'first'}</span>
        ${f.expired ? '<span class="pill">ended</span>' : !f.on ? '<span class="pill">paused</span>' : f.until ? `<span class="hint" style="margin:0">until ${esc(new Date(f.until).toLocaleDateString())}</span>` : ''}
        <span class="hint" style="margin:0">${f.counts.open} open · ${f.counts.working} in progress · ${f.counts.done} done${f.counts.blocked ? ` · ${f.counts.blocked} blocked` : ''}${f.counts.held ? ` · ${f.counts.held} above a gate` : ''}</span></div>
      ${f.text ? `<div class="fx-text">${esc(f.text)}</div>` : ''}
      ${f.planned ? `<div class="hint" style="margin:4px 0 0">Planned ${esc(ago(f.planned.at))}: ${esc(f.planned.summary)}${f.planned.added.length ? ` Added ${f.planned.added.map((n) => `#${n}`).join(', ')}.` : ''}</div>` : ''}
      <div class="row" style="gap:6px;margin-top:6px">
        <button class="ghost small" data-act="focus-plan" data-id="${f.id}"${f.planning ? ' disabled' : ''} title="Read the GDD and the code, and add the tickets this focus still needs">${f.planning ? 'Planning…' : 'Plan tickets for it'}</button>
        <button class="ghost small" data-act="focus-match" data-id="${f.id}"${fx?.matching ? ' disabled' : ''} title="Match the board's tickets to your focuses again">Match tickets again</button>
        <button class="ghost small" data-act="focus-edit" data-id="${f.id}">Edit</button>
        <button class="ghost small" data-act="focus-toggle" data-id="${f.id}">${f.on ? 'Pause' : 'Resume'}</button>
        <a href="#" class="lp-x" data-act="focus-remove" data-id="${f.id}" title="Remove this focus">✕</a></div>
    </div>`).join('')}
  </div>`;
}

const focusPill = (g, t) => (t.status !== 'done' && (t.focusIds || []).some((id) => activeFocuses(g).some((f) => f.id === id)) ? `<span class="pill fx-pill" title="Serves your focus: ${esc(activeFocuses(g).filter((f) => t.focusIds.includes(f.id)).map((f) => f.title).join(', '))}">★ focus</span>` : '');

function focusModal(id) {
  const g = game();
  const f = focusesOf(g).find((x) => x.id === id) || { title: '', text: '', mode: 'first', until: null };
  const until = f.until ? new Date(f.until).toISOString().slice(0, 10) : '';
  modal({
    title: id ? 'Edit focus' : 'What should the team focus on?',
    wide: true,
    body: `<label class="field"><span>Short title</span><input name="title" value="${esc(f.title)}" placeholder="e.g. The first 15 minutes read clearly"></label>
      <label class="field"><span>Describe it</span><textarea name="text" rows="8" placeholder="What you want, why, and what done looks like. e.g. A new player can dig the first room, sign the first client and survive the first breach without reading anything. The HUD tells them what's happening. Polish only what they see in those 15 minutes.">${esc(f.text)}</textarea></label>
      <div class="two">
        <label class="field"><span>How strictly</span><select name="mode"><option value="first"${f.mode !== 'only' ? ' selected' : ''}>First: matching tickets go ahead of the rest</option><option value="only"${f.mode === 'only' ? ' selected' : ''}>Only: other work waits (urgent tickets still go)</option></select></label>
        <label class="field"><span>Until (optional)</span><input type="date" name="until" value="${until}"><small>It switches itself off after this day.</small></label>
      </div>
      <p class="hint">Saving matches the board's tickets to it. <b>Plan tickets for it</b> then adds what's missing, within your section gates.</p>`,
    actions: [{ label: 'Cancel' }, {
      label: id ? 'Save' : 'Set this focus', kind: 'primary',
      onClick: async (root) => { const v = formData(root); await api('PATCH', `/api/games/${g.id}/focus`, { save: { id: id || null, title: v.title, text: v.text, mode: v.mode, until: v.until || null } }); },
    }],
  });
}

// ---------------------------------------------------------------------------
// Workbench: how the GDD is cut into sections, gyms for systems, and art subjects with iteration
// rounds (src/workbench.mjs, roadmap schemes).

const SCHEME_LABELS = { systems: 'Systems', features: 'Features', content: 'Content', journey: 'Player journey' };

function schemeCard(g, r) {
  const sc = r?.scheme || { kind: 'systems', guide: '' };
  const running = r?.status === 'running';
  const has = r?.features?.length;
  return `<details class="card scheme-card"${has ? '' : ' open'}><summary><b>How sections are cut</b> <span class="hint" style="margin:0;display:inline">· ${esc(SCHEME_LABELS[sc.kind] || 'Features')}${sc.guide ? ' · with your instructions' : ''}${has ? ` · ${r.features.length} sections` : ''}</span></summary>
    <form id="scheme-form" class="scheme-form">
      <div class="row" style="gap:8px;flex-wrap:wrap">${Object.entries(SCHEME_LABELS).map(([k, l]) => `<label class="check" style="margin:0"><input type="radio" name="scheme" value="${k}"${(sc.kind || 'features') === k ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <p class="hint" style="margin:6px 0">${'<b>Systems</b>: one section per system (its rules, numbers and feedback), with content inside the system it exercises. <b>Features</b>: what a player can do. <b>Content</b>: levels, characters, items. <b>Player journey</b>: first minutes through the ending.'}</p>
      <textarea name="guide" rows="4" placeholder="Your own instructions, e.g. One section per system: digging, power, air, water, clients, threats, the board, research. Keep each threat track inside Threats. Art direction and UI are their own sections.">${esc(sc.guide || '')}</textarea>
      <div class="row" style="gap:8px;margin-top:8px">${running ? '<span class="pill queued">Breaking down the GDD… (a few minutes)</span>' : `<button class="primary small" data-model="opus">${has ? 'Re-break the GDD this way' : 'Break the GDD into sections'}</button><button class="ghost small" data-model="sonnet">Faster (Sonnet)</button>`}
        <span class="hint grow" style="margin:0">${has ? 'Sections with the same name keep their gate and tickets; tickets of sections that disappear go back to "no section" for Sort to place.' : ''}</span></div>
    </form></details>`;
}

function gymBits(g, f) {
  const gym = (g.gyms || []).find((x) => x.sectionId === f.id);
  if (!gym) return { pill: '', body: `<div class="gym-box"><b>Gym</b> <span class="hint" style="margin:0;display:inline">A test scene that loads straight into ${esc(f.name)}, with its numbers as live controls.</span> <button class="ghost small" data-act="gym-ask" data-section="${f.id}">Ask for a gym</button></div>` };
  const t = gym.taskId && tasksOf(g.id).find((x) => x.id === gym.taskId);
  const pill = gym.status === 'ready' ? '<span class="pill success">gym ready</span>' : gym.status === 'failed' ? '<span class="pill error">gym failed</span>' : `<span class="pill queued">gym: building #${gym.taskNum}</span>`;
  const open = gym.url ? `<a href="${esc(gym.url)}" target="_blank" rel="noopener">${esc(gym.open)}</a>` : esc(gym.open || '');
  return {
    pill,
    body: `<div class="gym-box"><div class="row" style="gap:8px;flex-wrap:wrap"><b>Gym</b>${pill}${t ? `<span class="hint" style="margin:0">#${t.num} ${esc(t.status)}</span>` : ''}<span class="grow"></span>
        <button class="ghost small" data-act="gym-ask" data-section="${f.id}" data-gym="${gym.id}">Ask for changes</button><a href="#" class="lp-x" data-act="gym-remove" data-id="${gym.id}" title="Forget this gym (the code stays)">✕</a></div>
      ${gym.status === 'ready' ? `<div class="gym-open">Open it: <code>${open}</code> <a href="#" data-act="gym-copy" data-id="${gym.id}">copy</a></div>
        <form class="sec-note" data-gym-note="${gym.id}"><textarea name="text" rows="2" placeholder="Playing the gym: what felt off, what to tune…"></textarea><button class="primary small">Send from the gym</button></form>
        <p class="hint" style="margin:2px 0 0">Notes go to ${esc(f.name)}: its tickets land in this section.${gym.notes ? ` ${gym.notes} note${gym.notes === 1 ? '' : 's'} sent from it.` : ''}</p>` : gym.error ? `<p class="hint" style="color:var(--red);margin:4px 0 0">${esc(gym.error)}</p>` : '<p class="hint" style="margin:4px 0 0">Being built. It shows how to open it here when the ticket is done.</p>'}
    </div>`,
  };
}

function gymAskModal(sectionId, gymId) {
  const g = game();
  const f = S.st.roadmaps[g.id].features.find((x) => x.id === sectionId);
  modal({
    title: gymId ? `Change the ${f.name} gym` : `A gym for ${f.name}`,
    body: `<p class="hint">${gymId ? 'What should change in the gym?' : `Ballast asks for a test scene that loads straight into ${esc(f.name)}, with its tuning numbers as live controls, readouts and a quick reset. Add what you want in it.`}</p>
      <textarea name="ask" rows="6" placeholder="${gymId ? 'e.g. Add a preset for a late-game shelter with 40 rooms; show air per room on the readout.' : 'e.g. Start with a half-dug shelter and three clients waiting. Let me spawn a breach on demand. Sliders for dig speed, air per room and contract prices.'}"></textarea>`,
    actions: [{ label: 'Cancel' }, { label: gymId ? 'Ask for the changes' : 'Ask for the gym', kind: 'primary', onClick: async (root) => { await api('POST', `/api/games/${g.id}/gyms`, { sectionId, gymId: gymId || null, ask: $('[name=ask]', root).value }); toast('On the board. The section shows how to open the gym when it\'s built.'); } }],
  });
}

// --- Art subjects (Art tab)

const SUBJECT_KIND_LABELS = { character: 'Character', creature: 'Creature', level: 'Level', environment: 'Environment', prop: 'Prop', ui: 'UI', vfx: 'Effect', other: 'Other' };

function subjectsSection(g) {
  const list = g.subjects || [];
  return `<section><div class="section-head"><h3>Subjects</h3><span class="hint">A character, level, prop or effect developed round by round: each round's captures side by side, your notes going into the next</span><button class="ghost small" data-act="subject-edit">+ Subject</button></div>
    ${list.length ? list.map((s) => subjectCard(g, s)).join('') : '<p class="hint">None yet. Add one to iterate on it: give it a brief and pick reference targets, then start round 1.</p>'}</section>`;
}

function subjectCard(g, s) {
  const tasks = tasksOf(g.id);
  const f = s.sectionId && S.st.roadmaps?.[g.id]?.features?.find((x) => x.id === s.sectionId);
  const refs = (S.st.targets || []).filter((x) => (s.refs || []).includes(x.id));
  const rounds = [...(s.rounds || [])].reverse();
  const last = s.rounds?.at(-1);
  const lastTask = last && tasks.find((t) => t.id === last.taskId);
  const ready = !last || (lastTask && ['done', 'blocked'].includes(lastTask.status));
  return `<div class="card subj-card${s.status === 'approved' ? ' approved' : ''}">
    <div class="row" style="gap:8px;flex-wrap:wrap"><b class="grow" style="font-size:15px">${esc(s.name)}</b><span class="pill">${SUBJECT_KIND_LABELS[s.kind] || s.kind}</span>${f ? `<span class="pill">${esc(f.name)}</span>` : ''}
      ${s.status === 'approved' ? '<span class="pill success">approved</span>' : s.status === 'paused' ? '<span class="pill">paused</span>' : ''}
      <button class="ghost small" data-act="subject-edit" data-id="${s.id}">Edit</button></div>
    ${s.brief ? `<div class="fx-text">${esc(s.brief)}</div>` : ''}
    ${refs.length ? `<div class="caps" style="margin-top:6px">${refs.map(targetThumb).join('')}</div>` : ''}
    ${rounds.map((r, i) => { const t = tasks.find((x) => x.id === r.taskId); const caps = S.st.artifacts.filter((a) => a.taskId === r.taskId && ['image', 'video'].includes(a.kind)); return `<div class="subj-round${i === 0 ? ' latest' : ''}">
      <div class="row" style="gap:8px"><b>Round ${r.n}</b><span class="hint" style="margin:0">#${r.num} · ${t ? esc(t.status) : 'removed'}${t?.claimedBy && t.status === 'claimed' ? ` · ${esc(agentOf(t.claimedBy)?.name || '')}` : ''}</span>${r.approved ? '<span class="pill success">approved</span>' : ''}</div>
      ${caps.length ? `<div class="caps">${caps.slice(0, 10).map(thumb).join('')}</div>` : t?.status === 'done' ? '<p class="hint" style="margin:4px 0">No captures came back with this round.</p>' : ''}
      ${t?.summary && t.status === 'done' ? `<div class="hint" style="margin:4px 0 0">${esc(t.summary.slice(0, 400))}</div>` : ''}
      ${r.notes && !(i === 0 && ready && s.status === 'active') ? `<div class="subj-notes"><b>Your notes:</b> ${esc(r.notes)}</div>` : ''}
    </div>`; }).join('')}
    ${s.status === 'approved' ? `<div class="row" style="margin-top:8px"><button class="ghost small" data-act="subject-round" data-id="${s.id}">Start another round</button></div>`
      : !last ? `<div class="row" style="margin-top:8px"><button class="primary small" data-act="subject-round" data-id="${s.id}">Start round 1</button></div>`
      : ready ? `<form class="subj-form" data-subject="${s.id}"><textarea name="notes" rows="3" placeholder="Notes on round ${last.n}: what to change, what to keep…">${esc(last.notes || '')}</textarea>
          <div class="row" style="gap:6px"><button class="primary small" name="go" value="next">Round ${last.n + 1} with these notes</button><button class="ghost small" name="go" value="approve">Approve round ${last.n}</button><button class="ghost small" name="go" value="pause">Pause</button></div></form>`
      : '<p class="hint" style="margin:8px 0 0">Round in progress. Give notes when it\'s done.</p>'}
  </div>`;
}

function subjectModal(id) {
  const g = game();
  const s = (g.subjects || []).find((x) => x.id === id) || { name: '', kind: 'character', sectionId: '', brief: '', refs: [], links: '' };
  const targets = (S.st.targets || []).filter((x) => x.gameId === g.id && x.discipline === 'art');
  const secs = S.st.roadmaps?.[g.id]?.features || [];
  modal({
    title: id ? 'Edit subject' : 'New art subject',
    wide: true,
    body: `<div class="two"><label class="field"><span>Name</span><input name="name" value="${esc(s.name)}" placeholder="e.g. The Inspector, Hole 3, Shelter room tiles"></label>
        <label class="field"><span>Kind</span><select name="kind">${Object.entries(SUBJECT_KIND_LABELS).map(([k, l]) => `<option value="${k}"${s.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <label class="field"><span>Section (optional)</span><select name="sectionId"><option value="">None</option>${secs.map((f) => `<option value="${f.id}"${s.sectionId === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Brief</span><textarea name="brief" rows="5" placeholder="Who or what it is, the feeling to hit, silhouette, palette, what must read at play distance…">${esc(s.brief)}</textarea></label>
      <div class="field"><span class="field-label">Reference targets</span>${targets.length ? `<div class="subj-refs">${targets.map((x) => `<label class="check"><input type="checkbox" name="ref_${x.id}"${(s.refs || []).includes(x.id) ? ' checked' : ''}><span>${esc(x.title)}</span></label>`).join('')}</div>` : '<p class="hint" style="margin:0">No art quality targets yet. Add reference images under Quality targets on this tab, then pick them here.</p>'}</div>
      <label class="field"><span>Other references (optional)</span><textarea name="links" rows="2" placeholder="Links, games, films, or words: 'chunky 1-bit outlines like…'">${esc(s.links || '')}</textarea></label>`,
    actions: [
      ...(id ? [{ label: 'Delete', onClick: async () => { await api('PATCH', `/api/games/${g.id}/subjects/${id}`, { remove: true }); } }] : []),
      { label: 'Cancel' },
      { label: id ? 'Save' : 'Add subject', kind: 'primary', onClick: async (root) => { const v = formData(root); await api('POST', `/api/games/${g.id}/subjects`, { id: id || null, name: v.name, kind: v.kind, sectionId: v.sectionId || null, brief: v.brief, links: v.links, refs: Object.keys(v).filter((k) => k.startsWith('ref_') && v[k]).map((k) => k.slice(4)) }); } },
    ],
  });
}

document.addEventListener('submit', async (e) => {
  const gf = e.target.closest('[data-gym-note]');
  const sf = e.target.closest('[data-subject]');
  const sc = e.target.closest('#scheme-form');
  if (!gf && !sf && !sc) return;
  e.preventDefault();
  const gid = S.gameId;
  try {
    if (gf) {
      const text = gf.text.value.trim();
      if (!text) return;
      gf.text.value = '';
      await api('POST', `/api/games/${gid}/gyms/${gf.dataset.gymNote}/note`, { text });
      toast('Sent: its tickets land in this section.');
    } else if (sf) {
      const go = e.submitter?.value || 'next';
      const notes = sf.notes.value.trim();
      if (go === 'next') { await api('POST', `/api/games/${gid}/subjects/${sf.dataset.subject}/round`, { notes }); toast('Next round is on the board.'); }
      else await api('PATCH', `/api/games/${gid}/subjects/${sf.dataset.subject}`, { notes, status: go === 'approve' ? 'approved' : 'paused' });
    } else {
      const f = formData(sc);
      const model = e.submitter?.dataset.model || 'opus';
      await api('POST', `/api/games/${gid}/roadmap`, { model, scheme: sc.querySelector('[name=scheme]:checked')?.value || 'systems', guide: f.guide });
      toast('Breaking down the GDD your way… (a few minutes)');
    }
  } catch (err) { fail(err); }
});

// ---------------------------------------------------------------------------
// GDD tab: versions kept in Ballast, feedback → drafted edits with clarifying questions → accept →
// next version, written back where the GDD lives (src/gddedit.mjs).

const GDDV = { data: {}, loading: {}, at: {}, sig: {} };

async function loadGdd(gid = S.gameId) {
  GDDV.loading[gid] = true;
  try { GDDV.data[gid] = await api('GET', `/api/games/${gid}/gdd`); GDDV.at[gid] = Date.now(); } catch (err) { fail(err); }
  GDDV.loading[gid] = false;
  if (S.tab === 'gdd' && S.gameId === gid) { if (POINTER.down) POINTER.pending = true; else renderGdd(true); }
}

function renderGdd(fresh = false) {
  const el = $('#gddtab');
  if (!el) return;
  if (!fresh && el.contains(document.activeElement) && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName)) return;
  const g = game();
  const d = GDDV.data[g.id];
  const st = g.gdd || { versions: [], drafts: [] };
  // Versions or drafts changed on the server: fetch the text and source again (once per change).
  const sig = `${st.versions?.length}|${(st.drafts || []).map((x) => x.status).join(',')}`;
  if (!d || GDDV.sig[g.id] !== sig) {
    GDDV.sig[g.id] = sig;
    if (!GDDV.loading[g.id]) loadGdd(g.id);
    if (!d) { el.innerHTML = '<p class="hint">Reading the GDD…</p>'; return; }
  }
  // Nothing this tab shows changed: leave the page alone (live updates come several times a second).
  const view = JSON.stringify([st, GDDV.at[g.id]]);
  if (!fresh && el.dataset.view === view) return;
  el.dataset.view = view;
  const v = d.versions[0];
  const drafts = (st.drafts || []).filter((x) => x.status !== 'discarded');
  el.innerHTML = `
    <div class="row pf-top"><h2 class="grow" style="margin:0">GDD</h2>
      ${v ? `<span class="hint" style="margin:0">v${v.v} · ${esc(ago(v.at))} · ${v.words.toLocaleString()} words</span><button class="ghost small" data-act="gdd-download">Download v${v.v}</button>` : ''}
      <button class="ghost small" data-act="gdd-import"${v ? ' title="Make a new version from where the GDD lives now"' : ''}>${v ? 'Import again' : 'Import the GDD'}</button>
      <button class="ghost small" data-act="gdd-paste">Paste or upload</button></div>
    <p class="hint">Lives in: ${esc(d.source.label)}. Write feedback on the design below. Claude drafts the exact edits and asks you about anything it can't decide well; you pick what to keep, and accepting saves the next version, writes it back there, and updates the board.</p>
    ${!v ? `<div class="card"><p style="margin:0">No GDD in Ballast yet. <b>Import the GDD</b> takes it from ${esc(d.source.kind === 'ballast' ? 'the repo or claude.ai' : d.source.label)}; <b>Paste or upload</b> takes Markdown or text.</p></div>` : `
    <form class="card gdd-ask" id="gdd-ask">
      <textarea name="feedback" rows="4" placeholder="Feedback on the design, e.g. The first quarter is too punishing: the quota should start lower and climb with the chapter. Add a short tutorial chapter before Startup."></textarea>
      <div class="row" style="gap:8px;margin-top:8px"><select class="mini" name="model"><option value="opus">Opus</option><option value="sonnet">Sonnet (faster)</option></select><span class="hint grow" style="margin:0">Notes in the Feed that change the design are drafted here too.</span><button class="primary small">Draft the changes</button></div>
    </form>`}
    ${drafts.map((x) => gddDraftCard(x)).join('')}
    ${d.versions.length ? `<details class="card"><summary><b>Versions</b> <span class="hint" style="display:inline;margin:0">${d.versions.length}</span></summary><ul class="gdd-versions">${d.versions.map((x) => `<li><b>v${x.v}</b> <span class="hint" style="display:inline;margin:0">${esc(new Date(x.at).toLocaleString())} · ${esc(x.by || '')} · ${x.words.toLocaleString()} words</span><div>${esc(x.summary || '')}</div></li>`).join('')}</ul></details>` : ''}
    ${d.current ? `<details class="card"><summary><b>Read v${v.v}</b></summary><div class="md gdd-read">${md(d.current.slice(0, 200000))}</div></details>` : ''}`;
}

function gddDraftCard(x) {
  const pill = { thinking: '<span class="pill running">drafting…</span>', review: '<span class="pill warn">your call</span>', accepted: `<span class="pill success">saved as v${x.version}</span>`, error: '<span class="pill error">failed</span>' }[x.status] || '';
  const wb = x.writeBack;
  const taken = (x.edits || []).filter((e) => e.take).length;
  return `<div class="card gdd-draft${x.status === 'review' ? ' open' : ''}" data-draft="${x.id}">
    <div class="row" style="gap:8px"><b class="grow">${esc(gddClip(x.feedback, 160))}</b>${x.from ? `<span class="hint" style="margin:0">from ${esc(x.from)}</span>` : ''}${pill}<span class="hint" style="margin:0">${esc(ago(x.createdAt))}</span>
      ${x.status !== 'accepted' && x.status !== 'thinking' ? `<a href="#" class="lp-x" data-act="gdd-discard" data-id="${x.id}" title="Discard this draft">✕</a>` : ''}</div>
    ${x.status === 'thinking' ? '<p class="hint" style="margin:6px 0 0">Reading the GDD and the code…</p>' : ''}
    ${x.status === 'error' ? `<p style="color:var(--red);margin:6px 0 0">${esc(x.error || '')}</p>` : ''}
    ${x.summary && x.status !== 'thinking' ? `<p style="margin:6px 0">${esc(x.summary)}</p>` : ''}
    ${x.status === 'review' ? `
      ${x.questions.length ? `<div class="gdd-qs"><b>Questions</b>${x.questions.map((q) => `<div class="gdd-q"><div>${esc(q.question)}</div><div class="hint" style="margin:2px 0">${esc(q.why)}${q.assumption ? ` · Assumed for now: ${esc(q.assumption)}` : ''}</div>
          ${q.options?.length ? `<div class="chip-row">${q.options.map((o) => `<button type="button" class="chip-btn" data-gdd-opt="${esc(q.id)}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
          <input data-gdd-answer="${esc(q.id)}" value="${esc(q.answer || '')}" placeholder="Your answer"></div>`).join('')}</div>` : ''}
      <div class="gdd-edits">${x.edits.map((e, i) => `<div class="gdd-edit${e.take ? '' : ' off'}">
        <label class="check" style="margin:0"><input type="checkbox" data-gdd-take="${e.id}"${e.take ? ' checked' : ''}><span><b>${i + 1}. ${esc(e.section)}</b> <span class="pill">${e.op}</span>${e.found ? '' : ' <span class="pill error" title="The quoted passage isn\'t in the current GDD; accepting would skip it. Ask for a revision.">not found</span>'}</span></label>
        <div class="hint" style="margin:2px 0 4px">${esc(e.why)}</div>
        ${e.op !== 'insert' && e.find ? `<pre class="gdd-before">${esc(e.find.slice(0, 3000))}</pre>` : e.after ? `<div class="hint" style="margin:0">After: ${esc(gddClip(e.after, 160))}</div>` : ''}
        ${e.op !== 'delete' ? `<pre class="gdd-after">${esc(e.text.slice(0, 4000))}</pre>` : ''}</div>`).join('') || '<p class="hint">No edits proposed: answer the questions first.</p>'}</div>
      <form class="gdd-reply" data-gdd-reply="${x.id}"><textarea name="text" rows="2" placeholder="${x.questions.length ? 'Anything to add with your answers…' : 'Ask for a revision: what to change in these edits…'}"></textarea>
        <div class="row" style="gap:6px;margin-top:6px"><button class="ghost small">${x.questions.length ? 'Send answers and revise' : 'Revise'}</button><span class="grow"></span>
          <button type="button" class="primary small" data-act="gdd-accept" data-id="${x.id}"${taken ? '' : ' disabled'}>Accept ${taken} edit${taken === 1 ? '' : 's'} → new version</button></div></form>` : ''}
    ${x.status === 'accepted' ? `<p class="hint" style="margin:4px 0 0">${x.missed?.length ? `${x.missed.length} edit(s) didn't match the text and were left out. ` : ''}${!wb ? '' : wb.kind === 'docs' ? (wb.status === 'running' ? 'Writing it to the Claude Docs doc…' : wb.status === 'done' ? `Written to the Claude Docs doc (${wb.applied} edits).` : `Claude Docs: ${esc(wb.status)}${wb.failed?.length ? `: ${esc(wb.failed.join('; '))}` : wb.error ? `: ${esc(wb.error)}` : ''}`) : wb.kind === 'artifact' ? 'The claude.ai page is read only: update it by hand, or move the GDD to Claude Docs.' : wb.ticket ? `Ticket #${wb.ticket} commits it to the repo.` : ''} The board is being re-checked against it.</p>` : ''}
  </div>`;
}
const gddClip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

function gddPasteModal() {
  const g = game();
  modal({
    title: 'Paste or upload the GDD',
    wide: true,
    body: `<p class="hint">Markdown or plain text. It becomes the next version in Ballast.</p>
      <input type="file" accept=".md,.markdown,.txt" data-gdd-file>
      <textarea name="text" rows="14" placeholder="# My game\n\n## Core loop\n…" style="margin-top:8px;width:100%"></textarea>`,
    onMount: (root) => { $('[data-gdd-file]', root).onchange = async (e) => { const f = e.target.files[0]; if (f) { $('[name=text]', root).value = await f.text(); root.dataset.name = f.name; } }; },
    actions: [{ label: 'Cancel' }, { label: 'Save as a version', kind: 'primary', onClick: async (root) => { await api('POST', `/api/games/${g.id}/gdd/import`, { text: $('[name=text]', root).value, name: root.dataset.name || '' }); await loadGdd(g.id); } }],
  });
}

document.addEventListener('submit', async (e) => {
  const ask = e.target.closest('#gdd-ask');
  const rep = e.target.closest('[data-gdd-reply]');
  if (!ask && !rep) return;
  e.preventDefault();
  const gid = S.gameId;
  try {
    if (ask) {
      const f = formData(ask);
      if (!f.feedback.trim()) return;
      ask.feedback.value = '';
      await api('POST', `/api/games/${gid}/gdd/drafts`, { feedback: f.feedback, model: f.model });
      toast('Drafting: Claude reads the GDD and the code (a few minutes).');
    } else {
      const card = rep.closest('[data-draft]');
      const answers = Object.fromEntries($$('[data-gdd-answer]', card).map((i) => [i.dataset.gddAnswer, i.value.trim()]).filter(([, v]) => v));
      await api('POST', `/api/games/${gid}/gdd/drafts/${rep.dataset.gddReply}/reply`, { answers, text: rep.text.value });
      toast('Revising the draft with your answers…');
    }
  } catch (err) { fail(err); }
});
document.addEventListener('change', async (e) => {
  const t = e.target.closest?.('[data-gdd-take]');
  if (!t) return;
  const card = t.closest('[data-draft]');
  try { await api('PATCH', `/api/games/${S.gameId}/gdd/drafts/${card.dataset.draft}`, { take: { [t.dataset.gddTake]: t.checked } }); } catch (err) { fail(err); }
});
document.addEventListener('click', (e) => {
  const o = e.target.closest?.('[data-gdd-opt]');
  if (!o) return;
  const input = $(`[data-gdd-answer="${CSS.escape(o.dataset.gddOpt)}"]`, o.closest('.gdd-q'));
  if (input) { input.value = o.dataset.val; input.focus(); }
});

// ---------------------------------------------------------------------------
// Budget: pace per account, what tickets cost in account limits, work redone, time lost waiting,
// and results against spend. Costs are estimates (see src/budget.mjs); % means % of one account's week.

const BUDGET = { data: {}, days: {}, loading: {} };
const bpct = (v, d = 1) => (v == null ? '–' : `${Math.round(v * 10 ** d) / 10 ** d}%`);
const hrs = (h) => (h == null ? '–' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h / 24 * 10) / 10}d`);
const untilP = (at) => { if (!at) return '?'; const m = Math.max(0, Math.round((at - Date.now()) / 60e3)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`; };

async function loadBudget(gid = S.gameId) {
  BUDGET.loading[gid] = true;
  try { BUDGET.data[gid] = await api('GET', `/api/games/${gid}/budget?days=${BUDGET.days[gid] || 14}`); } catch (err) { fail(err); BUDGET.data[gid] = null; }
  BUDGET.loading[gid] = false;
  if (S.tab === 'budget' && S.gameId === gid) renderBudget();
}

// Weekly use against time gone: the fill is what's used, the tick is where an even pace would be.
function paceBar(w) {
  if (!w) return '<div class="hint">No weekly reading yet.</div>';
  return `<div class="bd-bar" role="img" aria-label="${Math.round(w.used)}% used, ${Math.round(w.elapsed ?? 0)}% of the week gone">
    <div class="bd-fill" style="width:${Math.min(100, w.used)}%"></div>
    ${w.elapsed != null ? `<div class="bd-tick" style="left:${w.elapsed}%" title="${Math.round(w.elapsed)}% of the week gone"></div>` : ''}
  </div>
  <div class="bd-bar-legend"><span>${Math.round(w.used)}% used</span><span>${w.elapsed != null ? `${Math.round(w.elapsed)}% of the week gone` : ''}</span></div>`;
}

function paceCard(a) {
  const w = a.pace.weekly;
  const s = a.pace.session;
  const state = a.pace.expiring
    ? `<span class="bd-state go">▶ Gets work first: ${bpct(a.pace.headroom, 0)} left, resets in ${untilP(w.resetsAt)}</span>`
    : w?.ahead > 10 ? `<span class="bd-state hold">▲ ${Math.round(w.ahead)} points ahead of pace: usage rules slow it</span>`
      : w?.ahead < -10 ? `<span class="bd-state">▼ ${Math.round(-w.ahead)} points behind pace</span>` : '<span class="bd-state">● On pace</span>';
  return `<div class="card bd-acct">
    <div class="pf-trend-head"><b>${esc(a.name)}</b><span class="hint" style="margin:0">${esc(a.agents.map((x) => x.name + (x.model ? ` (${x.model})` : '')).join(', '))}</span></div>
    ${paceBar(w)}
    <div class="bd-lines">
      ${state}
      <span>Weekly resets in ${untilP(w?.resetsAt)}${w?.leftAtReset >= 5 ? ` · <b>~${Math.round(w.leftAtReset)}% would go unused</b> at this rate` : w?.projected != null ? ' · on course to use it all' : ''}</span>
      <span>Session ${bpct(s?.used, 0)} · resets in ${untilP(s?.resetsAt)}</span>
      <span class="hint" style="margin:0">Idle ${hrs(a.idleHours)} with tickets waiting · ${bpct(a.offTicket, 0)} spent off-ticket (Ballast's own runs, or the account used by hand)</span>
    </div>
  </div>`;
}

const tile = (label, value, sub = '') => `<div class="card bd-tile"><span class="hint" style="margin:0">${label}</span><b>${value}</b>${sub ? `<span class="hint" style="margin:0">${sub}</span>` : ''}</div>`;
const inlineBar = (v, max) => `<span class="bd-ibar"><i style="width:${max > 0 ? Math.min(100, Math.max(1, (100 * v) / max)) : 0}%"></i></span>`;

function renderBudget() {
  const el = $('#budget');
  if (!el) return;
  const gid = S.gameId;
  const d = BUDGET.data[gid];
  if (!d) { el.innerHTML = '<p class="hint">Reading account limits…</p>'; if (!BUDGET.loading[gid]) loadBudget(gid); return; }
  const days = BUDGET.days[gid] || 14;
  const maxDay = Math.max(0, ...d.perDay.map((x) => x.spend));
  // One-off tags (a single expensive ticket) would flatten the rest, so the scale comes from tags with 3+ tickets.
  const maxDisc = Math.max(0, ...d.disciplines.filter((x) => x.priced >= 3).map((x) => x.perTicket || 0));
  const w = d.waiting;
  el.innerHTML = `
    <div class="row pf-top"><h2 class="grow" style="margin:0">Budget</h2>
      <select class="mini" data-budget-days>${[7, 14, 30].map((n) => `<option value="${n}"${n === days ? ' selected' : ''}>Last ${n} days</option>`).join('')}</select></div>
    <p class="hint">Costs are estimates: cloud sessions don't report tokens, so each rise in an account's weekly use is split across the tickets it had in hand. <b>%</b> means percent of one account's week. Readings since ${esc(new Date(d.since).toLocaleDateString([], { month: 'short', day: 'numeric' }))}.</p>

    <h3 class="pf-h">Pace <span class="hint">the tick is where an even pace across the week would be; the account with the most to spend before its reset gets work first</span></h3>
    <div class="bd-accts">${d.accounts.map(paceCard).join('') || '<p class="hint">No agents on this game yet.</p>'}</div>

    <h3 class="pf-h">Spend</h3>
    <div class="bd-tiles">
      ${tile(`Spent, last ${days} days`, bpct(d.spend, 0), 'of one account\'s week')}
      ${tile('Last 7 days', bpct(d.lastWeek, 0))}
      ${tile('Tickets done', d.tickets.done, `${d.tickets.priced} with a cost estimate`)}
      ${tile('Per ticket', bpct(d.tickets.median, 2), `median · mean ${bpct(d.tickets.mean, 2)}`)}
    </div>
    <div class="card"><table class="pf-table bd-days"><thead><tr><th>Day</th><th>Spent</th><th></th><th>Tickets done</th></tr></thead><tbody>
      ${d.perDay.map((x) => `<tr><td>${esc(new Date(`${x.day}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</td><td>${bpct(x.spend)}</td><td class="bd-barcell">${inlineBar(x.spend, maxDay)}</td><td>${x.done}</td></tr>`).join('')}
    </tbody></table></div>

    <h3 class="pf-h">Cost by discipline <span class="hint">by the ticket's [tag], tickets shipped in the period</span></h3>
    <div class="card"><div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>Discipline</th><th>Done</th><th>Spent</th><th>Per ticket</th><th></th></tr></thead><tbody>
      ${d.disciplines.map((x) => `<tr><td>${esc(x.tag)}</td><td>${x.done}</td><td>${bpct(x.spend)}</td><td>${bpct(x.perTicket, 2)}</td><td class="bd-barcell">${inlineBar(x.perTicket || 0, maxDisc)}</td></tr>`).join('')}
    </tbody></table></div>
    ${d.tickets.top.length ? `<details class="pf-landed"><summary>Most expensive tickets</summary><ul>${d.tickets.top.map((t) => `<li>#${t.num} ${esc(t.title)} · ${bpct(t.cost, 2)}</li>`).join('')}</ul></details>` : ''}</div>

    <h3 class="pf-h">Work redone or dropped</h3>
    <div class="card"><div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>What</th><th>Tickets</th><th>Their cost</th></tr></thead><tbody>
      ${d.waste.map((x) => `<tr><td>${x.tickets.length ? `<details><summary>${esc(x.label)}</summary><ul class="bd-list">${x.tickets.map((t) => `<li>#${t.num} ${esc(t.title)} · ${bpct(t.cost, 2)}</li>`).join('')}</ul></details>` : esc(x.label)}</td><td>${x.count}${x.of ? ` of ${x.of}` : ''}</td><td>${x.spend == null ? '–' : bpct(x.spend)}</td></tr>`).join('')}
    </tbody></table></div></div>

    <h3 class="pf-h">Time lost waiting</h3>
    <div class="bd-tiles">
      ${tile('Human interventions', `${w.interventions.open} open`, w.interventions.open ? `oldest ${hrs(w.interventions.oldestHours)} · ${w.interventions.solved} solved, median ${hrs(w.interventions.medianHours)}` : `${w.interventions.solved} solved, median ${hrs(w.interventions.medianHours)}`)}
      ${tile('Reviews', `${w.reviews.pending} pending`, `${w.reviews.pending ? `oldest ${hrs(w.reviews.oldestHours)} · ` : ''}median decision ${hrs(w.reviews.medianHours)}`)}
      ${tile('Blocked tickets', `${w.blocked.now} now`, `${w.blocked.now ? `oldest ${hrs(w.blocked.oldestHours)} · ` : ''}${w.blocked.hours ? `${hrs(w.blocked.hours)} blocked in total` : 'time blocked is tracked from now on'}`)}
      ${tile('Accounts idle', hrs(w.idleHours), 'behind pace, with tickets waiting')}
    </div>

    <h3 class="pf-h">Results against spend <span class="hint">each profiler run against the one before (Performance tab)</span></h3>
    ${d.results.length ? `<div class="card"><div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>Runs</th><th>Spent between</th><th>Tickets landed</th><th>Budgets met</th><th>Measures</th></tr></thead><tbody>
      ${[...d.results].reverse().map((x) => {
        const name = (r) => `${r.noteNum ? `note #${r.noteNum}` : esc(new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}${r.label ? ` (${esc(r.label)})` : ''}`;
        const met = x.passing.after - x.passing.before;
        return `<tr><td>${name(x.from)} → ${name(x.to)}</td><td>${bpct(x.spend)}</td><td>${x.landed}</td>
          <td>${x.passing.before} → <b>${x.passing.after}</b> of ${x.passing.of} ${met ? `<i class="pf-arrow ${met > 0 ? 'good' : 'bad'}">${met > 0 ? '▲' : '▼'}</i>` : ''}</td>
          <td><span class="pf-delta good"><i class="pf-arrow good">▲</i> ${x.improved} better</span> · <span class="pf-delta bad"><i class="pf-arrow bad">▼</i> ${x.worse} worse</span></td></tr>`;
      }).join('')}
    </tbody></table></div></div>` : '<p class="hint">Needs two profiler runs on the Performance tab.</p>'}
    <h3 class="pf-h">Prompt cache <span class="hint">Ballast's own Claude runs for this game and its housekeeping, last ${days} days; cloud sessions cache on claude.ai and aren't counted</span></h3>
    ${d.cache?.runs ? `<div class="bd-tiles">
      ${tile('Read from cache', `${d.cache.hit ?? '–'}%`, `of ${(Math.round((d.cache.read + d.cache.write + d.cache.fresh) / 1e5) / 10).toLocaleString()}M input tokens`)}
      ${tile('Runs', d.cache.runs, `cache lifetime ${esc(d.cache.ttl === 'auto' ? 'set by Claude Code' : d.cache.ttl)}`)}
    </div>
    <div class="card"><div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>Run</th><th>Runs</th><th>From cache</th><th>Written</th><th>Uncached</th><th></th></tr></thead><tbody>
      ${d.cache.kinds.map((k) => `<tr><td>${esc(k.kind)}</td><td>${k.runs}</td><td>${k.hit ?? '–'}%</td><td>${(Math.round(k.write / 1e3)).toLocaleString()}k</td><td>${(Math.round(k.fresh / 1e3)).toLocaleString()}k</td><td class="bd-barcell">${inlineBar(k.hit || 0, 100)}</td></tr>`).join('')}
    </tbody></table></div><p class="hint" style="margin:8px 0 0">A run kind that suddenly reads far less from the cache usually means something now changes the start of its prompt: a timestamp, a different tool list, or a model switch.</p></div>` : '<p class="hint">No runs on this PC in this period.</p>'}`;
  el.insertAdjacentHTML('beforeend', tokensSection(gid));
}

document.addEventListener('change', (e) => {
  if (!e.target.matches?.('[data-budget-days]')) return;
  BUDGET.days[S.gameId] = Number(e.target.value);
  delete BUDGET.data[S.gameId];
  renderBudget();
});

// ---------------------------------------------------------------------------
// Roadmap: GDD features × L0-L3 quality levels, milestones and forecasts

const LV = (n) => S.st.levels?.[n] || { n, name: `L${n}` };
const etaText = (m) => (m.reachedAt ? `reached ${new Date(m.reachedAt).toLocaleDateString()}` : m.remaining === 0 ? 'ready to close' : m.eta ? `≈ ${new Date(m.eta).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : 'no pace yet');

// The last level audit, under the milestones header.
function levelAuditCard(a) {
  if (!a) return '';
  if (a.status === 'error') return `<p class="hint" style="color:var(--red)">Level audit failed: ${esc(a.error || '')}</p>`;
  if (!a.at) return '';
  return `<div class="card audit-card"><div class="row" style="gap:8px"><b class="grow">Level audit ${esc(ago(a.at))}</b><span class="hint" style="margin:0">${esc(a.model || '')}${a.account ? ` on ${esc(a.account)}` : ''}</span></div>
    <p style="margin:6px 0">${esc(a.summary || '')}</p>
    <div class="hint" style="margin:0">The roadmap said ${esc(a.said || '?')} · verified ${esc(a.verified || '?')}${a.lowered ? ` · <b style="color:var(--accent)">${a.lowered} lowered</b>` : ''}${a.raised ? ` · ${a.raised} raised` : ''}${a.added ? ` · ${a.added} ticket${a.added > 1 ? 's' : ''} added` : ''}${a.reopened?.length ? ` · reopened ${esc(a.reopened.join(', '))}` : ''}</div></div>`;
}

// "✓ verified L0 (was L3)" on a feature row; the evidence is in its tooltip and the feature view.
function verifiedTag(f) {
  const v = f.verified;
  if (!v) return '<span class="hint vtag" title="Not audited yet: this level comes from the breakdown\'s estimate and finished tickets">unverified</span>';
  const n = v.level;
  const since = f.level > n ? ` · L${f.level} from tickets since` : '';
  const was = v.said != null && v.said !== n ? ` (was ${v.said < 0 ? 'not started' : `L${v.said}`})` : '';
  const tip = v.by === 'director' ? 'Set by you' : `Level audit, ${v.confidence || ''} confidence\n${(v.evidence || []).join('\n')}${v.missing ? `\nMissing for the next level: ${v.missing}` : ''}`;
  return `<span class="vtag ${v.said > n ? 'down' : ''}" title="${esc(tip)}">✓ ${v.by === 'director' ? 'set' : 'verified'} ${n < 0 ? 'not started' : `L${n}`}${was}${since}</span>`;
}

function renderRoadmap() {
  const el = $('#roadmap');
  if (!el) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return; // don't close a dropdown you have open
  const g = game();
  const r = S.st.roadmaps?.[g.id];
  const legend = `<div class="lv-legend">${[0, 1, 2, 3].map((n) => `<span><i class="pip on lv${n}"></i><b>L${n} ${esc(LV(n).name)}</b> ${esc(LV(n).text || '')}</span>`).join('')}</div>`;
  if (!r || (!r.features?.length && r.status !== 'running')) {
    el.innerHTML = `<div class="card rm-empty"><h2 style="margin-top:0">Roadmap</h2>
      <p>Ballast reads your GDD and breaks the game into features, each with four quality levels. Milestones are "these features at this level", like a first playable with the core loop at L1. Ballast keeps the board stocked one level at a time and forecasts each milestone from your real pace.</p>
      ${legend}
      ${r?.status === 'error' ? `<p class="hint" style="color:var(--red)">${esc(r.error)}</p>` : ''}
      <div class="row" style="gap:8px;margin-top:12px"><button class="primary" data-act="roadmap-run" data-model="opus">Break down the GDD</button><button class="ghost" data-act="roadmap-run" data-model="sonnet">Faster (Sonnet)</button>
      <span class="hint" style="margin:0">Reads the repo's GDD${S.st.cloudArtifacts.some((c) => c.gameId === g.id && c.mirrored && (c.role === 'gdd' || /gdd|design doc/i.test(c.title))) ? ' and your claude.ai GDD' : ''}. Takes a few minutes.</span></div></div>`;
    return;
  }
  if (r.status === 'running' && !r.features?.length) {
    el.innerHTML = `<div class="card"><b>Breaking down the GDD…</b><p class="hint">Reading the design docs and the repo (${esc(r.model || '')}). The roadmap appears here when it's done.</p></div>`;
    return;
  }
  const ms = r.milestones.map((m) => {
    const isActive = m.id === r.active;
    return `<div class="card ms${isActive ? ' active' : ''}${m.reachedAt ? ' reached' : ''}">
      <div class="row"><b class="grow">${esc(m.name)}</b>${isActive ? '<span class="pill queued">current</span>' : m.reachedAt ? '<span class="pill success">reached</span>' : ''}</div>
      <div class="hint" style="margin:2px 0 8px">Core at <select class="mini" data-ms="${m.id}" data-k="core">${[0, 1, 2, 3].map((n) => `<option value="${n}"${m.core === n ? ' selected' : ''}>L${n} ${esc(LV(n).name)}</option>`).join('')}</select> · rest at <select class="mini" data-ms="${m.id}" data-k="other">${[0, 1, 2, 3].map((n) => `<option value="${n}"${m.other === n ? ' selected' : ''}>L${n} ${esc(LV(n).name)}</option>`).join('')}</select></div>
      <div class="ms-bar"><i style="width:${Math.round(m.progress * 100)}%"></i></div>
      <div class="row hint" style="margin:6px 0 0"><span class="grow">${Math.round(m.progress * 100)}% · ${m.featuresMet}/${m.features} features there · ${m.remaining} tasks left</span><b style="color:var(--text)">${etaText(m)}</b></div>
      ${!m.reachedAt && m.remaining && m.perDay ? `<div class="hint" style="margin:2px 0 0">at ${m.perDay} tasks/day</div>` : ''}
      ${m.reachedAt ? `<a href="#" class="hint" data-act="ms-reopen" data-id="${m.id}">Reopen</a>` : ''}
    </div>`;
  }).join('');
  const activeMs = r.milestones.find((m) => m.id === r.active);
  const target = (f) => (activeMs ? activeMs.overrides?.[f.id] ?? (f.core ? activeMs.core : activeMs.other) : null);
  const rows = [...r.features].sort((a, b) => b.core - a.core || a.area.localeCompare(b.area) || a.name.localeCompare(b.name)).map((f) => {
    const t = target(f);
    const pips = [0, 1, 2, 3].map((n) => `<i class="pip lv${n}${f.level >= n ? ' on' : f.open[n] ? ' wip' : ''}${t === n ? ' target' : ''}" title="L${n} ${esc(LV(n).name)}: ${esc(f.levels[n]?.done || '')}${f.open[n] ? ` · ${f.open[n]} open task${f.open[n] > 1 ? 's' : ''}` : ''}${f.doneCount[n] ? ` · ${f.doneCount[n]} done` : ''}"></i>`).join('');
    return `<tr><td><span class="link" data-act="feature-open" data-id="${f.id}"><b>${esc(f.name)}</b></span><div class="hint" style="margin:0">${esc(f.summary.slice(0, 110))}${f.summary.length > 110 ? '…' : ''}</div></td>
      <td><span class="pill">${esc(f.area)}</span></td>
      <td><label class="check" style="margin:0"><input type="checkbox" data-core="${f.id}" ${f.core ? 'checked' : ''}><span>core</span></label></td>
      <td class="pips">${pips}<span class="hint" style="display:inline;margin-left:6px">${f.level >= 0 ? `L${f.level}` : 'not started'}${t != null && f.level < t ? ` → L${t}` : ''}</span>${verifiedTag(f)}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="row" style="margin-bottom:12px;gap:8px"><h3 class="grow" style="margin:0">Milestones</h3>
      ${r.status === 'running' ? '<span class="pill queued">re-reading the GDD…</span>' : `<button class="ghost small" data-act="roadmap-run" data-model="${esc(r.model || 'opus')}" title="Keeps your core flags and reached levels">Re-run breakdown</button>`}
      <button class="ghost small" data-act="ms-add">+ Milestone</button>
      ${r.audit?.status === 'running' ? `<span class="pill queued">auditing levels (${esc(r.audit.model || '')})… a few minutes</span>` : `<button class="primary small" data-act="roadmap-audit" data-model="opus" title="Pulls the latest GDD and repo and sets every feature's level from evidence: what a player can really do, your review verdicts and playtest notes, profiler runs. It can lower levels, and adds tickets for what's missing up to the current milestone.">Audit levels honestly</button><button class="ghost small" data-act="roadmap-audit" data-model="sonnet" title="Same audit on Sonnet: faster and lighter on usage, less thorough">Sonnet</button>`}</div>
    ${r.status === 'error' ? `<p class="hint" style="color:var(--red)">${esc(r.error)}</p>` : ''}
    ${levelAuditCard(r.audit)}
    <div class="ms-grid">${ms}</div>
    <div class="row" style="margin:22px 0 8px"><h3 class="grow" style="margin:0">Features <span class="hint" style="display:inline">${r.features.length} from the GDD · filled = reached · striped = in progress · ring = ${activeMs ? esc(activeMs.name) : 'target'}</span></h3></div>
    <div class="card" style="overflow-x:auto"><table class="tbl" style="margin-top:0"><tbody>${rows}</tbody></table></div>
    ${legend}`;
  for (const s of $$('select[data-ms]', el)) s.onchange = () => api('PATCH', `/api/games/${g.id}/roadmap`, { milestone: { id: s.dataset.ms, [s.dataset.k]: Number(s.value) } }).catch(fail);
  for (const c of $$('input[data-core]', el)) c.onchange = () => api('PATCH', `/api/games/${g.id}/roadmap`, { feature: { id: c.dataset.core, core: c.checked } }).catch(fail);
}

function featureModal(id) {
  const g = game();
  const r = S.st.roadmaps[g.id];
  const f = r.features.find((x) => x.id === id);
  const tasks = tasksOf(g.id).filter((t) => t.featureId === f.id);
  modal({
    title: f.name,
    wide: true,
    body: `<p class="hint" style="margin-top:0">${esc(f.summary)}${f.gdd ? ` · GDD: ${esc(f.gdd)}` : ''}</p>
      ${f.verified ? `<div class="card audit-card" style="margin-bottom:10px"><b>${f.verified.by === 'director' ? 'Set by you' : `Level audit ${esc(ago(f.verified.at))}`}: ${f.verified.level < 0 ? 'not started' : `L${f.verified.level} ${esc(LV(f.verified.level).name)}`}</b>${f.verified.confidence ? ` <span class="hint" style="display:inline">${esc(f.verified.confidence)} confidence${f.verified.said != null && f.verified.said !== f.verified.level ? `, the roadmap had said L${f.verified.said}` : ''}</span>` : ''}
        ${f.verified.evidence?.length ? `<ul class="bd-list">${f.verified.evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${f.verified.missing ? `<p class="hint" style="margin:6px 0 0">Missing for the next level: ${esc(f.verified.missing)}</p>` : ''}</div>` : ''}
      ${[0, 1, 2, 3].map((n) => `<div class="lv-block${f.level >= n ? ' on' : ''}"><div class="row"><i class="pip lv${n}${f.level >= n ? ' on' : ''}"></i><b>L${n} ${esc(LV(n).name)}</b>${f.level >= n ? '<span class="pill success">reached</span>' : ''}</div>
        <p>${esc(f.levels[n]?.done || '')}</p>
        ${tasks.filter((t) => t.level === n).map((t) => `<div class="hint" style="margin:2px 0">#${t.num} ${esc(t.title)} <span class="pill ${esc(t.status)}">${esc(t.status)}</span></div>`).join('') || (f.levels[n]?.tasks?.length && f.level < n ? `<div class="hint">Planned: ${f.levels[n].tasks.map((t) => esc(t.title)).join(' · ')}</div>` : '')}</div>`).join('')}
      <label class="field" style="margin-top:12px"><span>Already reached (if the breakdown misjudged it)</span><select name="base">${[-1, 0, 1, 2, 3].map((n) => `<option value="${n}"${(f.base ?? -1) === n ? ' selected' : ''}>${n < 0 ? 'Not started' : `L${n} ${esc(LV(n).name)}`}</option>`).join('')}</select></label>`,
    actions: [{ label: 'Close' }, { label: 'Save', kind: 'primary', onClick: (root) => api('PATCH', `/api/games/${g.id}/roadmap`, { feature: { id: f.id, base: Number($('select[name="base"]', root).value) } }) }],
  });
}

// ▶ Play (web), Run (Windows), Install on Quest (APK), Upload to itch.io, with their status.
function playButtons(b) {
  const p = b.playable;
  if (!p) return '';
  const g = S.st.games.find((x) => x.id === b.gameId);
  const busy = (s) => s?.status === 'installing' || s?.status === 'uploading';
  const state = (s, label) => (!s ? '' : `<span class="hint" style="margin:0;${s.status === 'failed' ? 'color:var(--red)' : ''}">${label}: ${esc(s.status)}${s.error ? ` (${esc(s.error)})` : ''}${s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener">page</a>` : ''}</span>`);
  return `<div class="row play-row">
    ${p.web ? `<a class="btn small primary" href="${esc(p.url)}" target="_blank" rel="noopener">▶ Play</a>` : ''}
    ${p.exe ? `<button class="${p.web ? 'ghost' : 'primary'} small" data-act="build-run" data-id="${b.id}" title="${esc(p.exe)}">▶ Run</button>` : ''}
    ${p.apk ? `<button class="ghost small" data-act="build-quest" data-id="${b.id}" ${busy(b.quest) ? 'disabled' : ''} title="${esc(p.apk)}">${busy(b.quest) ? 'Installing…' : 'Install on Quest'}</button>` : ''}
    <button class="ghost small" data-act="build-itch" data-id="${b.id}" ${busy(b.itch) ? 'disabled' : ''} title="${g?.itch?.target ? `Push to itch.io/${esc(g.itch.target)}` : 'Set your itch.io page in Settings first'}">${busy(b.itch) ? 'Uploading…' : 'Upload to itch.io'}</button>
    ${state(b.quest, 'Quest')}${state(b.itch, `itch.io ${b.itch?.channel || ''}`)}
  </div>`;
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
    ${playButtons(b)}
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

// The Studio is an author developer's home: every game, what it's producing, what it costs,
// and who it's for.
function studioShell() {
  const games = S.st.games.filter((g) => statusOf(g) !== 'archived');
  return `<div class="scroll pad studio" style="flex:1">
    <section><div class="section-head"><h3>Your output</h3><span class="hint">Finished work across every game, and what it costs you</span></div><div id="st-overview"></div></section>
    <section><div class="section-head"><h3>Spend per project</h3><span class="hint">Total tokens each project has used, all time</span></div><div class="card" id="st-tokens"></div></section>
    <section><div class="section-head"><h3>Repo work</h3><span class="hint">Maintenance across a repo rather than one game: merge conflicts, CI, dependencies</span></div>${repoWorkForm()}<div id="st-repo-list"></div></section>
    <section><div class="section-head"><h3>Daily digest</h3><span class="hint">At the start of your working day${S.st.settings.reportWebhook ? ', also sent to your webhook' : ''}</span><button class="ghost small" data-act="digest-now">Digest now</button></div><div id="st-digest"></div></section>
    <section><div class="section-head"><h3>Weekly report</h3><span class="hint" id="st-weekly-hint"></span><button class="ghost small" data-act="weekly-now">Write this week's report</button></div><div id="st-weekly"></div></section>
    <section><div class="section-head"><h3>Games</h3><span class="hint">In development, shipped and archived</span><button class="ghost small" data-act="new-game">+ New game</button></div><div class="game-grid" id="st-games"></div><div id="st-portfolio"></div></section>
    <section><div class="section-head"><h3>Audiences</h3><span class="hint">Bartle Audit: which of Bartle's eight player types each game serves best, and how to reach them</span><button class="ghost small" data-act="audit-run">Run Bartle Audit</button></div><div id="st-audiences"></div></section>
    <section><div class="section-head"><h3>Accounts &amp; limits</h3><span class="hint">Session = 5-hour limit · Weekly = 7-day limit · autopilot pauses an account above ${S.st.settings.limitGuardPct}% · games can set their own cap and rules (game Settings)</span></div><div class="acct-grid" id="st-accounts"></div></section>
    <section><div class="section-head"><h3>Usage reports</h3><span class="hint" id="st-reports-hint"></span><button class="ghost small" data-act="report-now">Report now</button></div><div class="card" id="st-reports"></div></section>
    <section><div class="section-head"><h3>Token usage</h3><span class="hint">Every Claude run Ballast makes: agent turns, artifact syncs, limit checks</span></div><div class="card" id="st-usage"></div></section>
    <section><div class="section-head"><h3>Note to several games</h3></div>
      <div class="targets">${games.map((g) => `<label class="check"><input type="checkbox" name="st-game" value="${g.id}" ${statusOf(g) === 'active' ? 'checked' : ''}><span>${esc(g.name)}</span></label>`).join('')}</div>
      <div class="studio-composer">${composer('studio', 'Studio-wide direction: shared tech, art style, a process change… Each ticked game triages it onto its own board.')}</div>
    </section>
    <section><div class="section-head"><h3>claude.ai artifacts</h3><button class="ghost small" data-act="cloud-track">+ Track a link</button></div><div id="st-cloud"></div></section>
  </div>`;
}

function renderStudio() {
  if (!$('#st-accounts')) return;
  $('#st-accounts').innerHTML = S.st.accounts.map(accountCard).join('');
  $('#st-usage').innerHTML = usagePanel();
  $('#st-tokens').innerHTML = tokensTable();
  renderRepoWork();
  $('#st-reports').innerHTML = reportsPanel();
  const w = S.st.settings.workHours || {};
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  $('#st-reports-hint').textContent = S.st.settings.usageReportMin
    ? `Every ${S.st.settings.usageReportMin} min during working hours: ${w.start || '?'}–${w.end || '?'}, ${(w.days || []).length === 7 ? 'every day' : (w.days || []).map((d) => dayNames[d]).join(' ')} (change in Settings)`
    : 'Scheduled reports are off (Settings)';
  const live = S.st.games.filter((g) => statusOf(g) !== 'archived').sort((a, b) => STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)]);
  $('#st-games').innerHTML = live.map(gameCard).join('') || '<p class="hint">Everything is archived. Restore a game from the table below, or start a new one.</p>';
  $('#st-overview').innerHTML = overviewPanel();
  $('#st-portfolio').innerHTML = portfolioTable();
  $('#st-audiences').innerHTML = audiencesPanel();
  $('#st-digest').innerHTML = digestPanel();
  $('#st-weekly').innerHTML = weeklyPanel();
  const wk = S.st.settings.weeklyReport || { day: 5, time: '16:00' };
  $('#st-weekly-hint').textContent = wk.day == null ? 'Automatic weekly reports are off (Settings)' : `A devlog and social posts per game, written every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wk.day]} at ${wk.time}`;
  $('#st-cloud').innerHTML = cloudInbox();
}

// ---------------------------------------------------------------------------
// Daily digest + weekly report

function digestPanel() {
  const d = S.st.digests?.at(-1);
  if (!d) return '<p class="hint" style="margin:0">No digest yet. The first one arrives at the start of your next working day, or press Digest now.</p>';
  const games = d.games.filter((g) => g.done.length || g.blocked.length || g.reviews || g.questions || g.builds.length || g.needsYou?.length);
  return `<div class="card digest"><div class="row"><b class="grow">${esc(d.headline)}</b><span class="hint" style="margin:0">${clock(d.at)} · since ${clock(d.since)}${d.shareError ? ` · webhook failed: ${esc(d.shareError)}` : ''}</span></div>
    ${games.length ? games.map((g) => `<div class="dg-game"><div class="row"><span class="link" data-act="game" data-id="${g.id}"><b>${esc(g.name)}</b></span><span class="hint" style="margin:0">${g.done.length} done · ${g.open} open${g.builds.length ? ` · builds: ${g.builds.map(esc).join(', ')}` : ''}</span></div>
      ${g.needsYou?.length ? `<ul class="dg-list">${g.needsYou.map((n) => `<li><span class="hi-tag">🙋 NEEDS YOU</span> <span class="link" data-act="inbox">${esc(n)}</span></li>`).join('')}</ul>` : ''}
      ${g.done.length ? `<ul class="dg-list">${g.done.slice(0, 6).map((t) => `<li>✓ ${esc(t.title)}</li>`).join('')}${g.done.length > 6 ? `<li class="hint">… and ${g.done.length - 6} more</li>` : ''}</ul>` : ''}
      ${g.blocked.length ? `<ul class="dg-list blocked">${g.blocked.slice(0, 4).map((t) => `<li>⛔ #${t.num} ${esc(t.title)}${t.why ? ` <span class="hint" style="display:inline">${esc(t.why.slice(0, 100))}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${g.reviews || g.questions ? `<div class="dg-needs">⏳ ${[g.reviews && `${g.reviews} to review`, g.questions && `<span class="link" data-act="inbox">${g.questions} question${g.questions > 1 ? 's' : ''} in your Inbox</span>`].filter(Boolean).join(' · ')}</div>` : ''}</div>`).join('') : '<p class="hint">Quiet day: nothing finished or waiting.</p>'}
  </div>`;
}

function weeklyPanel() {
  const r = S.st.weeklyReports?.at(-1);
  if (!r) return '<p class="hint" style="margin:0">No weekly report yet. Each one has Claude write a devlog, social posts and clip ideas per game from what got finished, aimed at the audiences from its Bartle Audit.</p>';
  return `<div class="hint" style="margin:0 0 8px">${r.status === 'running' ? 'Writing… (a minute or two per game)' : `Week to ${new Date(r.at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`}${r.shareError ? ` · webhook failed: ${esc(r.shareError)}` : ''}</div>
    ${r.games.map((e) => `<div class="card weekly"><div class="row"><b class="grow">${esc(e.name)}</b><span class="hint" style="margin:0">${e.done} done${e.releases ? ` · ${e.releases} release${e.releases > 1 ? 's' : ''}` : ''}</span>
      ${e.out ? `<button class="ghost small" data-act="weekly-copy" data-id="${r.id}" data-game="${e.gameId}">Copy all</button>` : ''}</div>
      ${e.out ? `<p class="positioning">${esc(e.out.headline)}</p>
        <details data-audit="${r.id}-${e.gameId}" ${S.openAudits?.has(`${r.id}-${e.gameId}`) ? 'open' : ''}><summary>Devlog, ${e.out.posts.length} posts, ${e.out.clips.length} clip ideas</summary>
          <div class="md devlog">${md(e.out.devlog)}</div>
          <h4 class="sub-h">Posts</h4>${e.out.posts.map((p, i) => `<div class="wpost"><div class="row"><b class="grow">${esc(p.channel)}</b><button class="icon-btn" data-act="weekly-post-copy" data-id="${r.id}" data-game="${e.gameId}" data-i="${i}" title="Copy">⧉</button></div><p>${esc(p.text)}</p></div>`).join('')}
          <div class="two-col"><div><b>Clip these</b><ul>${e.out.clips.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div><div><b>Coming next</b><ul>${e.out.nextWeek.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div></div>
        </details>` : `<p class="hint" style="margin:6px 0 0">${esc(e.skipped || e.error || (r.status === 'running' ? 'Writing…' : ''))}</p>`}
    </div>`).join('')}`;
}

function weeklyMarkdown(r, gameId) {
  const e = r.games.find((x) => x.gameId === gameId);
  const o = e.out;
  return `# ${e.name}: ${o.headline}\n\n${o.devlog}\n\n## Posts\n${o.posts.map((p) => `### ${p.channel}\n${p.text}`).join('\n\n')}\n\n## Clip these\n${o.clips.map((c) => `- ${c}`).join('\n')}\n\n## Coming next\n${o.nextWeek.map((c) => `- ${c}`).join('\n')}\n`;
}

async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`); } catch { modal({ title: label, wide: true, body: `<textarea style="width:100%;height:60vh">${esc(text)}</textarea>`, actions: [{ label: 'Done' }] }); }
}

// ---------------------------------------------------------------------------
// Discord: bot connection (Settings) and playtest channels (game Settings)

async function discordModal() {
  const d = await api('GET', '/api/discord');
  modal({
    title: 'Discord',
    body: `<p class="hint" style="margin-top:0">A Discord bot reads your playtesters' channels and sends their feedback to each game's team. It runs from this PC: nothing to host.</p>
      ${d.connected ? `<p>Connected as <b>${esc(d.bot.name)}</b>. <a href="${esc(d.invite)}" target="_blank" rel="noopener">Add it to a server</a> (it needs to see the playtest channels), then pick channels in each game's Settings → Playtesters.</p>` : `<ol class="hint" style="padding-left:18px">
        <li>Open the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a> → New Application → name it (e.g. "Ballast").</li>
        <li>Bot → Reset Token → copy it. On the same page turn on <b>Message Content Intent</b> (so it can read messages).</li>
        <li>Paste the token below and Connect. Ballast then gives you the link to add the bot to your server.</li></ol>`}
      ${d.error ? `<p class="hint" style="color:var(--red)">${esc(d.error)}</p>` : ''}
      <label class="field"><span>Bot token</span><input name="token" type="password" autocomplete="off" placeholder="${d.connected ? 'Connected (paste a new token to replace it)' : 'Paste the bot token'}"><small>Stored on this PC only, never shown again.</small></label>`,
    actions: [
      ...(d.connected ? [{ label: 'Disconnect', kind: 'danger', onClick: () => api('POST', '/api/discord', { token: '' }) }] : []),
      { label: 'Close' },
      { label: 'Connect', kind: 'primary', onClick: async (root) => { const t = $('input[name="token"]', root).value; if (!t.trim()) throw new Error('Paste the bot token first.'); const r = await api('POST', '/api/discord', { token: t }); toast(`Connected as ${r.bot.name}`); setTimeout(discordModal, 300); } },
    ],
  });
}

function playtestSection(g) {
  const p = g.playtest || {};
  const chans = p.channels || [];
  return `<h3>Playtesters</h3>
    <p class="hint" style="margin-top:-4px">Feedback players post in your Discord channels becomes notes for this game's team, gathered into one note every few minutes. Ballast reacts ✅ to each message it picks up.</p>
    <div id="pt-box">${chans.length ? `<div class="hint" style="margin:0 0 8px">Reading ${chans.map((c) => `<b style="color:var(--text)">#${esc(c.name)}</b>${c.error ? ` <span style="color:var(--red)">(${esc(c.error)})</span>` : ''}`).join(', ')} · ${p.pending?.length ? `${p.pending.length} message${p.pending.length > 1 ? 's' : ''} waiting · <a href="#" data-act="playtest-flush" data-id="${g.id}">Send now</a>` : 'nothing waiting'}</div>` : '<p class="hint" style="margin:0 0 8px">No channels linked.</p>'}
      <button type="button" class="ghost small" data-act="playtest-pick" data-id="${g.id}">${chans.length ? 'Change channels' : 'Link Discord channels'}</button></div>`;
}

async function playtestModal(gid) {
  const g = S.st.games.find((x) => x.id === gid);
  const d = await api('GET', '/api/discord');
  if (!d.connected) return discordModal();
  let list;
  try { list = await api('GET', '/api/discord/channels'); } catch (err) { return fail(err); }
  const chosen = new Set((g.playtest?.channels || []).map((c) => c.id));
  const byGuild = list.reduce((m, c) => ((m[c.guild] ||= []).push(c), m), {});
  modal({
    title: `Playtest channels: ${g.name}`,
    body: list.length ? `${Object.entries(byGuild).map(([guild, cs]) => `<span class="field-label">${esc(guild)}</span><div class="targets" style="margin-bottom:10px">${cs.map((c) => `<label class="check"><input type="checkbox" name="ch" value="${c.id}" ${chosen.has(c.id) ? 'checked' : ''}><span>#${esc(c.name)}</span></label>`).join('')}</div>`).join('')}
      <label class="field"><span>Gather messages for (minutes) before sending them as one note</span><input name="batchMin" type="number" min="1" max="240" value="${g.playtest?.batchMin || 15}" style="width:100px"></label>`
      : `<p>The bot isn't in any server yet. <a href="${esc(d.invite)}" target="_blank" rel="noopener">Add it to your server</a>, then open this again.</p>`,
    actions: [{ label: 'Cancel' }, ...(list.length ? [{
      label: 'Save', kind: 'primary', onClick: async (root) => {
        const ids = new Set($$('input[name="ch"]:checked', root).map((i) => i.value));
        await api('PATCH', `/api/games/${gid}/playtest`, { channels: list.filter((c) => ids.has(c.id)), batchMin: Number($('input[name="batchMin"]', root).value) });
        toast('Playtest channels saved');
      },
    }] : [])],
  });
}

// ---------------------------------------------------------------------------
// Author developer stats: output, cost and portfolio

const STATUS_LABEL = { active: 'in development', paused: 'paused', shipped: 'shipped', archived: 'archived' };
const STATUS_ORDER = { active: 0, paused: 1, shipped: 2, archived: 3 };
const statusOf = (g) => g?.status || 'active';
const DAY = 86400e3;
// Monthly price of each account's plan; set it on the account, otherwise a list-price guess.
const PLAN_GUESS = { pro: 20, max: 100, team: 30 };
const planPrice = (a) => (a.monthlyCost != null ? a.monthlyCost : PLAN_GUESS[String(a.plan || '').toLowerCase()] ?? 0);
const planGuessed = (a) => a.monthlyCost == null;
const doneTasks = (gid) => S.st.tasks.filter((t) => t.status === 'done' && t.doneAt && (!gid || t.gameId === gid));
const doneIn = (list, from, to = Date.now()) => list.filter((t) => t.doneAt >= from && t.doneAt < to).length;
const lastAuditOf = (gid) => [...(S.st.audits || [])].reverse().find((a) => a.gameId === gid && a.status === 'done');

function lastActivity(g) {
  const times = [...tasksOf(g.id).map((t) => t.updatedAt || t.createdAt || 0), ...S.st.builds.filter((b) => b.gameId === g.id).map((b) => b.startedAt || 0), ...agentsOf(g.id, { all: true }).map((a) => a.lastActive || 0)];
  return Math.max(0, ...times);
}

function overviewPanel() {
  const now = Date.now();
  const done = doneTasks();
  const week = doneIn(done, now - 7 * DAY);
  const lastWeek = doneIn(done, now - 14 * DAY, now - 7 * DAY);
  const month = doneIn(done, now - 30 * DAY);
  const builds = S.st.builds.filter((b) => b.startedAt >= now - 7 * DAY);
  const captures = S.st.artifacts.filter((a) => (a.createdAt || 0) >= now - 7 * DAY).length;
  const counts = Object.fromEntries(Object.keys(STATUS_LABEL).map((s) => [s, S.st.games.filter((g) => statusOf(g) === s).length]));
  // Tasks finished per day for the last 14 days, and the streak of days with something finished.
  const today0 = new Date().setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => { const from = today0 - (13 - i) * DAY; return { from, n: doneIn(done, from, from + DAY) }; });
  let streak = 0;
  for (let d = days[13].n ? today0 : today0 - DAY; doneIn(done, d, d + DAY) > 0; d -= DAY) streak++;
  const max = Math.max(1, ...days.map((d) => d.n));
  const spark = `<svg viewBox="0 0 140 36" class="spark">${days.map((d, i) => `<rect x="${i * 10 + 1}" y="${36 - (d.n / max) * 34}" width="8" height="${Math.max(1, (d.n / max) * 34)}" rx="1.5"><title>${new Date(d.from).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${d.n} done</title></rect>`).join('')}</svg>`;
  const plans = S.st.accounts.reduce((s, a) => s + planPrice(a), 0);
  const guessed = S.st.accounts.some((a) => planGuessed(a) && a.plan);
  const api = S.usage?.totals?.month?.cost || 0;
  const perTask = month ? plans / month : 0;
  const trend = week === lastWeek ? '' : week > lastWeek ? `<span class="up">▲ ${week - lastWeek}</span>` : `<span class="down">▼ ${lastWeek - week}</span>`;
  const headroom = S.st.accounts.filter((a) => a.loggedIn).map((a) => ({ a, left: 100 - Math.round(Math.max(0, ...windowsOf(a).filter((w) => /Weekly/.test(w.label)).map((w) => (w.utilization || 0) * 100))) })).sort((x, y) => y.left - x.left);
  const tile = (label, value, sub = '') => `<div class="tile"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  return `<div class="tiles">
    ${tile('Finished this week', `${week} ${trend}`, `${lastWeek} the week before · ${done.length} all time`)}
    ${tile('Last 14 days', spark, streak ? `${streak}-day streak of finished work` : 'Nothing finished today yet')}
    ${tile('Builds this week', `${builds.filter((b) => b.status === 'success' || b.status === 'checkin').length}<span class="of"> / ${builds.length}</span>`, `${captures} captures and artifacts this week`)}
    ${tile('Games', `${counts.active + counts.paused}<span class="of"> in development</span>`, `${counts.shipped} shipped · ${counts.archived} archived`)}
    ${tile('Plans', `${money(plans)}<span class="of"> / month</span>`, `${S.st.accounts.length} account${S.st.accounts.length === 1 ? '' : 's'}${guessed ? ' · some prices guessed: set them on each account (✎)' : ''}`)}
    ${tile('Cost per finished task', month ? money(perTask) : '–', month ? `plans ÷ ${month} tasks in the last 30 days` : 'Finish some tasks first')}
    ${tile('API value, 30 days', money(api), plans && api / plans >= 0.1 ? `${(api / plans).toFixed(1)}× your plans · runs on this PC only; cloud sessions aren't metered` : "runs on this PC only; cloud sessions aren't metered")}
    ${tile('Weekly headroom', headroom.length ? `${headroom[0].left}%<span class="of"> left</span>` : '–', headroom.length ? `most on ${esc(headroom[0].a.name)}${headroom.length > 1 ? ` · least: ${esc(headroom.at(-1).a.name)} ${headroom.at(-1).left}%` : ''}` : 'No limit data yet')}
  </div>`;
}

// Every game in one table. Plan cost is split by each game's share of the tasks finished in the
// last 30 days, so cloud games (whose sessions aren't metered) get a fair share too.
function portfolioTable() {
  const now = Date.now();
  const games = [...S.st.games].sort((a, b) => STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)] || lastActivity(b) - lastActivity(a));
  if (!games.length) return '';
  const monthAll = doneIn(doneTasks(), now - 30 * DAY);
  const plans = S.st.accounts.reduce((s, a) => s + planPrice(a), 0);
  const rows = games.map((g) => {
    const done = doneTasks(g.id);
    const m = doneIn(done, now - 30 * DAY);
    const share = monthAll ? m / monthAll : 0;
    const s = statusOf(g);
    const age = Math.max(1, Math.round(((g.shippedAt || now) - (g.createdAt || now)) / DAY));
    const audit = lastAuditOf(g.id);
    const rel = g.releases?.at(-1);
    const api = S.usage?.totals?.byGame?.[g.id]?.month?.cost || 0;
    const last = lastActivity(g);
    return `<tr class="${s === 'archived' ? 'archived' : ''}">
      <td><span class="link" data-act="game" data-id="${g.id}">${esc(g.name)}</span>${rel ? `<div class="hint" style="margin:0">${esc([rel.version, rel.platforms].filter(Boolean).join(' · '))}${rel.url ? ` · <a href="${esc(rel.url)}" target="_blank" rel="noopener">page</a>` : ''}</div>` : ''}</td>
      <td><span class="pill ${s}">${STATUS_LABEL[s]}</span></td>
      <td>${s === 'shipped' ? `shipped in ${age}d` : `${age}d`}</td>
      <td><b>${doneIn(done, now - 7 * DAY)}</b> <span class="hint" style="display:inline">/ ${done.length}</span></td>
      <td>${tasksOf(g.id).filter((t) => t.status === 'open' || t.status === 'claimed').length}</td>
      <td>${last ? ago(last) : '–'}</td>
      <td><span class="share"><i style="width:${Math.round(share * 100)}%"></i></span> ${Math.round(share * 100)}%</td>
      <td>${plans && m ? money(plans * share) : '–'}</td>
      <td>${api ? money(api) : '–'}</td>
      <td>${audit ? `<span class="hint" style="display:inline" title="${esc(audit.result.top.map((t) => `${t.subtype} ${t.fit}`).join(', '))}">${esc(audit.result.top.slice(0, 2).map((t) => t.subtype).join(', '))}</span>` : '<span class="hint" style="display:inline">no audit</span>'}</td>
      <td class="row-actions">${s === 'archived'
        ? `<button class="ghost small" data-act="game-restore" data-id="${g.id}">Restore</button>`
        : `${s !== 'shipped' ? `<button class="ghost small" data-act="game-ship" data-id="${g.id}">Ship</button>` : `<button class="ghost small" data-act="game-ship" data-id="${g.id}" title="Record another release">+ Release</button>`}<button class="ghost small" data-act="game-archive" data-id="${g.id}">Archive</button>`}</td>
    </tr>`;
  }).join('');
  return `<div class="card" style="margin-top:12px;overflow-x:auto"><table class="tbl portfolio" style="margin-top:0"><thead><tr><th>Game</th><th>Status</th><th>Age</th><th>Done 7d / all</th><th>Open</th><th>Last activity</th><th>Share of output (30d)</th><th>Plan cost (30d)</th><th>API value (30d)</th><th>Audience</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Bartle Audit

const FAMILY_COLOR = { Achiever: 'var(--accent)', Explorer: 'var(--blue)', Socialiser: 'var(--green)', Killer: 'var(--red)' };

function audiencesPanel() {
  const games = S.st.games.filter((g) => statusOf(g) !== 'archived');
  const cards = games.map((g) => {
    const all = (S.st.audits || []).filter((a) => a.gameId === g.id);
    const running = all.find((a) => a.status === 'running');
    const latest = [...all].reverse().find((a) => a.status !== 'running');
    if (!running && !latest) return '';
    return auditCard(g, latest, running);
  }).filter(Boolean);
  return cards.length ? cards.join('') : '<p class="hint" style="margin:0">No audits yet. Run one to find out which kinds of players each game is really for, and get a marketing plan for each.</p>';
}

function auditCard(g, a, running) {
  const head = `<div class="row"><b class="grow">${esc(g.name)}</b>
    ${running ? `<span class="pill queued">auditing… ${dur(Date.now() - running.startedAt).split(' ')[0]}</span>` : ''}
    ${a ? `<span class="hint" style="margin:0">${clock(a.finishedAt || a.startedAt)}${a.model ? ` · ${esc(a.model)}` : ''}</span>` : ''}
    ${a?.status === 'done' ? `<button class="ghost small" data-act="audit-copy" data-id="${a.id}">Copy as Markdown</button>` : ''}
    ${a ? `<button class="icon-btn" data-act="audit-delete" data-id="${a.id}" title="Remove this audit">✕</button>` : ''}</div>`;
  if (!a) return `<div class="card audit">${head}<p class="hint">Reading the game: repo, brief and board. This takes a few minutes.</p></div>`;
  if (a.status === 'error') return `<div class="card audit">${head}<p class="hint" style="color:var(--red)">${esc(a.error || 'Failed')}</p></div>`;
  const r = a.result;
  const list = (items) => (items?.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  return `<div class="card audit">${head}
    <p class="positioning">${esc(r.positioning)}</p>
    <p class="hint" style="margin:0 0 12px">${esc(r.summary)}</p>
    <div class="bartle">${r.top.map((t, i) => `<div class="btype" style="--fam:${FAMILY_COLOR[t.family] || 'var(--muted)'}">
        <div class="row"><b class="grow">${i + 1}. ${esc(t.subtype)}</b><span class="fam">${esc(t.family)}</span></div>
        <div class="fit"><i style="width:${t.fit}%"></i></div><small>${t.fit}% fit</small>
        <p>${esc(t.pitch)}</p></div>`).join('')}</div>
    <div class="ranking hint">All eight: ${r.ranking.map((x) => `${esc(x.subtype)} ${x.fit}`).join(' · ')}</div>
    <details data-audit="${a.id}" ${S.openAudits?.has(a.id) ? 'open' : ''}><summary>Marketing plan</summary>
      ${r.top.map((t) => `<div class="bplan"><h4 style="color:${FAMILY_COLOR[t.family] || 'inherit'}">${esc(t.subtype)} <span class="hint" style="display:inline">${esc(t.family)}</span></h4>
        <p>${esc(t.why)}</p>
        <div class="two-col"><div><b>In the game now</b>${list(t.evidence)}</div><div><b>What they'd want more of</b>${list(t.gaps)}</div>
        <div><b>Where to find them</b>${list(t.channels)}</div><div><b>Content that lands</b>${list(t.content)}</div>
        <div><b>Say</b>${list(t.say)}</div><div><b>Avoid</b>${list(t.avoid)}</div></div></div>`).join('')}
      <div class="bplan"><h4>Store page draft</h4><p style="white-space:pre-wrap">${esc(r.storeCopy)}</p></div>
      <div class="two-col"><div><b>Launch plan</b>${r.launchPlan?.length ? `<ol>${r.launchPlan.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}</div><div><b>Comparable games</b>${list(r.comparables)}<b>Risks</b>${list(r.risks)}</div></div>
    </details></div>`;
}

// The Studio redraws on every update; remember which marketing plans are open.
document.addEventListener('toggle', (e) => {
  const id = e.target.dataset?.audit;
  if (!id) return;
  S.openAudits ||= new Set();
  if (e.target.open) S.openAudits.add(id);
  else S.openAudits.delete(id);
}, true);

function auditMarkdown(a) {
  const g = S.st.games.find((x) => x.id === a.gameId);
  const r = a.result;
  const bullets = (items) => (items || []).map((x) => `- ${x}`).join('\n');
  return `# ${g?.name || 'Game'}: Bartle Audit (${new Date(a.finishedAt).toLocaleDateString()})

**${r.positioning}**

${r.summary}

## Top audiences
${r.top.map((t, i) => `${i + 1}. **${t.subtype}** (${t.family}), ${t.fit}% fit: ${t.pitch}`).join('\n')}

All eight: ${r.ranking.map((x) => `${x.subtype} ${x.fit}`).join(', ')}

${r.top.map((t) => `## ${t.subtype} (${t.family})
${t.why}

**In the game now**
${bullets(t.evidence)}

**What they'd want more of**
${bullets(t.gaps)}

**Where to find them**
${bullets(t.channels)}

**Content that lands**
${bullets(t.content)}

**Say**
${bullets(t.say)}

**Avoid**
${bullets(t.avoid)}`).join('\n\n')}

## Store page draft
${r.storeCopy}

## Launch plan
${(r.launchPlan || []).map((x, i) => `${i + 1}. ${x}`).join('\n')}

## Comparable games
${bullets(r.comparables)}

## Risks
${bullets(r.risks)}
`;
}

function auditModal() {
  const games = S.st.games.filter((g) => statusOf(g) !== 'archived');
  if (!games.length) return toast('Create a game first.', true);
  modal({
    title: 'Bartle Audit',
    body: `<p class="hint" style="margin-top:0">Claude reads each game (repo, brief, board) and ranks Bartle's eight player subtypes by how well the game serves them, then writes a marketing plan for the top four: where to find them, what content lands, what to say and avoid, a store page draft and a launch plan.</p>
      <div class="targets" style="margin:10px 0">${games.map((g) => `<label class="check"><input type="checkbox" name="g" value="${g.id}" ${statusOf(g) === 'paused' ? '' : 'checked'}><span>${esc(g.name)} <span class="hint" style="display:inline">${STATUS_LABEL[statusOf(g)]}${lastAuditOf(g.id) ? `, last audited ${ago(lastAuditOf(g.id).finishedAt)}` : ''}</span></span></label>`).join('')}</div>
      <label class="field"><span>Model</span><select name="model"><option value="opus">Opus (best judgement)</option><option value="sonnet">Sonnet (faster, lighter on usage)</option></select><small>Each game takes a few minutes and runs on the account with the most headroom.</small></label>`,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Run audit', kind: 'primary', onClick: async (root) => {
          const gameIds = $$('input[name="g"]:checked', root).map((i) => i.value);
          if (!gameIds.length) throw new Error('Pick at least one game.');
          const r = await api('POST', '/api/audits', { gameIds, model: $('select[name="model"]', root).value });
          toast(r.started ? `Auditing ${r.started} game${r.started > 1 ? 's' : ''}…` : 'Those games are already being audited.');
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Game life cycle: ship, archive, restore

function shipModal(id) {
  const g = S.st.games.find((x) => x.id === id);
  const again = statusOf(g) === 'shipped';
  modal({
    title: again ? `New release: ${g.name}` : `Ship ${g.name}`,
    body: `<p class="hint" style="margin-top:0">${again ? 'Record an update you shipped.' : 'Marks the game as shipped. Autopilot stops, check-in builds stop, and your notes still reach the agents for patches. You can move it back into development any time.'}</p>
      <div class="two"><label class="field"><span>Version</span><input name="version" placeholder="1.0"></label>
      <label class="field"><span>Platforms</span><input name="platforms" placeholder="Quest, Steam, itch.io…"></label></div>
      <label class="field"><span>Store or game page</span><input name="url" placeholder="https://…"></label>
      <label class="field"><span>Release notes</span><textarea name="notes" rows="3"></textarea></label>`,
    actions: [
      { label: 'Cancel' },
      { label: again ? 'Record release' : 'Mark as shipped', kind: 'primary', onClick: async (root) => {
        const f = formData(root);
        await api('PATCH', `/api/games/${id}`, { status: 'shipped', release: f, ...(again ? { releaseOnly: true } : {}) });
        toast(again ? 'Release recorded' : `${g.name} shipped 🎉`);
      } },
    ],
  });
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
    ${needsRepair(a) ? `<div class="acct-alert"><b>Signed out.</b> ${esc(a.name)}'s claude.ai sign-in ${a.authBroken ? `lapsed ${esc(ago(a.authBroken.at))} (${esc((a.authBroken.error || '').slice(0, 140))})` : 'is no longer valid'}, so its agents are paused instead of failing over and over.
        <div class="row" style="gap:6px;margin-top:8px"><button class="primary small" data-act="acct-repair" data-id="${a.id}">Repair sign-in</button></div></div>` : ''}
    ${a.signedInAs ? `<div class="acct-alert"><b>Paused.</b> ${a.isDefault ? "This PC's Claude login" : 'Its login'} is now <b>${esc(a.signedInAs)}</b>, not ${esc(a.email)}, so its agents are waiting rather than spending the wrong account's usage.
        <div class="row" style="gap:6px;margin-top:8px">${a.isDefault ? `<button class="primary small" data-act="acct-detach" data-id="${a.id}">Give ${esc(a.name)} its own login</button>` : `<button class="primary small" data-act="acct-login" data-id="${a.id}">Sign in as ${esc(a.email)} again</button>`}
        <button class="ghost small" data-act="acct-accept" data-id="${a.id}">Use ${esc(a.signedInAs)} for ${esc(a.name)} from now on</button></div></div>`
      : a.isDefault ? `<div class="acct-note">Uses this PC's Claude login, which changes when you switch accounts in the Claude app or CLI. <a href="#" data-act="acct-detach" data-id="${a.id}">Give it its own login</a> so Ballast keeps running whatever you're signed into.</div>` : ''}
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

// The latest limit report as a table, with earlier ones folded underneath.
function reportsPanel() {
  const reports = [...(S.st.usageReports || [])].reverse();
  if (!reports.length) return '<p class="hint" style="margin:0">No reports yet. The first one arrives at the start of your working hours, or press Report now.</p>';
  const resets = (ms) => (ms ? (ms - Date.now() < 36 * 3600e3 ? `resets in ${dur(Math.max(0, ms - Date.now())).replace(/ \d+s$/, '')}` : `resets ${new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`) : '');
  const pct = (w) => (w ? `<b class="${w.pct >= 90 ? 'hot' : w.pct >= 70 ? 'warn' : ''}">${w.pct}%</b> <span class="hint" style="display:inline">${resets(w.resetsAt)}</span>` : '<span class="hint" style="display:inline">?</span>');
  const table = (r) => `<table class="tbl" style="margin-top:0"><thead><tr><th>Account</th><th>Session (5h)</th><th>Weekly (7d)</th><th>Tokens today</th><th></th></tr></thead><tbody>
    ${r.accounts.map((a) => `<tr><td>${esc(a.name)}<div class="hint" style="margin:0">${esc(a.email)}</div></td><td>${pct(a.session)}</td><td>${pct(a.weekly)}</td><td>${fmtTokens(a.tokensToday)} <span class="hint" style="display:inline">${money(a.costToday)}</span></td>
      <td>${a.status === 'ok' ? '' : `<span class="pill ${a.status === 'near limit' ? 'limited' : 'error'}">${esc(a.status)}</span>`}</td></tr>`).join('')}</tbody></table>`;
  const [latest, ...older] = reports;
  return `<div class="hint" style="margin:0 0 6px">Latest: ${clock(latest.at)}${latest.reason === 'manual' ? ' (on request)' : ''}${latest.shareError ? ` · webhook failed: ${esc(latest.shareError)}` : ''}</div>${table(latest)}
    ${older.length ? `<details style="margin-top:10px"><summary class="hint" style="display:inline;cursor:pointer">Earlier reports (${older.length})</summary>${older.map((r) => `<div class="hint" style="margin:12px 0 4px">${clock(r.at)}</div>${table(r)}`).join('')}</details>` : ''}`;
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
  const s = statusOf(g);
  const rel = g.releases?.at(-1);
  return `<div class="card game-card${s === 'paused' ? ' paused' : ''}${s === 'shipped' ? ' shipped' : ''}">
    <div class="row"><b class="grow link" data-act="game" data-id="${g.id}">${esc(g.name)}</b>
      ${s !== 'active' ? `<span class="pill ${s}">${STATUS_LABEL[s]}${s === 'shipped' && rel?.version ? ` ${esc(rel.version)}` : ''}</span>` : ''}
      ${s === 'active' ? `<span class="pill">${PRIORITY[g.priority ?? 2]}</span>` : ''}</div>
    ${g.usagePolicy?.cap || g.usagePolicy?.rules?.some((r) => r.on) ? `<div class="hint" style="margin:6px 0 0">${g.usagePolicy.cap ? `Stops at ${g.usagePolicy.cap}% of an account` : 'No cap'} · ${g.usagePolicy.rules.filter((r) => r.on).length} usage rule${g.usagePolicy.rules.filter((r) => r.on).length === 1 ? '' : 's'}${agents.some((a) => a.status === 'capped') ? ' · <b style="color:var(--accent)">holding work now</b>' : ''}</div>` : ''}
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
      ${s === 'shipped'
        ? `<button class="ghost small" data-act="game-status" data-id="${g.id}" data-status="active" title="Autopilot picks up open tasks again">Back to development</button>`
        : `<button class="ghost small" data-act="game-status" data-id="${g.id}" data-status="${s === 'paused' ? 'active' : 'paused'}">${s === 'paused' ? 'Resume' : 'Pause'}</button>
      <button class="ghost small" data-act="game-ship" data-id="${g.id}">Ship</button>
      <select class="mini" data-act-change="game-priority" data-id="${g.id}" title="Which game gets account time first when accounts are busy">
        ${[3, 2, 1].map((p) => `<option value="${p}"${(g.priority ?? 2) === p ? ' selected' : ''}>${PRIORITY[p]} priority</option>`).join('')}
      </select>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// claude.ai artifacts

const ROLE_INFO = {
  gdd: 'GDD: the source of truth; every agent reads it, and its changes become notes for the team',
  review:'Director review: page changes and comments become notes for the team',
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
      ${c.doc ? `<div class="hint" style="margin:4px 0 0">Claude Docs · ${c.doc.tabs.length} tabs · about ${c.doc.words.toLocaleString()} words, read ${esc(ago(c.doc.at))} through the Claude Docs connector</div>` : ''}${c.docError ? `<div class="hint" style="margin:4px 0 0;color:var(--red)">${esc(c.docError)}</div>` : ''}
      ${c.dataSummary ? `<details><summary class="hint" style="display:inline;cursor:pointer">Live data</summary><div class="md">${md(c.dataSummary)}</div></details>` : ''}
      ${open.length ? `<div class="threads">${open.map((t) => `<div class="thread">${t.messages.map((m) => `<div><b>${esc(m.author || '?')}</b> ${esc(m.text)}${m.at ? ` <span class="hint" style="display:inline">${esc(m.at)}</span>` : ''}</div>`).join('')}</div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

const disciplineOptions = (cur) => `<option value="">Guess from the title</option>${S.st.disciplines.map((d) => `<option value="${d.id}"${d.id === cur ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}<option value="other"${cur === 'other' ? ' selected' : ''}>Other</option>`;

function trackModal({ url = '', accountId = '', discipline = '', gameId = S.view === 'game' ? S.gameId : '' } = {}) {
  const loggedIn = S.st.accounts.filter((a) => a.loggedIn);
  modal({
    title: 'Track a claude.ai artifact',
    body: `<label class="field"><span>Link</span><input name="url" value="${esc(url)}" placeholder="https://claude.ai/artifact/…"></label>
      <label class="field"><span>Game</span><select name="gameId"><option value="">No game yet</option>${S.st.games.map((g) => `<option value="${g.id}"${g.id === gameId ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Role</span><select name="role">${Object.entries(ROLE_INFO).map(([k, v]) => `<option value="${k}"${k === 'review' ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>Department</span><select name="discipline">${disciplineOptions(discipline)}</select><small>Which department tab shows it.</small></label>
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
      <label class="field"><span>Department</span><select name="discipline">${disciplineOptions(c.discipline)}</select></label>
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
// Director Review: talk while you play. The browser transcribes as you speak (Web Speech API,
// Chrome/Edge); when you're done, the cleaned-up transcript goes to every agent on the game.

const RS = { rec: null, active: false, paused: false, segments: [], interim: '', startedAt: 0, pausedMs: 0, pausedAt: 0, gameId: null, timer: null };
const RS_DRAFT = 'reviewDraft';

const rsElapsed = () => (RS.startedAt ? (RS.paused ? RS.pausedAt : Date.now()) - RS.startedAt - RS.pausedMs : 0);
const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
// What gets sent: rejected lines are left out; typed lines are the director's own words.
const rsText = () => RS.segments.filter((s) => !s.rejected && s.text.trim())
  .map((s) => (s.mark ? `\n[${mmss(s.t)}] ★ ${s.text}\n` : `[${mmss(s.t)}] ${s.typed ? '(typed) ' : ''}${s.text}`)).join('\n').trim();

// Chrome's recognizer is much more accurate when its accent setting matches the speaker.
const SPEECH_LANGS = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-CA', 'English (Canada)'], ['en-AU', 'English (Australia)'], ['en-IE', 'English (Ireland)'], ['en-NZ', 'English (NZ)'], ['en-IN', 'English (India)'], ['fr-CA', 'Français (Canada)'], ['fr-FR', 'Français'], ['es-ES', 'Español'], ['de-DE', 'Deutsch']];
const speechLang = () => load('speechLang') || navigator.language || 'en-US';
// Whisper (on this PC) when it's installed; the browser's recognizer otherwise.
const speechEngine = () => (RS.whisper?.installed && load('speechEngine') !== 'browser' ? 'whisper' : 'browser');

function rsSaveDraft() {
  store(RS_DRAFT, JSON.stringify({ gameId: RS.gameId, segments: RS.segments, elapsed: rsElapsed(), at: Date.now() }));
}

function rsPanel() {
  let el = $('#review-session');
  if (!el) {
    el = document.createElement('div');
    el.id = 'review-session';
    el.className = 'review-session';
    $('#composer-feed')?.before(el);
  }
  return el;
}

// The live panel is edited while it's recording, so it renders line by line: new speech is
// appended and a line you're correcting is never redrawn under your cursor.
function rsRender() {
  const el = rsPanel();
  if (!$('.rs-text', el)) {
    el.innerHTML = `<div class="rs-head"></div>
      <div class="rs-text" id="rs-text"><div class="rs-empty hint">Start playing and talk through what you notice. Say "mark that" to flag a moment. Click any line to correct it, ✕ to leave it out, or type a line below. Screenshots pasted into the box under this panel go out with your notes.</div><div class="rs-interim"></div></div>
      <div class="rs-add"><input id="rs-add" placeholder="Type a line (Enter adds it at the current time)…" autocomplete="off">${RS.whisper?.installed ? `<select id="rs-engine" title="Who turns your speech into text"><option value="whisper"${speechEngine() === 'whisper' ? ' selected' : ''}>Whisper (this PC)</option><option value="browser"${speechEngine() === 'browser' ? ' selected' : ''}>Chrome</option></select>` : ''}<select id="rs-lang" title="Speech recognition accent: matching yours makes it much more accurate">${SPEECH_LANGS.map(([v, l]) => `<option value="${v}"${v === speechLang() ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
    $('#rs-add', el).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      e.preventDefault();
      RS.segments.push({ t: rsElapsed(), text: e.target.value.trim(), typed: true });
      e.target.value = '';
      rsSaveDraft();
      rsRender();
    });
    $('#rs-lang', el).onchange = (e) => {
      store('speechLang', e.target.value);
      // Restart recognition so the new accent takes effect straight away.
      if (RS.active && !RS.paused) { try { RS.rec?.stop(); } catch { /* restarts on end */ } RS.rec = null; rsListen(); }
    };
    if ($('#rs-engine', el)) $('#rs-engine', el).onchange = (e) => {
      store('speechEngine', e.target.value);
      whStop(true);
      RS.interim = '';
      if (RS.active && !RS.paused) { try { RS.rec?.stop(); } catch { /* restarts on end */ } RS.rec = null; rsListen(); }
      rsRender();
    };
  }
  const state = RS.paused ? 'Paused' : RS.active ? 'Listening… talk as you play' : 'Stopped';
  const kept = RS.segments.filter((s) => !s.mark && !s.rejected).length;
  const rejected = RS.segments.filter((s) => s.rejected).length;
  $('.rs-head', el).innerHTML = `
      <span class="rec-dot${RS.active && !RS.paused ? ' on' : ''}"></span><b>Director Review</b>
      <span class="rs-time">${mmss(rsElapsed())}</span><span class="hint" style="margin:0">${state} · ${kept} lines${rejected ? ` · ${rejected} left out` : ''}${speechEngine() === 'whisper' ? ` · Whisper${RS.whPending ? `, writing ${RS.whPending}…` : ''}` : ''}</span>
      <span class="spacer"></span>
      <button class="ghost small" data-act="review-mark" title="Drop a marker here. Or just say &quot;mark that&quot; while you play.">★ Mark moment</button>
      <button class="ghost small" data-act="review-pause">${RS.paused ? 'Resume' : 'Pause'}</button>
      <button class="primary small" data-act="review-done">Done, review notes</button>
      <button class="ghost small" data-act="review-discard">Discard</button>`;

  const box = $('#rs-text', el);
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const editing = document.activeElement?.closest?.('.rs-line');
  const interimEl = $('.rs-interim', box);
  $('.rs-empty', box).style.display = RS.segments.length || RS.interim ? 'none' : '';
  RS.segments.forEach((s, i) => {
    let row = box.querySelector(`.rs-line[data-seg="${i}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'rs-line';
      row.dataset.seg = i;
      row.innerHTML = `<span class="rs-t"></span><span class="rs-say" contenteditable="true" spellcheck="true"></span><button type="button" class="rs-x" data-act="rs-toggle" data-i="${i}"></button>`;
      box.insertBefore(row, interimEl);
    }
    row.classList.toggle('rs-mark', !!s.mark);
    row.classList.toggle('rejected', !!s.rejected);
    row.classList.toggle('typed', !!s.typed);
    row.classList.toggle('edited', !!s.edited);
    $('.rs-t', row).textContent = `${mmss(s.t)}${s.mark ? ' ★' : ''}`;
    if (row !== editing && $('.rs-say', row).textContent !== s.text) $('.rs-say', row).textContent = s.text;
    const x = $('.rs-x', row);
    x.textContent = s.rejected ? '↺' : '✕';
    x.title = s.rejected ? 'Put this line back' : 'Leave this line out';
  });
  interimEl.innerHTML = RS.interim ? `<span class="rs-t">${mmss(rsElapsed())}</span>${esc(RS.interim)}${speechEngine() === 'whisper' ? ' …' : ''}` : '';
  if (stick && !editing) box.scrollTop = box.scrollHeight;
}

// Corrections typed into a line are kept, and new speech never merges into that line again.
document.addEventListener('input', (e) => {
  const say = e.target.closest?.('.rs-say');
  if (!say) return;
  const s = RS.segments[Number(say.closest('.rs-line').dataset.seg)];
  if (!s) return;
  s.text = say.textContent;
  s.edited = true;
  say.closest('.rs-line').classList.add('edited');
  rsSaveDraft();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest?.('.rs-say')) { e.preventDefault(); e.target.blur(); }
});

// With Whisper, Chrome's recognizer still runs, but only to show words live as you talk; the
// line that's kept is Whisper's, written a moment after each phrase ends.
function rsListen() {
  const whisper = speechEngine() === 'whisper';
  if (whisper) whStart();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = speechLang();
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim();
      if (!text) continue;
      if (!e.results[i].isFinal) interim += `${text} `;
      else if (!whisper) rsAddSpeech(text);
    }
    RS.interim = interim.trim();
    if (!whisper) rsSaveDraft();
    rsRender();
  };
  rec.onerror = (e) => {
    if (whisper) return; // only the live preview is affected
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
      RS.active = false;
      toast(e.error === 'audio-capture' ? 'No microphone found. Plug one in and try again.' : 'Microphone access was blocked. Allow it for this page (address bar) and try again.', true);
      rsRender();
    } else if (e.error === 'network' && !RS.netWarned) {
      RS.netWarned = true;
      toast('Speech recognition lost its connection; it keeps retrying. Lines may be missing for a moment.', true);
    }
  };
  // Browsers end recognition after silences or about a minute. Whatever was mid-sentence at that
  // moment never becomes "final", so keep it rather than lose it, then restart straight away.
  rec.onend = () => {
    if (RS.rec !== rec) return;
    if (RS.interim) {
      if (!whisper) rsAddSpeech(RS.interim);
      RS.interim = '';
      rsSaveDraft();
      rsRender();
    }
    if (RS.active && !RS.paused) setTimeout(() => { try { rec.start(); } catch { /* already restarting */ } }, 60);
  };
  RS.rec = rec;
  rec.start();
}

// Whisper capture: record the mic, cut it into phrases at pauses (a simple loudness gate that
// adapts to the room), and send each phrase to Ballast to transcribe on this PC, in order.
const WH = { ctx: null, stream: null, node: null, phrase: null, preroll: [], floor: 0.004, queue: Promise.resolve() };
const WH_TAP = `registerProcessor('rs-tap', class extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.b[this.n++] = ch[i]; if (this.n === this.b.length) { this.port.postMessage(this.b); this.b = new Float32Array(2048); this.n = 0; } }
    return true;
  }
});`;
const PHRASE_END_MS = 800; // this much quiet ends a phrase
const PHRASE_MAX_MS = 25000; // long monologues are cut so lines keep coming

async function whStart() {
  if (WH.ctx) return;
  WH.ctx = 'starting';
  api('POST', '/api/whisper/warm').catch(() => {});
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WH_TAP], { type: 'text/javascript' })));
    if (WH.ctx !== 'starting') { stream.getTracks().forEach((tr) => tr.stop()); ctx.close(); return; } // stopped while opening
    const node = new AudioWorkletNode(ctx, 'rs-tap');
    node.port.onmessage = (e) => whFrame(e.data, ctx.sampleRate);
    ctx.createMediaStreamSource(stream).connect(node);
    Object.assign(WH, { ctx, stream, node, phrase: null, preroll: [] });
  } catch (err) {
    WH.ctx = null;
    toast(err.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for this page (address bar) and try again.' : `Couldn't open the microphone: ${err.message}`, true);
  }
}

function whFrame(frame, rate) {
  if (!RS.active || RS.paused) return;
  const ms = (frame.length / rate) * 1000;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  // The noise floor drops quickly to the room's level and creeps up slowly, so talking doesn't raise it.
  WH.floor = rms < WH.floor ? WH.floor * 0.8 + rms * 0.2 : WH.floor * 0.998 + rms * 0.002;
  const voiced = rms > Math.max(WH.floor * 3, 0.006);
  const p = WH.phrase;
  if (!p) {
    WH.preroll.push(frame);
    if (WH.preroll.length * ms > 400) WH.preroll.shift();
    if (voiced) {
      WH.phrase = { frames: WH.preroll, rate, t: Math.max(0, rsElapsed() - WH.preroll.length * ms), voicedMs: ms, quietMs: 0, ms: WH.preroll.length * ms };
      WH.preroll = [];
    }
    return;
  }
  p.frames.push(frame);
  p.ms += ms;
  if (voiced) { p.voicedMs += ms; p.quietMs = 0; } else p.quietMs += ms;
  if (p.quietMs >= PHRASE_END_MS || p.ms >= PHRASE_MAX_MS) whFlush();
}

function whFlush() {
  const p = WH.phrase;
  WH.phrase = null;
  if (!p || p.voicedMs < 250) return;
  const audio = whWav(p.frames, p.rate);
  const t = p.t;
  const tEnd = rsElapsed();
  const gen = RS.gen;
  const gameId = RS.gameId;
  RS.whPending = (RS.whPending || 0) + 1;
  rsRender();
  WH.queue = WH.queue.then(async () => {
    try {
      const context = RS.segments.filter((s) => !s.mark && !s.rejected).at(-1)?.text || '';
      const r = await api('POST', `/api/games/${gameId}/transcribe`, { audio, lang: speechLang().slice(0, 2), context });
      if (r.text && gen === RS.gen) { rsAddSpeech(r.text, t, tEnd); rsSaveDraft(); }
    } catch (err) {
      if (!RS.whWarned) { RS.whWarned = true; toast(`${err.message} Switch the engine to Chrome under the transcript if it keeps failing.`, true); }
    } finally {
      RS.whPending--;
      if (gen === RS.gen) rsRender();
    }
  });
}

function whStop(flush) {
  if (flush) whFlush();
  else WH.phrase = null;
  if (WH.ctx && WH.ctx !== 'starting') {
    WH.stream.getTracks().forEach((tr) => tr.stop());
    WH.ctx.close().catch(() => {});
  }
  Object.assign(WH, { ctx: null, stream: null, node: null, preroll: [] });
}

// 16 kHz mono 16-bit WAV, base64: what whisper.cpp reads directly.
function whWav(frames, rate) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const ratio = rate / 16000;
  const n = Math.floor(total / ratio);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  const all = new Float32Array(total);
  let o = 0;
  for (const f of frames) { all.set(f, o); o += f.length; }
  for (let i = 0; i < n; i++) {
    // Average the samples that fold into each output sample (a simple low-pass before downsampling).
    const a = Math.floor(i * ratio);
    const b = Math.min(total, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s / (b - a))) * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Saying "mark that" / "mark moment" while playing drops a ★ marker (you can't click mid-game).
const MARK_RE = /\b(?:mark(?:ed)?|work)\s+(?:that|this|it|here|(?:the\s+)?moment)\b/i;
// Speech arrives in short bursts; anything within 10 seconds of the last line joins it,
// so the transcript reads as sentences instead of fragments.
const JOIN_MS = 10000;

function rsAddSpeech(text, t = rsElapsed(), tEnd = t) {
  if (MARK_RE.test(text)) {
    const rest = text.replace(MARK_RE, '').replace(/\s{2,}/g, ' ').trim();
    RS.segments.push({ t, text: rest ? `marked: ${rest}` : 'marked moment', mark: true });
    RS.lastSpeechAt = tEnd;
    return;
  }
  const last = RS.segments.at(-1);
  // Never merge into a line the director corrected, typed, left out or has their cursor in.
  const focused = document.activeElement?.closest?.('.rs-line')?.dataset.seg;
  const joinable = last && !last.mark && !last.edited && !last.typed && !last.rejected && focused !== String(RS.segments.length - 1);
  if (joinable && t - (RS.lastSpeechAt ?? -Infinity) < JOIN_MS) last.text = `${last.text} ${text}`;
  else RS.segments.push({ t, text });
  RS.lastSpeechAt = tEnd;
}

async function reviewStart() {
  if (RS.active) return;
  RS.whisper = await api('GET', '/api/whisper').catch(() => null);
  if (!RS.whisper?.installed && !(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    return modal({ title: 'Voice review needs Chrome or Edge', body: '<p>This browser has no speech recognition. Open Ballast in Chrome or Microsoft Edge to talk through a review. Typing notes in the box works everywhere.</p>', actions: [{ label: 'OK' }] });
  }
  if (RS.active) return;
  let draft = null;
  try { draft = JSON.parse(load(RS_DRAFT) || 'null'); } catch { /* none */ }
  const begin = (resume) => {
    Object.assign(RS, { active: true, paused: false, interim: '', gameId: S.gameId, pausedMs: 0, pausedAt: 0, lastSpeechAt: undefined, netWarned: false, whWarned: false, whPending: 0, gen: (RS.gen || 0) + 1 });
    RS.segments = resume ? draft.segments : [];
    RS.startedAt = Date.now() - (resume ? draft.elapsed : 0);
    rsListen();
    clearInterval(RS.timer);
    RS.timer = setInterval(() => { const t = $('#review-session .rs-time'); if (t) t.textContent = mmss(rsElapsed()); }, 1000);
    rsRender();
  };
  if (draft?.segments?.length && draft.gameId === S.gameId) {
    modal({
      title: 'Unsent review',
      body: `<p>You have an unsent review from ${clock(draft.at)} (${draft.segments.length} lines, ${mmss(draft.elapsed)}).</p>`,
      actions: [{ label: 'Start over', onClick: () => begin(false) }, { label: 'Continue it', kind: 'primary', onClick: () => begin(true) }],
    });
  } else begin(false);
}

// flush: send the phrase in progress to Whisper (Done) rather than drop it (Discard).
function reviewStop(flush = false) {
  whStop(flush);
  RS.active = false;
  RS.paused = false;
  RS.interim = '';
  try { RS.rec?.stop(); } catch { /* not running */ }
  RS.rec = null;
  clearInterval(RS.timer);
}

async function reviewDone() {
  const minutes = Math.max(1, Math.round(rsElapsed() / 60000));
  reviewStop(true);
  if (RS.whPending) {
    toast('Writing the last lines…');
    await WH.queue;
  }
  rsSaveDraft();
  $('#review-session')?.remove();
  const text = rsText();
  modal({
    title: 'Send Director Review to all agents',
    wide: true,
    body: `<p class="hint" style="margin-top:0">${minutes} min session. Fix anything the transcription got wrong, or press <b>Tidy up</b> to have Claude fix misheard words using this game's names and drop the filler. It doesn't need to be neat. The agent with the most usage headroom turns it into a task breakdown, then everyone claims work.</p>
      <textarea name="text" style="width:100%;height:52vh;font-family:var(--mono);font-size:13px">${esc(text)}</textarea>
      <div class="row" style="margin-top:6px"><button type="button" class="ghost small" data-tidy>Tidy up with Claude</button><button type="button" class="ghost small" data-untidy hidden>Undo tidy-up</button><span class="hint grow" style="margin:0" data-tidy-status></span></div>
      ${S.pending.feed.length ? `<p class="hint">${S.pending.feed.length} attachment(s) from the box below go along with it.</p>` : ''}`,
    actions: [
      { label: 'Discard', kind: 'danger', onClick: () => { store(RS_DRAFT, ''); } },
      { label: 'Keep recording', onClick: () => { reviewStart(); } },
      {
        label: 'Send to all agents', kind: 'primary', onClick: async (root) => {
          const body = $('textarea', root).value.trim();
          if (!body) throw new Error('The transcript is empty.');
          const header = `Director Review: play session, ${minutes} min, ${new Date().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
          await api('POST', `/api/games/${S.gameId}/notes`, { text: `${header}\n\n${body}`, target: 'all', source: 'review-session', attachments: S.pending.feed.map(({ name, path, url }) => ({ name, path, url })) });
          S.pending.feed = [];
          renderChips('feed');
          store(RS_DRAFT, '');
          toast('Sent to every agent');
        },
      },
    ],
    onMount: (root) => {
      const ta = $('textarea', root);
      const status = $('[data-tidy-status]', root);
      let original = null;
      $('[data-tidy]', root).onclick = async (e) => {
        e.target.disabled = true;
        status.textContent = 'Tidying… (about 10 to 30 seconds)';
        try {
          const r = await api('POST', `/api/games/${S.gameId}/tidy-transcript`, { text: ta.value });
          original = ta.value;
          ta.value = r.text;
          $('[data-untidy]', root).hidden = false;
          status.textContent = r.changes ? `Fixed: ${r.changes}` : 'Tidied.';
        } catch (err) {
          status.textContent = err.message;
        } finally { e.target.disabled = false; }
      };
      $('[data-untidy]', root).onclick = (e) => {
        if (original != null) ta.value = original;
        e.target.hidden = true;
        status.textContent = 'Back to the original transcript.';
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Department tabs (Gameplay / Art / Audio / Backend): review, questions, work, captures

const MODE_INFO = {
  gate: { label: 'Approve first', text: (g) => `Agents leave changes in this area unmerged and move straight on to other work. Approving merges it. Anything you haven't looked at is approved after ${S.st.settings.reviewAutoApproveHours || 0}h, so it never holds up a build for long.${g.isolation === 'shared' ? ' (Not available with a shared working tree; acts like Review after.)' : ''}` },
  after: { label: 'Review after', text: () => 'Agents merge and keep going. Finished work queues here for you; asking for changes creates a follow-up task. Never blocks anything.' },
  skip: { label: 'Not my field', text: () => 'Agents merge and keep going, and nothing queues for you. Finished work is listed below if you ever want a look.' },
};

const capturesFor = (gid, filter) => S.st.artifacts.filter((a) => a.gameId === gid && filter(a)).sort((a, b) => b.createdAt - a.createdAt);

function thumb(a) {
  const url = artUrl(a);
  const inner = a.kind === 'image' ? `<img src="${url}" loading="lazy" alt="">`
    : a.kind === 'video' ? `<video src="${url}" muted loop playsinline preload="metadata" onmouseenter="this.play()" onmouseleave="this.pause()"></video>`
    : a.kind === 'audio' ? '<span>♪ AUDIO</span>'
    : `<span>${esc(a.kind.toUpperCase())}</span>`;
  return `<button class="cap" data-act="art-open" data-id="${a.id}" title="${esc(a.title)}">${inner}<span class="cap-title">${esc(a.title)}</span></button>`;
}

// Same matching the server uses to hand targets to agents: shared subject words with the task,
// else the department's whole set.
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
function targetsFor(task, g) {
  const pool = (S.st.targets || []).filter((x) => x.gameId === g.id && x.discipline === task.discipline);
  const tw = new Set(words(`${task.title} ${task.detail || ''}`));
  const hits = pool.map((x) => ({ x, n: [...x.tags.flatMap(words), ...words(x.title)].filter((w) => tw.has(w)).length })).filter((s) => s.n).sort((a, b) => b.n - a.n).map((s) => s.x);
  return (hits.length ? hits : pool).slice(0, 4);
}
const targetUrl = (x) => fileUrl('targets', x.gameId, x.id, x.file);
function targetThumb(x) {
  const inner = x.kind === 'image' ? `<img src="${targetUrl(x)}" loading="lazy" alt="">`
    : x.kind === 'video' ? `<video src="${targetUrl(x)}" muted loop playsinline preload="metadata" onmouseenter="this.play()" onmouseleave="this.pause()"></video>`
    : `<span>${esc(x.kind.toUpperCase())}</span>`;
  return `<button class="cap target-cap" data-act="target-view" data-id="${x.id}" title="${esc(x.title)}">${inner}<span class="cap-badge">target</span><span class="cap-title">${esc(x.title)}</span></button>`;
}

function reviewCard(t, g) {
  const agent = agentOf(t.doneBy || t.claimedBy);
  const caps = capturesFor(g.id, (a) => a.taskId === t.id);
  const refs = caps.length ? targetsFor(t, g) : [];
  const waiting = t.status === 'review';
  return `<div class="card review-card">
    <div class="row"><span class="num">#${t.num}</span><b class="grow">${esc(t.title.replace(/^\s*\[[^\]]+\]\s*/, ''))}</b>
      <span class="pill ${waiting ? 'limited' : 'success'}">${waiting ? 'waiting to merge' : 'merged'}</span></div>
    <div class="hint">${esc(agent?.name || 'agent')} · ${clock(t.doneAt || t.updatedAt)}${t.pr ? ` · <a href="${esc(t.pr)}" target="_blank" rel="noopener">pull request</a>` : ''}${t.branch && !t.pr ? ` · branch ${esc(t.branch)}` : ''}</div>
    ${t.summary ? clamp(t.summary, md(t.summary)) : ''}
    ${refs.length
      ? `<div class="compare"><span class="hint">Target</span><div class="caps">${refs.map(targetThumb).join('')}</div><span class="hint">Result</span><div class="caps">${caps.slice(0, 8).map(thumb).join('')}</div></div>`
      : caps.length ? `<div class="caps">${caps.slice(0, 8).map(thumb).join('')}</div>` : ''}
    <div class="row" style="margin-top:10px">
      <button class="primary small" data-act="review-approve" data-id="${t.id}">${waiting ? 'Approve & merge' : 'Looks good'}</button>
      <button class="ghost small" data-act="review-changes" data-id="${t.id}">Request changes</button>
    </div>
  </div>`;
}

// What happened to a closed question: your answer (and what else it settled), or the answer that settled it.
function questionOutcome(q) {
  const byId = (id) => (S.st.inbox || []).find((x) => x.id === id);
  if (q.status !== 'answered') return '<div class="hint" style="margin-top:6px">Kept the assumption.</div>';
  if (q.supersededBy) {
    const p = byId(q.supersededBy);
    return `<div class="q-settled"><div class="hint" style="margin:6px 0 2px">Settled by your answer to <b style="color:var(--text)">"${esc((p?.question || 'another question').slice(0, 140))}"</b>${q.settledWhy ? `: ${esc(q.settledWhy)}` : ''}</div>
      <div class="hint" style="margin:0 0 6px">Sent to ${esc(q.agentName)}: ${esc(q.answer)}</div>
      <button class="ghost small" data-act="q-reopen" data-id="${q.id}" title="If this wasn't really answered: reopen it, and the agent is told to disregard the answer">Reopen</button></div>`;
  }
  const also = (q.settled || []).map(byId).filter(Boolean);
  return `<div class="hint" style="margin-top:6px">You answered: ${esc(q.answer)}</div>
    ${q.settling ? '<div class="hint" style="margin-top:4px">Checking whether this also settles other open questions…</div>' : ''}
    ${also.length ? `<div class="hint" style="margin-top:4px">Also closed ${also.length} other question${also.length > 1 ? 's' : ''}: ${also.map((x) => `<span title="${esc(x.settledWhy || '')}">"${esc(x.question.slice(0, 80))}"</span> <a href="#" data-act="q-reopen" data-id="${x.id}">reopen</a>`).join(' · ')}</div>` : ''}`;
}

function questionCard(q) {
  const g = S.st.games.find((x) => x.id === q.gameId);
  return `<div class="card question">
    <div class="row"><b class="grow">${esc(q.question)}</b>${S.view === 'inbox' && g ? `<span class="pill link" data-act="game" data-id="${g.id}">${esc(g.name)}</span>` : ''}</div>
    <div class="hint">${esc(q.agentName)}${q.taskNum ? ` · while working on #${q.taskNum}` : ''} · ${clock(q.createdAt)}</div>
    ${q.context ? `<div class="q-context md">${md(q.context)}</div>` : ''}
    ${q.options?.length ? `<ul class="q-options">${q.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
    ${(q.artifactIds || []).length ? `<div class="caps">${q.artifactIds.map((id) => S.st.artifacts.find((a) => a.id === id)).filter(Boolean).map(thumb).join('')}</div>` : ''}
    ${q.assumption && q.source !== 'dropped-note' ? `<div class="assume">Going with: ${esc(q.assumption)}</div>` : ''}
    ${q.status === 'open' && q.source === 'dropped-note'
      ? `<div class="row" style="margin-top:8px"><button class="primary small" data-act="q-addtask" data-id="${q.id}">Add as a task anyway</button><button class="ghost small" data-act="q-dismiss" data-id="${q.id}">Leave it off the board</button></div>`
      : q.status === 'open'
      ? `<div class="row" style="margin-top:8px"><button class="primary small" data-act="q-answer" data-id="${q.id}">Answer</button><button class="ghost small" data-act="q-dismiss" data-id="${q.id}">Assumption is fine</button></div>`
      : questionOutcome(q)}
  </div>`;
}

function renderDept(d) {
  const el = $('#dept');
  const g = game();
  if (!el || !g) return;
  if (el.contains(document.activeElement) && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName)) return; // a note being typed
  const label = S.st.disciplines.find((x) => x.id === d)?.label || d;
  const mode = policyOf(g, d);
  const override = g.review?.[d];
  const tasks = tasksOf(g.id).filter((t) => t.discipline === d);
  const pending = tasks.filter((t) => t.review?.state === 'pending').sort((a, b) => (b.status === 'review') - (a.status === 'review') || (b.doneAt || 0) - (a.doneAt || 0));
  const questions = openQuestions(g.id).filter((q) => q.discipline === d);
  const active = tasks.filter((t) => t.status === 'claimed');
  const upNext = tasks.filter((t) => t.status === 'open').sort((a, b) => a.num - b.num);
  const recent = tasks.filter((t) => t.status === 'done' && t.review?.state !== 'pending').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 25);
  const caps = capturesFor(g.id, (a) => a.discipline === d && ['image', 'video', 'audio'].includes(a.kind));
  const unfiled = tasksOf(g.id).filter((t) => t.status === 'done' && !t.review).length;
  const refs = S.st.cloudArtifacts.filter((c) => c.gameId === g.id && (c.discipline === d || c.role === 'gdd'));
  const line = (t) => `<div class="tline"><span class="num">#${t.num}</span> ${esc(t.title.replace(/^\s*\[[^\]]+\]\s*/, ''))} <span class="hint" style="display:inline">${t.claimedBy ? `· ${esc(agentOf(t.claimedBy)?.name || '')}` : t.assignee ? `· for ${esc(agentOf(t.assignee)?.name || '')}` : ''}</span></div>`;

  const notes = (S.st.deptNotes || []).filter((n) => n.gameId === g.id && n.discipline === d);
  const liveNotes = notes.filter((n) => n.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt);
  const archived = notes.filter((n) => n.status === 'archived').sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  const top = $('#dept-top');
  const headHtml = `
    <div class="dept-head">
      <h2>${esc(label)}</h2>
      <div class="seg">${['gate', 'after', 'skip'].map((m) => `<button class="${m === mode ? 'on' : ''}" data-act="dept-mode" data-d="${d}" data-mode="${m}">${MODE_INFO[m].label}</button>`).join('')}</div>
      <span class="hint" style="margin:0">${override ? `Set for this game · <a href="#" data-act="dept-mode" data-d="${d}" data-mode="default">use studio default</a>` : 'Studio default'}</span>
    </div>
    <p class="hint" style="margin-top:4px">${esc(MODE_INFO[mode].text(g))}</p>
    ${unfiled ? `<div class="card suggestion" style="margin-top:10px"><b>Earlier work</b><span class="hint" style="margin:0">${unfiled} task${unfiled > 1 ? 's' : ''} on this game finished before review was set up.</span>
      <div style="margin-top:8px"><button class="btn small" data-act="queue-earlier">Queue them for review</button> <span class="hint" style="display:inline">Each department follows its mode; nothing is un-merged.</span></div></div>` : ''}`;
  if (top) top.innerHTML = headHtml;

  el.innerHTML = `
    ${d === 'art' ? subjectsSection(g) : ''}
    ${liveNotes.length ? `<section><div class="section-head"><h3>${esc(label)} notes</h3><span class="hint">${liveNotes.filter((n) => n.status === 'new').length} waiting · ${liveNotes.filter((n) => n.status === 'tasked').length} tasked</span></div>
      ${liveNotes.map(deptNoteCard).join('')}</section>` : ''}

    ${mode !== 'skip' || pending.length ? `<section><div class="section-head"><h3>Waiting for you</h3><span class="hint">${pending.length ? `${pending.length} item${pending.length > 1 ? 's' : ''}` : 'Nothing to review.'}</span>${pending.length > 1 ? `<button class="ghost small" data-act="review-all" data-d="${d}">Approve all</button>` : ''}</div>
      ${pending.map((t) => reviewCard(t, g)).join('')}</section>` : ''}

    ${questions.length ? `<section><div class="section-head"><h3>Questions</h3><span class="hint">Agents kept working on these assumptions.</span></div>${questions.map(questionCard).join('')}</section>` : ''}

    <section><div class="section-head"><h3>Work</h3><span class="hint">${active.length} in progress · ${upNext.length} up next</span></div>
      <div class="two">
        <div class="card"><b>In progress</b>${active.map(line).join('') || '<div class="hint">Nothing right now.</div>'}</div>
        <div class="card"><b>Up next</b>${upNext.slice(0, 12).map(line).join('') || '<div class="hint">Nothing on the board.</div>'}${upNext.length > 12 ? `<div class="hint">and ${upNext.length - 12} more</div>` : ''}</div>
      </div></section>

    ${(() => {
      const tg = (S.st.targets || []).filter((x) => x.gameId === g.id && x.discipline === d).sort((a, b) => b.createdAt - a.createdAt);
      const sh = g.targetsShared;
      const cloudLine = g.runner === 'cloud' ? `<p class="hint" style="margin:0 0 8px">Cloud agents read these from the <code>ballast/targets</code> branch on GitHub (never main). ${sh ? (sh.error ? `<span style="color:var(--red)">Last share failed: ${esc(sh.error)}</span> <a href="#" data-act="targets-share">Try again</a>` : `Shared ${ago(sh.at)} (${sh.count}).`) : 'Shared when you add the first one.'}</p>` : '';
      return `<section data-target-drop="${d}"><div class="section-head"><h3>Quality targets</h3><span class="hint">Reference images that set the bar for ${esc(label.toLowerCase())} work. Agents get the matching ones with each task.</span><button class="primary small" data-act="targets-add" data-d="${d}">+ Add targets</button></div>
        ${cloudLine}
        ${tg.length ? `<div class="targets-grid">${tg.map((x) => `<div class="card target-card">${targetThumb(x)}
            <div class="row" style="margin-top:8px"><b class="grow">${esc(x.title)}</b><button class="icon-btn" data-act="target-edit" data-id="${x.id}" title="Edit">✎</button><button class="icon-btn" data-act="target-delete" data-id="${x.id}" title="Remove">✕</button></div>
            ${x.category || x.assets?.length ? `<div class="hint" style="margin:0">${x.category ? `<span class="pill">${esc(x.category)}</span> ` : ''}${(x.assets || []).slice(0, 3).map((a) => esc(a.name)).join(', ')}${(x.assets || []).length > 3 ? ` +${x.assets.length - 3}` : ''}</div>` : ''}
            ${x.tags.length ? `<div class="hint" style="margin:0">${x.tags.map(esc).join(' · ')}</div>` : ''}
            ${x.notes ? `<div class="hint" style="margin:4px 0 0">Match: ${esc(x.notes)}</div>` : ''}</div>`).join('')}</div>`
          : `<div class="drop-hint">Drop images here, or use <b>Add targets</b>: concept art, a screenshot from a game you admire, a lighting look, a texture with the right amount of wear.</div>`}
      </section>`;
    })()}

    <section><div class="section-head"><h3>Captures</h3><span class="hint">Screenshots, GIFs, video and clips agents attached to ${esc(label.toLowerCase())} work</span></div>
      ${caps.length ? `<div class="caps big">${caps.slice(0, 48).map(thumb).join('')}</div>` : `<p class="hint">None yet. Agents attach captures to ${d === 'audio' ? 'audio work as clips' : 'visual work as screenshots and GIFs'}.</p>`}</section>

    <section><div class="section-head"><h3>On claude.ai</h3><button class="ghost small" data-act="cloud-track" data-discipline="${d}">+ Track an artifact</button></div>
      ${refs.length ? refs.map((c) => `<div class="card cloud-card"><div class="row"><span class="pill">${esc(c.role)}</span><b class="grow">${esc(c.title)}</b><a class="btn small" href="${esc(c.url)}" target="_blank" rel="noopener">Open</a></div>
        <div class="hint">updated ${esc(c.updated || '?')}${c.lastReadAt ? ` · read ${ago(c.lastReadAt)}` : ''}${(c.threads || []).filter((t) => !t.resolved).length ? ` · ${(c.threads || []).filter((t) => !t.resolved).length} open comment threads` : ''}</div>
        ${c.summary ? clamp(c.summary, md(c.summary)) : ''}</div>`).join('') : `<p class="hint">Track this department's review pages and checklists (like an art review or audio checklist) to see them here and route their changes to the team.</p>`}</section>

    ${recent.length ? `<section><details><summary class="hint" style="display:inline;cursor:pointer">Recently finished (${recent.length})</summary>
      ${recent.map((t) => `<div class="tline"><span class="num">#${t.num}</span> ${esc(t.title.replace(/^\s*\[[^\]]+\]\s*/, ''))} <span class="hint" style="display:inline">· ${esc(agentOf(t.doneBy)?.name || '')} · ${({ changes: 'changes requested', auto: 'auto-approved', skipped: 'not reviewed', approved: 'approved' })[t.review?.state] || 'finished'}${t.pr ? ` · <a href="${esc(t.pr)}" target="_blank" rel="noopener">PR</a>` : ''}</span></div>`).join('')}</details></section>` : ''}

    ${archived.length ? `<section><details><summary class="hint" style="display:inline;cursor:pointer">Archived notes (${archived.length})</summary>${archived.map(deptNoteCard).join('')}</details></section>` : ''}`;
}

// A department note: NEW (waiting / picked up) -> TASKED (linked tasks with live status) -> ARCHIVED.
function deptNoteCard(n) {
  const statusLabel = { open: 'open', claimed: 'in progress', review: 'awaiting approval', blocked: 'blocked', done: 'done' };
  const tasks = n.taskIds.map((id) => S.st.tasks.find((t) => t.id === id)).filter(Boolean);
  const done = tasks.filter((t) => t.status === 'done').length;
  const state = n.status === 'archived' ? ['success', 'archived']
    : n.status === 'tasked' ? ['queued', `tasked · ${done}/${tasks.length} done`]
    : n.pickedBy && Date.now() - n.pickedAt < 45 * 60e3 ? ['running', `picked up by ${n.pickedByName}`]
    : ['limited', 'new · waiting for an agent'];
  return `<div class="card deptnote${n.status === 'archived' ? ' archived' : ''}">
    <div class="row"><span class="num">D${n.num}</span><span class="pill ${state[0]}">${esc(state[1])}</span><span class="grow hint" style="margin:0">${clock(n.createdAt)}${n.taskedBy ? ` · broken down by ${esc(n.taskedBy)}` : ''}${n.archivedAt ? ` · archived ${clock(n.archivedAt)}` : ''}</span>
      ${n.status === 'new' ? `<button class="ghost small" data-act="dn-breakdown" data-id="${n.id}" title="Have Ballast break it into tasks right now">Break down now</button><button class="ghost small" data-act="dn-delete" data-id="${n.id}">Delete</button>` : ''}</div>
    ${clamp(n.text, md(n.text))}
    ${tasks.length ? `<div class="dn-tasks">${tasks.map((t) => `<button class="dn-task ${t.status}" data-act="task-edit" data-id="${t.id}" title="${esc(t.title)}"><span class="num">#${t.num}</span> ${esc(t.title.replace(/^\s*\[[^\]]+\]\s*/, '').slice(0, 60))} <span class="hint" style="display:inline">${statusLabel[t.status] || t.status}</span></button>`).join('')}</div>` : ''}
  </div>`;
}

function renderInbox() {
  const el = $('#inbox');
  if (!el) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return; // don't wipe a note you're typing
  const open = openQuestions().sort((a, b) => a.createdAt - b.createdAt);
  const done = (S.st.inbox || []).filter((q) => q.status !== 'open').sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0)).slice(0, 30);
  const human = openInterventions();
  const handled = (S.st.interventions || []).filter((i) => i.status !== 'open').sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
  el.innerHTML = (open.length || human.length) ? `${inboxColumns(open, human)}
    ${done.length ? `<details style="margin-top:18px"><summary class="hint" style="display:inline;cursor:pointer">Answered (${done.length})</summary>${done.map(questionCard).join('')}</details>` : ''}
    ${handled.length ? `<details style="margin-top:10px"><summary class="hint" style="display:inline;cursor:pointer">Handled interventions (${handled.length})</summary>${handled.map(interventionCard).join('')}</details>` : ''}` : `${human.length ? `<div class="section-head"><h3>🙋 Human intervention</h3><span class="hint">Blocked tickets that triaged themselves and need a person: ${human.length} request${human.length > 1 ? 's' : ''} holding ${human.reduce((n, i) => n + i.taskIds.length, 0)} ticket${human.reduce((n, i) => n + i.taskIds.length, 0) > 1 ? 's' : ''}</span></div>${human.map(interventionCard).join('')}<div class="section-head" style="margin-top:22px"><h3>Questions</h3></div>` : ''}
    ${open.length ? open.map(questionCard).join('') : human.length ? '<p class="hint">No open questions.</p>' : '<div class="empty"><h2>Inbox zero</h2><p>When an agent has a question it adds it here, writes down what it is assuming, and keeps going. Your answer goes back to that agent. Blocked tickets that need a person show up here too, with exactly what to do.</p></div>'}
    ${done.length ? `<details style="margin-top:18px"><summary class="hint" style="display:inline;cursor:pointer">Answered (${done.length})</summary>${done.map(questionCard).join('')}</details>` : ''}
    ${handled.length ? `<details style="margin-top:10px"><summary class="hint" style="display:inline;cursor:pointer">Handled interventions (${handled.length})</summary>${handled.map(interventionCard).join('')}</details>` : ''}`;
}

// ---------------------------------------------------------------------------
// Human Intervention: what a blocked ticket needs from a person (or a Cowork Claude they authorize)

const openInterventions = (gid) => (S.st.interventions || []).filter((i) => i.status === 'open' && (gid ? i.gameId === gid : liveGame(i.gameId)));
const KIND_LABEL = { access: 'Access or permissions', hardware: 'Hardware or a device', account: 'An account or service', payment: 'Payment', decision: 'Your decision', content: 'Content only you can make', other: 'Something else' };

function coworkText(iv) {
  const g = S.st.games.find((x) => x.id === iv.gameId);
  return `${iv.coworkBrief}\n\nWhat you're authorized to do:\n${iv.authorization.map((a) => `- ${a}`).join('\n')}\n\nSteps:\n${iv.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nDone when: ${iv.verify}\n\n(This unblocks work on ${g?.name || 'the game'}: ${iv.why})`;
}

function interventionCard(iv) {
  const g = S.st.games.find((x) => x.id === iv.gameId);
  const tickets = iv.taskIds.map((id) => S.st.tasks.find((t) => t.id === id)).filter(Boolean);
  const open = iv.status === 'open';
  return `<div class="card hi-card${open ? '' : ' handled'}">
    <div class="row"><span class="hi-tag">🙋 NEEDS YOU</span><b class="grow">${esc(iv.title)}</b>${S.view === 'inbox' && g ? `<span class="pill link" data-act="game" data-id="${g.id}">${esc(g.name)}</span>` : ''}</div>
    <div class="hint" style="margin:4px 0 8px">${esc(KIND_LABEL[iv.kind] || iv.kind)} · ${iv.who === 'you' ? 'only you can do this' : 'you, or a Cowork Claude you authorize'}${iv.minutes ? ` · about ${iv.minutes} min` : ''}${open ? '' : ` · ${iv.status === 'done' ? `done ${ago(iv.resolvedAt)}` : 'dismissed'}`}</div>
    <p style="margin:0 0 8px">${esc(iv.why)}</p>
    ${iv.steps.length ? `<ol class="hi-steps">${iv.steps.map((s) => `<li>${mdInline(s)}</li>`).join('')}</ol>` : ''}
    ${iv.verify ? `<div class="hint" style="margin:4px 0"><b style="color:var(--text)">You'll know it worked when:</b> ${esc(iv.verify)}</div>` : ''}
    ${iv.authorization.length ? `<details class="hi-cowork"><summary>Hand it to a Cowork Claude instead</summary>
      <div class="hint" style="margin:6px 0 4px">It needs your authorization to:</div><ul>${iv.authorization.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      <button class="ghost small" data-act="hi-cowork" data-id="${iv.id}">Copy the Cowork brief</button></details>` : ''}
    <div class="hint" style="margin:8px 0 0">Holding ${tickets.map((t) => `<span class="link" data-act="thread-open" data-id="${t.id}" title="${esc(t.title)}">#${t.num}</span>`).join(', ') || 'no tickets'}${iv.note ? ` · your note: ${esc(iv.note)}` : ''}</div>
    ${open ? `<div class="row" style="gap:6px;margin-top:10px">
      ${iv.closeSuggested ? `<button class="primary small" data-act="hi-close" data-id="${iv.id}">Close the ticket</button>` : `<button class="primary small" data-act="hi-done" data-id="${iv.id}">Done: put ${tickets.length > 1 ? `the ${tickets.length} tickets` : 'it'} back on the board</button>`}
      ${tickets[0] ? `<button class="ghost small" data-act="thread-open" data-id="${tickets[0].id}">Talk it through</button>` : ''}
      <button class="ghost small" data-act="hi-dismiss" data-id="${iv.id}" title="Leave the tickets blocked and stop asking">Dismiss</button></div>` : ''}
  </div>`;
}

function interventionModal(id) {
  const iv = S.st.interventions.find((x) => x.id === id);
  if (!iv) return;
  modal({ title: 'Human intervention', wide: true, body: interventionCard(iv), actions: [] });
}

// Asset picker: pick a category, then search the game's assets (AI catalog + asset files) and
// tick the ones a target applies to. Lives inside a modal, so it's never re-rendered by state.
const assetKey = (a) => `${a.name}|${(a.refs || []).join(',')}`;
const assetPickerHtml = () => `<div class="asset-picker">
  <span class="field-label">Category</span>
  <div class="chip-row" data-cats></div>
  <div class="row" style="margin-top:8px"><input data-asset-q placeholder="Search the game's assets: barrel, wharf, fisherman…" autocomplete="off"><button type="button" class="ghost small" data-asset-scan title="Have Claude read the game and list what's in it">Scan the game</button></div>
  <div class="hint" data-asset-status style="margin:4px 0"></div>
  <div class="asset-results" data-asset-results></div>
  <span class="field-label" style="margin-top:8px">Applies to</span>
  <div class="chip-row" data-asset-chosen></div>
</div>`;

function mountAssetPicker(root, { category = '', assets: chosen = [] } = {}) {
  const st = { category, chosen: [...chosen], q: '', data: null, timer: null };
  const $r = (s) => $(s, root);
  const renderChosen = () => {
    $r('[data-asset-chosen]').innerHTML = st.chosen.length
      ? st.chosen.map((a, i) => `<span class="chip">${esc(a.name)} <span class="hint" style="display:inline">${esc(a.category)}</span><button type="button" data-unpick="${i}">✕</button></span>`).join('')
      : '<span class="hint" style="margin:0">Nothing tagged yet: tick assets above.</span>';
  };
  const render = () => {
    const d = st.data;
    if (!d) return;
    $r('[data-cats]').innerHTML = [{ id: '', label: 'All' }, ...d.categories].filter((c) => !c.id || d.counts[c.id] || c.id === st.category)
      .map((c) => `<button type="button" class="chip-btn${st.category === c.id ? ' on' : ''}" data-cat="${c.id}">${esc(c.label)}${c.id ? ` <span>${d.counts[c.id] || 0}</span>` : ''}</button>`).join('');
    const picked = new Set(st.chosen.map(assetKey));
    $r('[data-asset-results]').innerHTML = d.items.length ? d.items.map((a, i) => `<label class="asset-row"><input type="checkbox" data-pick="${i}" ${picked.has(assetKey(a)) ? 'checked' : ''}>
        <span class="grow"><b>${esc(a.name)}</b> <span class="pill">${esc(d.categories.find((c) => c.id === a.category)?.label || a.category)}</span>${a.source === 'file' ? ' <span class="hint" style="display:inline">file</span>' : ''}
        <span class="hint" style="margin:0;display:block">${esc(a.description || '')}${a.refs.length ? ` <code>${esc(a.refs[0])}</code>` : ''}</span></span></label>`).join('')
      : `<div class="hint">${d.catalog || d.files?.count ? 'No assets match.' : 'No asset list yet. Press Scan the game.'}</div>`;
    const parts = [d.catalog ? `catalog: ${d.catalog.count} assets, scanned ${ago(d.catalog.at)}` : 'no catalog yet', d.files?.count ? `${d.files.count} asset files` : ''].filter(Boolean);
    $r('[data-asset-status]').textContent = d.scanning ? 'Scanning the game… (about a minute)' : parts.join(' · ');
  };
  const fetchResults = async () => {
    st.data = await api('GET', `/api/games/${S.gameId}/assets?q=${encodeURIComponent(st.q)}&category=${encodeURIComponent(st.category)}`);
    render();
    return st.data;
  };
  const scan = async () => {
    const btn = $r('[data-asset-scan]');
    btn.disabled = true;
    $r('[data-asset-status]').textContent = 'Scanning the game… (about a minute)';
    try { await api('POST', `/api/games/${S.gameId}/assets/scan`); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
    await fetchResults();
  };
  $r('[data-asset-q]').addEventListener('input', (e) => { st.q = e.target.value; clearTimeout(st.timer); st.timer = setTimeout(fetchResults, 200); });
  $r('[data-asset-scan]').onclick = scan;
  root.addEventListener('click', (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) { st.category = cat.dataset.cat; fetchResults(); }
    const un = e.target.closest('[data-unpick]');
    if (un) { st.chosen.splice(Number(un.dataset.unpick), 1); renderChosen(); render(); }
  });
  root.addEventListener('change', (e) => {
    const box = e.target.closest('[data-pick]');
    if (!box) return;
    const a = st.data.items[Number(box.dataset.pick)];
    if (box.checked) st.chosen.push(a);
    else st.chosen = st.chosen.filter((c) => assetKey(c) !== assetKey(a));
    renderChosen();
  });
  renderChosen();
  // First use on a game: build the catalog automatically so there's something to search.
  fetchResults().then((d) => { if (!d.catalog && !d.scanning) scan(); }).catch((err) => { $r('[data-asset-status]').textContent = err.message; });
  // The target's category: the chip picked, else the most common category among tagged assets.
  return () => {
    const counts = {};
    for (const a of st.chosen) counts[a.category] = (counts[a.category] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return { category: st.category || top, assets: st.chosen.map(({ name, category, refs }) => ({ name, category, refs })) };
  };
}

// Add quality targets: one title per file, shared subjects and "what to match" for the batch.
function addTargetsModal(d, files) {
  files = [...files].filter((f) => /^(image|video|audio)\//.test(f.type));
  if (!files.length) return toast('Pick images (or video/audio clips).', true);
  const g = game();
  const label = S.st.disciplines.find((x) => x.id === d)?.label || d;
  const previews = files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null));
  let pickerValue = () => ({});
  modal({
    title: `Add ${label} quality targets`,
    wide: files.length > 2,
    body: `<div class="targets-grid">${files.map((f, i) => `<div class="card">${previews[i] ? `<img src="${previews[i]}" style="width:100%;border-radius:6px;max-height:160px;object-fit:cover">` : `<div class="hint">${esc(f.name)}</div>`}
        <label class="field" style="margin:8px 0 0"><span>Title</span><input name="title${i}" value="${esc(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '))}"></label></div>`).join('')}</div>
      <div style="margin-top:12px">${assetPickerHtml()}</div>
      <label class="field" style="margin-top:12px"><span>Other subjects (optional)</span><input name="tags" placeholder="e.g. grime, weathering, night lighting"><small>Comma-separated words. Tasks mentioning these, or the tagged assets, get the targets.</small></label>
      <label class="field"><span>What to match</span><textarea name="notes" rows="3" placeholder="e.g. this level of grime and rust, warm lantern light, chunky readable silhouettes"></textarea></label>
      ${g.runner === 'cloud' ? '<p class="hint">This is a cloud game, so Ballast also pushes the targets to a <code>ballast/targets</code> branch of its GitHub repo (never main) so the cloud agents can see them.</p>' : ''}`,
    onMount: (root) => { pickerValue = mountAssetPicker(root); },
    actions: [{ label: 'Cancel' }, {
      label: `Add ${files.length} target${files.length > 1 ? 's' : ''}`, kind: 'primary', onClick: async (root) => {
        const f = { ...formData(root), ...pickerValue() };
        for (const [i, file] of files.entries()) {
          if (file.size > 60e6) { toast(`${file.name} is over 60 MB`, true); continue; }
          const data = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',')[1] || '');
            r.onerror = reject;
            r.readAsDataURL(file);
          });
          await api('POST', `/api/games/${g.id}/targets`, { discipline: d, title: f[`title${i}`], tags: f.tags, notes: f.notes, category: f.category, assets: f.assets, name: file.name, data });
        }
        previews.forEach((u) => u && URL.revokeObjectURL(u));
        toast(`Added ${files.length} target${files.length > 1 ? 's' : ''}`);
      },
    }],
  });
}

function editTargetModal(id) {
  const x = S.st.targets.find((t) => t.id === id);
  let pickerValue = () => ({});
  modal({
    title: 'Quality target',
    wide: true,
    body: `${x.kind === 'image' ? `<img src="${targetUrl(x)}" style="width:100%;border-radius:8px;max-height:220px;object-fit:contain;background:#0a0c0f">` : ''}
      <label class="field" style="margin-top:10px"><span>Title</span><input name="title" value="${esc(x.title)}"></label>
      ${assetPickerHtml()}
      <label class="field" style="margin-top:12px"><span>Other subjects</span><input name="tags" value="${esc(x.tags.join(', '))}"></label>
      <label class="field"><span>What to match</span><textarea name="notes" rows="3">${esc(x.notes)}</textarea></label>`,
    onMount: (root) => { pickerValue = mountAssetPicker(root, { category: x.category || '', assets: x.assets || [] }); },
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (root) => api('PATCH', `/api/targets/${id}`, { ...formData(root), ...pickerValue() }) }],
  });
}

// Dropping files anywhere on a department's targets section adds them.
document.addEventListener('dragover', (e) => { if (e.target.closest?.('[data-target-drop]')) { e.preventDefault(); e.target.closest('[data-target-drop]').classList.add('drag'); } });
document.addEventListener('dragleave', (e) => e.target.closest?.('[data-target-drop]')?.classList.remove('drag'));
document.addEventListener('drop', (e) => {
  const zone = e.target.closest?.('[data-target-drop]');
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove('drag');
  addTargetsModal(zone.dataset.targetDrop, e.dataTransfer.files);
});

function answerModal(id) {
  const q = S.st.inbox.find((x) => x.id === id);
  modal({
    title: 'Answer',
    body: `<p style="margin-top:0"><b>${esc(q.question)}</b></p>
      ${q.context ? `<div class="md" style="margin-bottom:8px">${md(q.context)}</div>` : ''}
      ${q.options?.length ? `<ul class="q-options">${q.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
      ${q.assumption ? `<p class="hint">${esc(q.agentName)} is going with: ${esc(q.assumption)}</p>` : ''}
      <label class="field"><span>Your answer</span><textarea name="answer" rows="5"></textarea><small>Sent to ${esc(q.agentName)} as a message. It adjusts its work if your answer differs from its assumption.</small></label>`,
    actions: [{ label: 'Cancel' }, { label: 'Send answer', kind: 'primary', onClick: async (root) => { await api('POST', `/api/inbox/${id}/answer`, formData(root)); toast('Answer sent. Checking whether it also settles other open questions.'); } }],
  });
}

function changesModal(id) {
  const t = S.st.tasks.find((x) => x.id === id);
  modal({
    title: `Changes to #${t.num}`,
    body: `<p class="hint" style="margin-top:0">${esc(t.title)}</p>
      <label class="field"><span>What should change?</span><textarea name="feedback" rows="6" placeholder="Be as specific as you like: what feels off, what to aim for, references…"></textarea>
      <small>Becomes a follow-up task for ${esc(agentOf(t.doneBy || t.claimedBy)?.name || 'the team')}. ${t.status === 'review' ? 'The unmerged change stays parked until the follow-up is approved.' : 'Nothing else waits on it.'}</small></label>`,
    actions: [{ label: 'Cancel' }, { label: 'Send to the team', kind: 'primary', onClick: (root) => api('POST', `/api/tasks/${id}/changes`, formData(root)) }],
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
      <label class="field"><span>Lead agent</span><select name="leadAgentId">${agents.map((a) => opt(a.id, g.leadAgentId, a.name)).join('') || '<option value="">(no agents)</option>'}</select><small>Breaks ties. Notes are coordinated by whichever agent has the most usage headroom.</small></label>
    </div>
    <div class="two">
      <label class="field"><span>Coordinator file</span><input name="coordinatorFile" value="${esc(g.coordinatorFile || '')}" placeholder="${g.subdir ? `${esc(g.subdir)}/coordinator.md` : 'coordinator.md'}"><small>Optional. The coordinating agent records each note's feedback and task breakdown here, in the repo.</small></label>
      <label class="field"><span>Tasks per claim</span><select name="claimBatch">${[1, 2, 3, 4, 5].map((n) => opt(String(n), String(g.claimBatch || 1))).join('')}</select><small>How many tasks an agent takes at once (it works through them in order). An account whose weekly limit resets within a day with budget left takes one more.</small></label>
    </div>
    <div class="two">
      <label class="field"><span>Check before hand-in</span><input name="checkCommand" value="${esc(g.checkCommand || '')}" placeholder="e.g. npm run check"><small>Agents run this before they push or hand work in, and hand in only when it passes.</small></label>
      <div class="field"><span class="field-label">Models by ticket type</span>
        <div class="row" style="gap:6px"><span class="hint" style="margin:0;min-width:58px">Sonnet</span><input name="routeSonnet" value="${esc(routeTags(g, 'sonnet'))}" placeholder="e.g. docs, backend, qa"></div>
        <div class="row" style="gap:6px;margin-top:6px"><span class="hint" style="margin:0;min-width:58px">Haiku</span><input name="routeHaiku" value="${esc(routeTags(g, 'haiku'))}" placeholder="ticket tags"></div>
        <small>Tickets with these [tags] wait for an agent on that model (set an agent's model from Agents → Edit) and go to anyone when none can take them. ${agentsOf(g.id).some((a) => a.model) ? `On a set model now: ${esc(agentsOf(g.id).filter((a) => a.model).map((a) => `${a.name} (${a.model})`).join(', '))}.` : 'No agent has its own model yet, so nothing is routed.'}</small></div>
    </div>
    <div class="two">
      <label class="field"><span>Delegate chats per agent</span><select name="delegateLimit">${opt('', g.delegateLimit == null ? '' : 'x', `Studio default (${S.st.settings.delegateLimit ?? 3})`)}${[0, 1, 2, 3, 4, 6, 8].map((n) => opt(String(n), g.delegateLimit == null ? 'x' : String(g.delegateLimit), n === 0 ? 'None' : `${n} open at once`)).join('')}</select><small>Full chats an agent may open to fan work out. Agents on this PC only; cloud agents can't open chats.</small></label>
      <label class="field"><span>Subagents per agent</span><select name="subagentLimit">${opt('', g.subagentLimit == null ? '' : 'x', `Studio default (${S.st.settings.subagentLimit || 'no limit'})`)}${[0, 1, 2, 3, 4, 6, 8, 12, 16].map((n) => opt(String(n), g.subagentLimit == null ? 'x' : String(g.subagentLimit), n === 0 ? 'No limit' : `${n} at once`)).join('')}</select><small>Short-lived helpers inside one chat. Enforced on this PC; cloud agents are asked to keep to it.</small></label>
    </div>
    <div class="two">
      <div class="field"><span class="field-label">Status</span><div class="row" style="gap:6px;flex-wrap:wrap">
        <span class="pill ${statusOf(g)}">${STATUS_LABEL[statusOf(g)]}</span>
        ${statusOf(g) === 'active' ? `<button type="button" class="ghost small" data-act="game-status" data-id="${g.id}" data-status="paused">Pause</button>` : ''}
        ${statusOf(g) === 'paused' || statusOf(g) === 'shipped' ? `<button type="button" class="ghost small" data-act="game-status" data-id="${g.id}" data-status="active">${statusOf(g) === 'shipped' ? 'Back to development' : 'Resume'}</button>` : ''}
        ${statusOf(g) !== 'archived' ? `<button type="button" class="ghost small" data-act="game-ship" data-id="${g.id}">${statusOf(g) === 'shipped' ? '+ Release' : 'Mark as shipped'}</button><button type="button" class="ghost small" data-act="game-archive" data-id="${g.id}">Archive</button>` : `<button type="button" class="primary small" data-act="game-restore" data-id="${g.id}">Restore</button>`}
      </div><small>${statusOf(g) === 'shipped' ? `Shipped ${new Date(g.shippedAt).toLocaleDateString()}${g.releases?.length > 1 ? ` · ${g.releases.length} releases` : ''}. Autopilot is off; your notes still reach the agents.` : statusOf(g) === 'archived' ? 'Nothing runs. Restore it to bring it back into development.' : 'Shipped games keep taking your notes for patches; archived games stop entirely.'}</small></div>
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

    ${jungleSettings(g)}

    <h3>Usage limits &amp; rules</h3>
    <p class="hint" style="margin-top:-4px">Accounts are shared between your games. Decide how far into each account's limits this game may go, and how its agents should work as an account fills up. Rules are checked before every turn against that agent's own account.</p>
    <div class="two">
      <label class="field"><span>Stop at</span><select name="usageCap">${opt('', g.usagePolicy?.cap ? 'x' : '', 'No cap (studio guard only)')}${[50, 60, 70, 75, 80, 85, 90, 95].map((n) => opt(String(n), String(g.usagePolicy?.cap || ''), `${n}% of session or weekly`)).join('')}</select><small>Past this, the game's agents on that account stop taking work (messages you send one agent still go through). They pick up again when the limit resets.</small></label>
      <div class="field"><span class="field-label">Right now</span>${policyNow(g)}</div>
    </div>
    <div id="rules">${(g.usagePolicy?.rules || []).map(ruleRow).join('')}</div>
    <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
      <button type="button" class="ghost small" data-act="rule-add">+ Rule</button>
      <select class="mini" id="rule-preset"><option value="">Add a prefilled rule…</option>${S.st.policy.presets.map((p, i) => `<option value="${i}">${esc(ruleText(p))}</option>`).join('')}</select>
      <button type="button" class="ghost small" data-act="rule-starter" title="Six rules that stretch an account across the week">Add the starter set</button>
    </div>

    ${playtestSection(g)}

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
      <label class="field"><span>itch.io page</span><input name="itchTarget" value="${esc(g.itch?.target || '')}" placeholder="yourname/your-game (or its itch.io URL)"><small>For Upload to itch.io on each build: web builds go to the html5 channel, .exe to windows, .apk to android. Needs <a href="https://itch.io/docs/butler/" target="_blank" rel="noopener">butler</a> installed and logged in once.</small></label>
      <div class="field"><span class="field-label">Playing builds</span><small class="hint">Web builds (an index.html in the output) open in your browser; Windows builds run; Android builds install on a Quest plugged in by USB (needs adb from Meta Quest Developer Hub). Set the output folder above so builds collect what to play.</small></div>
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

// ---- Usage rules editor (rows are plain DOM; saved with the settings form)

const routeTags = (g, model) => (g.modelRoutes || []).filter((r) => r.model === model).flatMap((r) => r.tags).join(', ');
const isPaceMetric = (m) => /-pace$/.test(m);
const ruleText = (r) => (isPaceMetric(r.metric)
  ? `${r.metric.startsWith('weekly') ? 'Weekly' : 'Session'} more than ${r.above} points ahead of pace → ${r.action === 'instruct' ? `tell agents "${r.text.slice(0, 50)}…"` : S.st.policy.actions[r.action]}`
  : ruleTextFixed(r));
const ruleTextFixed = (r) => `${S.st.policy.metrics[r.metric].replace(/ \(.+\)/, '')} over ${r.above}% → ${r.action === 'instruct' ? `tell agents "${r.text.slice(0, 50)}…"` : S.st.policy.actions[r.action]}`;

function ruleRow(r = { metric: 'weekly', above: 80, action: 'one-task', on: true }) {
  const opt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="rule${r.on === false ? ' off' : ''}" data-rule="${esc(r.id || '')}">
    <input type="checkbox" class="r-on" title="Rule on" ${r.on === false ? '' : 'checked'}>
    <span>When</span><select class="mini r-metric">${Object.entries(S.st.policy.metrics).map(([k, l]) => opt(k, r.metric, l)).join('')}</select>
    <span class="r-pre">${isPaceMetric(r.metric) ? 'is more than' : 'is over'}</span><input class="r-above" type="number" min="1" max="100" value="${r.above}"><span class="r-unit">${isPaceMetric(r.metric) ? 'points ahead of pace' : '%'}</span>
    <select class="mini r-action">${Object.entries(S.st.policy.actions).map(([k, l]) => opt(k, r.action, l)).join('')}</select>
    <button type="button" class="icon-btn" data-act="rule-remove" title="Remove rule">✕</button>
    <input class="r-text" placeholder="What should the agents do? e.g. Only fix bugs; no new features" value="${esc(r.text || '')}" ${r.action === 'instruct' ? '' : 'hidden'}>
  </div>`;
}

function readRules() {
  return $$('#rules .rule').map((el) => ({
    id: el.dataset.rule || undefined,
    on: $('.r-on', el).checked,
    metric: $('.r-metric', el).value,
    above: Number($('.r-above', el).value),
    action: $('.r-action', el).value,
    text: $('.r-text', el).value,
  }));
}

function addRuleRows(rules) {
  const box = $('#rules');
  for (const r of rules) box.insertAdjacentHTML('beforeend', ruleRow({ ...r, id: '' }));
  toast(`${rules.length} rule${rules.length > 1 ? 's' : ''} added. Save to apply.`);
}

// Each account this game's agents use, with its usage and what the policy does on it now.
function policyNow(g) {
  const accts = [...new Set(agentsOf(g.id).map((a) => a.accountId))].map(acctOf).filter(Boolean);
  if (!accts.length) return '<span class="hint">No agents yet.</span>';
  const pct = (a, kind) => Math.round(Math.max(0, ...windowsOf(a).filter((w) => (kind === 'session' ? w.label === 'Session' : /Weekly/.test(w.label))).map((w) => (w.utilization || 0) * 100)));
  return accts.map((a) => {
    const s = pct(a, 'session');
    const w = pct(a, 'weekly');
    const p = g.usagePolicy || {};
    const ahead = (m) => (m === 'session-pace' ? a.pace?.session?.ahead : a.pace?.weekly?.ahead) ?? 0;
    const hit = (r) => r.on && (isPaceMetric(r.metric) ? ahead(r.metric) : r.metric === 'session' ? s : r.metric === 'weekly' ? w : Math.max(s, w)) >= r.above;
    const capped = p.cap && Math.max(s, w) >= p.cap;
    const live = (p.rules || []).filter(hit);
    const wp = a.pace?.weekly;
    const paceTxt = wp?.ahead != null ? ` (${Math.abs(wp.ahead) < 3 ? 'on pace' : `${Math.round(Math.abs(wp.ahead))} points ${wp.ahead > 0 ? 'ahead of' : 'behind'} pace`}${a.pace.expiring ? ', resets soon: gets work first' : ''})` : '';
    return `<div class="hint" style="margin:2px 0"><b style="color:var(--text)">${esc(a.name)}</b> session ${s}% · weekly ${w}%${paceTxt} → ${capped ? '<b style="color:var(--accent)">capped: holding work</b>' : live.length ? esc(live.map((r) => (r.action === 'instruct' ? 'custom instruction' : S.st.policy.actions[r.action].replace(/ \(.+\)/, ''))).join(', ')) : 'normal'}</div>`;
  }).join('');
}

function bindSettings(g) {
  $('#rule-preset').onchange = (e) => {
    if (e.target.value === '') return;
    addRuleRows([S.st.policy.presets[Number(e.target.value)]]);
    e.target.value = '';
  };
  $('#rules').addEventListener('change', (e) => {
    const row = e.target.closest('.rule');
    if (e.target.classList.contains('r-action')) $('.r-text', row).hidden = e.target.value !== 'instruct';
    if (e.target.classList.contains('r-on')) row.classList.toggle('off', !e.target.checked);
    if (e.target.classList.contains('r-metric')) {
      $('.r-pre', row).textContent = isPaceMetric(e.target.value) ? 'is more than' : 'is over';
      $('.r-unit', row).textContent = isPaceMetric(e.target.value) ? 'points ahead of pace' : '%';
    }
  });
  $('#game-settings').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    try {
      await api('PATCH', `/api/games/${g.id}`, {
        usagePolicy: { cap: f.usageCap, rules: readRules() },
        itch: { target: f.itchTarget },
        name: f.name, leadAgentId: f.leadAgentId || null, brief: f.brief, autopilot: f.autopilot, priority: Number(f.priority),
        coordinatorFile: f.coordinatorFile, claimBatch: Number(f.claimBatch), delegateLimit: f.delegateLimit, subagentLimit: f.subagentLimit,
        permissionMode: f.permissionMode, model: f.model, effort: f.effort, checkCommand: f.checkCommand,
        split: Object.fromEntries(SPLIT_ROWS.map(([k]) => [k, f[`split_${k}`]])), jungleMode: f.jungleMode, jungleAllow: f.jungleAllow,
        modelRoutes: [{ tags: f.routeSonnet, model: 'sonnet' }, { tags: f.routeHaiku, model: 'haiku' }],
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
      ${hasDefault ? '' : `<label class="check"><input type="checkbox" name="useDefault"><span>Use the Claude login already on this computer<br><span class="hint" style="margin:0">Quick, but it follows whatever you sign into in the Claude app or CLI. Leave this off and Ballast gives the account its own profile and opens a terminal to sign in once (recommended): then switching accounts elsewhere never affects Ballast.</span></span></label>`}
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
      <label class="field"><span>Plan price per month (USD)</span><input name="monthlyCost" type="number" min="0" step="1" value="${a.monthlyCost ?? ''}" placeholder="${planPrice(a) ? `${planPrice(a)} (guessed from the ${esc(a.plan || '')} plan)` : 'e.g. 100'}"><small>Used for cost per finished task and each game's share of your plans on the Studio page.</small></label>
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
    body: `<label class="field"><span>Start from</span><select name="start" id="ng-start">
        <option value="jungle">A new Jungle Engine game (the engine's starter)</option>
        <option value="repo">A repo or folder I already have</option>
      </select></label>
      <label class="field"><span>Name</span><input name="name" id="ng-name" placeholder="e.g. Dark Territory"></label>
      <div data-start="jungle">
        <div id="ng-jcheck" class="ng-jcheck"><p class="hint">Checking this PC for the engine…</p></div>
        <label class="field"><span>Save it in</span><select name="jwhere" id="ng-jwhere">
          <option value="repo">My games repo: a new folder in its games folder (pull request)</option>
          <option value="local">A new project of its own on this PC</option>
        </select></label>
        <div class="two">
          <label class="field"><span>Game id</span><input name="jid" id="ng-jid" placeholder="darkterritory"><small>Lowercase letters and digits. Everything the game names starts with it, and it names the game's folder.</small></label>
          <label class="field" data-jwhere="repo"><span>Games folder on GitHub</span><input name="gamesFolder" id="ng-jfolder" placeholder="https://github.com/owner/repo/tree/main/games"><small>The project's games folder. The game goes in <code id="ng-jpath">games/&lt;id&gt;</code>.</small></label>
          <label class="field" data-jwhere="local" hidden><span>Project folder</span><input name="jdir" id="ng-jdir"><small>New or empty. Ballast makes the git repo.</small></label>
        </div>
        <label class="field"><span>Tagline (optional)</span><input name="tagline" placeholder="What players read under the title"></label>
        <p class="hint" data-jwhere="repo">Ballast copies the starter's demo pack for the engine version that repo installs into its games folder, renames it to the game id, registers it in the project's client and server apps, checks it, and opens a pull request. The game runs as Claude cloud sessions on its folder (connect them on the Agents tab), and autopilot turns on once you merge the pull request.</p>
        <div data-jwhere="local" hidden>
          <label class="field"><span>GitHub repo (optional)</span><input name="ghrepo" placeholder="e.g. thecompanylive/jungle-darkterritory"><small>Left empty, the project stays on this PC. Filled in, Ballast creates that repo (private) and pushes the first commit.</small></label>
          <label class="check"><input type="checkbox" name="keepHumanDemo"><span>Keep the « Taille humaine » sample pack<br><span class="hint" style="margin:0">A second pack with human-size players, a table and a button. Leave it off for a gorilla-envelope game.</span></span></label>
        </div>
      </div>
      <div data-start="repo" hidden>
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
          <label class="field"><span>GitHub repo</span><input name="github" placeholder="owner/name, or a folder link like github.com/owner/name/tree/main/game"><small>A folder link keeps agents inside that folder.</small></label>
          <label class="field"><span>Base branch</span><input name="baseBranch" placeholder="Repo default"></label>
        </div>
        <p class="hint">Each agent works in a Claude Code cloud session on its own branch and opens a pull request. Every account needs GitHub connected on claude.ai/code (run <code>/web-setup</code> once in Claude Code, or install the Claude GitHub app). Ballast clones the repo here only to watch for reports and run builds.</p>
      </div>
      </div>
      <label class="field"><span>Agents</span>${S.st.accounts.map((a) => `<label class="check" style="margin-bottom:6px"><input type="checkbox" name="acc:${a.id}" ${a.loggedIn ? 'checked' : ''}><span>${esc(a.name)} <span class="hint" style="display:inline">${esc(a.email || (a.loggedIn ? '' : 'not logged in'))}</span></span></label>`).join('')}</label>
      <label class="field"><span>Game brief (optional)</span><textarea name="brief" rows="4" placeholder="Genre, pillars, platform, art direction…"></textarea></label>
      <label class="check" data-start="repo" hidden><input type="checkbox" name="survey" checked><span>If the repo already has work in it, have the lead agent survey it first<br><span class="hint" style="margin:0">Reads the code and history, suggests a brief and fills the board. Use Sessions on an agent to continue Claude conversations you already had in this repo.</span></span></label>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Create', kind: 'primary', onClick: async (root) => {
        const f = formData(root);
        const accountIds = Object.keys(f).filter((k) => k.startsWith('acc:') && f[k]).map((k) => k.slice(4));
        if (f.start === 'jungle' && f.jwhere === 'repo') {
          const g = await api('POST', '/api/jungle/repo-games', { name: f.name, id: f.jid, folder: f.gamesFolder, tagline: f.tagline, brief: f.brief, accountIds });
          S.st = await api('GET', '/api/state');
          selectGame(g.id);
          toast('Game folder made. Checking it, then opening the pull request; the feed reports each step.');
          return;
        }
        if (f.start === 'jungle') {
          const g = await api('POST', '/api/jungle/projects', {
            name: f.name, id: f.jid, dir: f.jdir, tagline: f.tagline, keepHumanDemo: f.keepHumanDemo, brief: f.brief, accountIds,
            github: f.ghrepo?.trim() ? { repo: f.ghrepo.trim() } : null,
          });
          S.st = await api('GET', '/api/state');
          selectGame(g.id);
          toast('Project made. Installing the engine; the feed reports each step.');
          return;
        }
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
      $('#ng-jwhere', root).onchange = (e) => {
        for (const el of $$('[data-jwhere]', root)) el.hidden = el.dataset.jwhere !== e.target.value;
      };
      $('#ng-start', root).onchange = (e) => {
        for (const el of $$('[data-start]', root)) el.hidden = el.dataset.start !== e.target.value;
      };
      // The id and folder follow the name until they are typed in by hand.
      const id = $('#ng-jid', root), dir = $('#ng-jdir', root);
      let jroot = '';
      const sync = () => {
        const v = $('#ng-name', root).value.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 24);
        if (!id.dataset.typed) id.value = v;
        const sep = jroot.includes('\\') ? '\\' : '/';
        if (!dir.dataset.typed && jroot) dir.value = id.value ? `${jroot}${sep}jungle-${id.value}` : '';
        const folder = $('#ng-jfolder', root).value.match(/\/tree\/[^/]+\/(.+?)\/*$/)?.[1] || 'games';
        $('#ng-jpath', root).textContent = `${folder}/${id.value || '<id>'}`;
      };
      $('#ng-name', root).addEventListener('input', sync);
      id.addEventListener('input', () => { id.dataset.typed = '1'; sync(); });
      dir.addEventListener('input', () => { dir.dataset.typed = '1'; });
      api('GET', '/api/jungle/check').then((c) => {
        jroot = c.defaultRoot;
        if (!$('#ng-jfolder', root).value) $('#ng-jfolder', root).value = c.gamesFolder || '';
        $('#ng-jfolder', root).addEventListener('input', sync);
        sync();
        $('#ng-jcheck', root).innerHTML = `<ul class="ng-jlist">${c.items.map((i) => `<li class="${i.ok ? 'ok' : 'bad'}">${i.ok ? '✓' : '✗'} ${esc(i.label)}${i.ok ? '' : `<br><span class="hint" style="margin:0">${esc(i.fix)}</span>`}</li>`).join('')}</ul>
          <p class="hint" style="margin:4px 0 0">Ballast copies the engine's starter (<a href="${esc(c.docs)}" target="_blank">Your first game</a>), renames its demo pack to your game's id and checks it before any agent starts work.</p>`;
      }).catch((err) => { $('#ng-jcheck', root).innerHTML = `<p class="hint">Could not check this PC: ${esc(err.message)}</p>`; });
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
      <label class="field"><span>Role</span><input name="role" list="roles" value="${esc(a.role)}">${rolesList}</label>
      <label class="field"><span>Model</span><select name="model">${[['', 'Game default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']].map(([v, l]) => `<option value="${v}"${(a.model || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select><small>${S.st.games.find((x) => x.id === a.gameId)?.runner === 'cloud' ? "Cloud agents: pick the same model in this agent's claude.ai session; Ballast can't change it there. " : ''}Tickets routed to this model (Settings → Models by ticket type) wait for agents set to it.</small></label>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (root) => api('PATCH', `/api/agents/${a.id}`, formData(root)) }],
  });
}

function editTaskModal(id) {
  const t = S.st.tasks.find((x) => x.id === id);
  modal({
    title: `Task #${t.num}`,
    body: `<label class="field"><span>Title</span><input name="title" value="${esc(t.title)}"></label>
      <label class="field"><span>Detail</span><textarea name="detail" rows="6">${esc(t.detail)}</textarea></label>
      <label class="field"><span>Priority</span><select name="priority">${PRIO_LABEL.map((l, i) => `<option value="${i}"${(t.priority ?? 1) === i ? ' selected' : ''}>${l}</option>`).join('')}</select><small>Agents take Urgent first, then High; Low only when nothing else fits.</small></label>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: (root) => { const f = formData(root); return api('PATCH', `/api/tasks/${id}`, { ...f, priority: Number(f.priority) }); } }],
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
      <label class="field"><span>Prompt cache lifetime</span><select name="promptCacheTtl">${[['1h', '1 hour (recommended)'], ['5m', '5 minutes'], ['auto', 'Let Claude Code decide']].map(([v, l]) => `<option value="${v}"${(s.promptCacheTtl || '1h') === v ? ' selected' : ''}>${l}</option>`).join('')}</select><small>How long Claude keeps what an agent or Ballast run already sent, so the next turn reads it back at a fraction of the cost. Agent turns are often minutes to hours apart, so 1 hour pays off. Claude Code already uses 1 hour on a subscription but drops to 5 minutes once an account runs on usage credits; this keeps it at 1 hour there too.</small></label>
      <h4 class="sub-h">Fanning out</h4>
      <div class="two">
        <label class="field"><span>Delegate chats per agent</span><input name="delegateLimit" type="number" min="0" max="8" value="${s.delegateLimit ?? 3}"><small>Full chats an agent may have open at once to spread its work (0 = off). Each lands on the account with the most headroom.</small></label>
        <label class="field"><span>Delegate depth</span><input name="delegateDepth" type="number" min="0" max="4" value="${s.delegateDepth ?? 2}"><small>How many levels deep delegates may open their own delegates.</small></label>
      </div>
      <label class="field"><span>Subagents per agent</span><input name="subagentLimit" type="number" min="0" max="16" value="${s.subagentLimit ?? 4}"><small>Short-lived helpers inside each chat, at once (0 = no limit). Games can override both limits.</small></label>
      <h4 class="sub-h">Your review (studio default; each game can override in its department tabs)</h4>
      <div class="two">${[...S.st.disciplines, { id: 'other', label: 'Untagged work' }].map((d) => `<label class="field"><span>${esc(d.label)}</span><select name="review.${d.id}">
        ${['after', 'gate', 'skip'].map((m) => `<option value="${m}"${(s.review?.[d.id] || 'after') === m ? ' selected' : ''}>${MODE_INFO[m].label}</option>`).join('')}</select></label>`).join('')}</div>
      <div class="two">
        <label class="field"><span>Auto-approve unreviewed work after (hours)</span><input name="reviewAutoApproveHours" type="number" min="0" value="${s.reviewAutoApproveHours}"><small>Only for "Approve first" areas. 0 = never.</small></label>
        <label class="field"><span>Delivery heads-up (minutes before each check-in)</span><input name="deliveryHeadsUpMin" type="number" min="0" value="${s.deliveryHeadsUpMin}"></label>
      </div>
      <h4 class="sub-h">Daily update and time away</h4>
      <div class="two">
        <label class="field"><span>Daily update in each game's Feed</span><div class="row"><label class="check" style="margin:0"><input type="checkbox" name="dr.on" ${s.dailyReport?.on !== false ? 'checked' : ''}><span>at</span></label><input name="dr.at" type="time" value="${esc(s.dailyReport?.at || s.workHours?.end || '18:00')}" style="width:auto"></div><small>What got done, what to check, what's still in progress and how the game plays differently, in plain words. A quiet day is one line. <a href="#" data-act="daily-now">Write today's updates now</a></small></label>
        <div class="field"><span class="field-label">Time away</span><div class="row" style="gap:6px;flex-wrap:wrap">
          <select name="away.reason" style="width:auto">${[['', 'Not away'], ['sick', 'Off sick'], ['vacation', 'On vacation'], ['away', 'Away']].map(([v, l]) => `<option value="${v}"${(s.away?.reason || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <input name="away.from" type="date" value="${esc(s.away?.from || '')}" style="width:auto"><span class="hint" style="margin:0">to</span><input name="away.to" type="date" value="${esc(s.away?.to || '')}" style="width:auto"></div>
          <input name="away.note" value="${esc(s.away?.note || '')}" placeholder="Note for the team (optional)" style="margin-top:6px">
          <small class="hint" style="display:block;margin-top:6px;font-weight:normal">While you're away, agents leave work that needs you (approvals, playtests, decisions) on the board. They do review-free work instead: engine updates, asset quality in the current style, QA checks, headset simulations, performance. Ballast adds that work when a board runs low, and the first update after you're back covers the whole time away.</small></div>
      </div>
      <h4 class="sub-h">Jungle Engine</h4>
      <p class="hint" style="margin-top:-2px">${(() => { const j = S.st.jungleDocs || {}; return `Ballast copies the engine's docs from <a href="https://thecompanylive.github.io/jungle-engine/" target="_blank" rel="noopener">thecompanylive.github.io/jungle-engine</a> once a day and works within them: triage, GDD checks, audits, conversation mode and agents read them, and each day's changes are summarized in Jungle games' Feeds, with tickets where a game's code is affected. ${j.syncing ? 'Syncing now…' : j.lastSync ? `Last synced ${esc(ago(j.lastSync))}: ${j.pages} guide pages, latest engine ${esc(j.engine || '?')}.` : 'Not synced yet.'}${j.error ? ` <span style="color:var(--red)">${esc(j.error)}</span>` : ''} <a href="#" data-act="jungle-docs-sync">Sync now</a>`; })()}</p>
      <h4 class="sub-h">Working hours and usage reports</h4>
      <div class="two">
        <label class="field"><span>Working hours</span><div class="row"><input name="wh.start" type="time" value="${esc(s.workHours?.start || '09:00')}"><span class="hint" style="margin:0">to</span><input name="wh.end" type="time" value="${esc(s.workHours?.end || '18:00')}"></div></label>
        <label class="field"><span>Report every (min)</span><input name="usageReportMin" type="number" min="0" value="${s.usageReportMin}"><small>Each account's session and weekly limits, during working hours. 0 = off.</small></label>
      </div>
      <div class="field"><span class="field-label">Working days</span><div class="row">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `<label class="check" style="margin:0 10px 0 0"><input type="checkbox" name="wh.day${i}" ${(s.workHours?.days || []).includes(i) ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
        <small class="hint">Background limit checks also only run in these hours.</small></div>
      <label class="field"><span>Send reports to (Slack or Discord webhook, optional)</span><input name="reportWebhook" value="${esc(s.reportWebhook || '')}" placeholder="https://hooks.slack.com/…"><small>Usage reports, the daily digest and the weekly report. A Discord channel webhook pushes them to your phone.</small></label>
      <div class="two">
        <label class="check" style="margin-top:22px"><input type="checkbox" name="digestDaily" ${s.digestDaily !== false ? 'checked' : ''}><span>Daily digest at the start of your working day</span></label>
        <label class="check"><input type="checkbox" name="blockTriage" ${s.blockTriage !== false ? 'checked' : ''}><span>Blocked tickets triage themselves<br><span class="hint" style="margin:0">Claude retries them another way, or raises a Human Intervention request with exact steps.</span></span></label>
        <label class="field"><span>Weekly report</span><div class="row"><select name="wk.day" style="width:auto"><option value="">Off</option>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((n, i) => `<option value="${i}"${(s.weeklyReport?.day ?? 5) === i ? ' selected' : ''}>${n}</option>`).join('')}</select><input name="wk.time" type="time" value="${esc(s.weeklyReport?.time || '16:00')}" style="width:auto"></div></label>
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
      <p class="hint">Data folder: <a href="#" data-act="open-folder" data-path="${esc(S.st.home)}">${esc(S.st.home)}</a> · <a href="#" data-act="setup-open">Open the setup guide</a> · <a href="#" data-act="phone-open">Phone</a> · <a href="#" data-act="discord-open">Discord</a></p>`,
    actions: [{ label: 'Cancel' }, {
      label: 'Save', kind: 'primary', onClick: (root) => {
        const f = formData(root);
        const reviewModes = {};
        for (const k of Object.keys(f)) if (k.startsWith('review.')) { reviewModes[k.slice(7)] = f[k]; delete f[k]; }
        const workHours = { start: f['wh.start'], end: f['wh.end'], days: [0, 1, 2, 3, 4, 5, 6].filter((i) => f[`wh.day${i}`]) };
        const weeklyReport = { day: f['wk.day'], time: f['wk.time'] };
        const director = {
          dailyReport: { on: !!f['dr.on'], at: f['dr.at'] || '18:00' },
          away: f['away.reason'] ? { reason: f['away.reason'], from: f['away.from'], to: f['away.to'], note: f['away.note'] } : null,
        };
        for (const k of Object.keys(f)) if (k.startsWith('wh.') || k.startsWith('wk.') || k.startsWith('dr.') || k.startsWith('away.')) delete f[k];
        return api('PATCH', '/api/director', director).then(() => api('PATCH', '/api/settings', { ...f, digestDaily: !!f.digestDaily, blockTriage: !!f.blockTriage, review: reviewModes, workHours, weeklyReport }));
      },
    }],
  });
}

// ---------------------------------------------------------------------------
// Phone: Ballast on the home network / Tailscale, paired with a code

function phoneSetupHtml() {
  setTimeout(() => loadPhone($('#su-phone')), 0);
  return '<p class="hint">Loading…</p>';
}

async function loadPhone(box) {
  if (!box) return;
  let p;
  try { p = await api('GET', '/api/phone'); } catch (err) { box.innerHTML = `<p class="hint">${esc(err.message)}</p>`; return; }
  const on = p.lan || p.tailscale;
  const addrs = p.addresses.filter((a) => p[a.kind]);
  const ts = p.addresses.some((a) => a.kind === 'tailscale');
  box.innerHTML = `
    <label class="check"><input type="checkbox" data-phone="lan" ${p.lan ? 'checked' : ''}><span><b>On my home Wi-Fi</b><br><span class="hint" style="margin:0">Your phone opens Ballast while it's on the same network as this PC.</span></span></label>
    <label class="check"><input type="checkbox" data-phone="tailscale" ${p.tailscale ? 'checked' : ''}><span><b>Anywhere, through Tailscale</b><br><span class="hint" style="margin:0">${ts ? 'Tailscale is running on this PC.' : 'Install <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a> (free) on this PC and your phone and sign both in to the same account. Its traffic is encrypted end to end.'}</span></span></label>
    ${on ? `<div class="phone-box">
      ${addrs.length ? `<div><span class="field-label">On your phone, open</span>${addrs.map((a) => `<div class="phone-url"><code>${esc(a.url)}</code><span class="hint" style="margin:0">${a.kind === 'tailscale' ? 'Tailscale' : 'home Wi-Fi'}${a.error ? ` · <span style="color:var(--red)">${esc(a.error)}</span>` : a.listening ? '' : ' · starting…'}</span></div>`).join('')}</div>
        <div><span class="field-label">Pairing code</span><div class="pair-code">${esc(p.code)}</div><span class="hint" style="margin:0">Type it on your phone. Good for one phone, for ${Math.max(1, Math.round((p.codeExpires - Date.now()) / 60000))} min. <a href="#" data-act="phone-code">New code</a></span></div>`
        : `<p class="hint">${p.tailscale && !ts ? 'Waiting for Tailscale to come up on this PC.' : 'No matching network found on this PC.'}</p>`}
      <p class="hint" style="margin:0">Windows may ask whether Node.js can use private networks the first time: allow it. Then add the page to your home screen to use Ballast like an app.</p>
    </div>` : ''}
    ${p.devices.length ? `<span class="field-label" style="margin-top:12px">Paired devices</span>${p.devices.map((d) => `<div class="su-acct"><b>${esc(d.name)}</b><span class="hint grow" style="margin:0">paired ${ago(d.createdAt)} · last used ${ago(d.lastSeen)}</span><button class="ghost small" data-act="phone-revoke" data-id="${d.id}">Remove</button></div>`).join('')}` : ''}`;
  for (const cb of $$('[data-phone]', box)) cb.onchange = async () => { try { await api('PATCH', '/api/phone', { [cb.dataset.phone]: cb.checked }); setTimeout(() => loadPhone(box), 600); } catch (err) { fail(err); } };
}

function phoneModal() {
  modal({ title: 'Ballast on your phone', body: '<p class="hint" style="margin-top:0">Ballast keeps running on this PC; your phone opens it over your own network. No server, no cloud bill.</p><div id="phone-panel"><p class="hint">Loading…</p></div>', actions: [{ label: 'Done' }], onMount: (root) => loadPhone($('#phone-panel', root)) });
}

// ---------------------------------------------------------------------------
// Setup guide: first run for an author developer (also from Settings)

const SETUP_STEPS = [
  ['pc', 'This PC'],
  ['you', 'You'],
  ['accounts', 'Claude accounts'],
  ['work', 'How you work'],
  ['phone', 'Your phone'],
  ['game', 'First game'],
];

function setupShell() {
  const step = SETUP_STEPS[S.setupStep || 0][0];
  const s = S.st.settings;
  const nav = SETUP_STEPS.map(([id, label], i) => `<button class="${i === (S.setupStep || 0) ? 'active' : ''}${i < (S.setupStep || 0) ? ' done' : ''}" data-act="setup-go" data-i="${i}"><span>${i < (S.setupStep || 0) ? '✓' : i + 1}</span>${label}</button>`).join('');
  const body = {
    pc: `<h2>Let's get this PC ready</h2>
      <p class="hint">Ballast drives the Claude Code CLI on this computer. Everything below runs locally; nothing needs a server.</p>
      <div id="su-checks" class="su-checks"><p class="hint">Checking…</p></div>
      <button type="button" class="ghost small" data-act="setup-recheck">Check again</button>`,
    you: `<h2>About you</h2>
      <p class="hint">Ballast is built for author developers: one person making games with a team of AI agents. You're the director: agents ask you questions, you review their work, and you set the direction.</p>
      <form id="su-you" class="settings">
        <label class="field"><span>Your name</span><input name="directorName" value="${esc(s.directorName === 'Director' ? '' : s.directorName)}" placeholder="Shown on your notes to agents"></label>
        <div class="field"><span class="field-label">When do you work?</span><div class="row"><input name="wh.start" type="time" value="${esc(s.workHours?.start || '09:00')}" style="width:auto"><span class="hint" style="margin:0">to</span><input name="wh.end" type="time" value="${esc(s.workHours?.end || '18:00')}" style="width:auto"></div>
          <div class="row" style="margin-top:8px">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `<label class="check" style="margin:0 10px 0 0"><input type="checkbox" name="wh.day${i}" ${(s.workHours?.days || []).includes(i) ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
          <small class="hint">Usage reports and limit checks run in these hours. Agents keep working around the clock either way.</small></div>
      </form>`,
    accounts: `<h2>Your Claude accounts</h2>
      <p class="hint">Each Claude account is a pool of usage. More accounts = more agents working at once. Add every account you want working (Pro, Max or Team), log each in, and set what each plan costs you so the Studio can show your cost per finished task.</p>
      <div id="su-accounts"></div>
      <button type="button" class="primary small" data-act="new-account">+ Add an account</button>`,
    work: `<h2>How you work</h2>
      <p class="hint">Agents never wait on you. For each kind of work, choose whether you want to see it after it lands, approve it first, or not see it at all ("not my field").</p>
      <form id="su-work" class="settings">
        <div class="two">${[...S.st.disciplines, { id: 'other', label: 'Untagged work' }].map((d) => `<label class="field"><span>${esc(d.label)}</span><select name="review.${d.id}">
          ${['after', 'gate', 'skip'].map((m) => `<option value="${m}"${(s.review?.[d.id] || 'after') === m ? ' selected' : ''}>${MODE_INFO[m].label}</option>`).join('')}</select></label>`).join('')}</div>
        <label class="check"><input type="checkbox" name="defaultRules" ${s.defaultUsagePolicy ? 'checked' : ''}><span><b>Start new games with the usage starter rules</b><br><span class="hint" style="margin:0">Paced across each account's week: one task at a time over 60% of a session, smaller tasks 10 points ahead of weekly pace, Sonnet 20 ahead, no fan-out over 80% of a session, no new claims 30 ahead, and tell you over 90%. Nothing holds an account back late in its week, when unused budget would be lost. Change them per game any time.</span></span></label>
        <label class="field"><span>Autopilot leaves an account alone above (%)</span><input name="limitGuardPct" type="number" min="1" max="100" value="${s.limitGuardPct}" style="width:100px"><small>Of its session or weekly limit, across all games.</small></label>
      </form>`,
    phone: `<h2>Ballast on your phone</h2>
      <p class="hint">Check on your games, answer agents and read your digest from your phone. Ballast keeps running on this PC; your phone just opens it. No server, no cloud bill.</p>
      <div id="su-phone"></div>`,
    game: `<h2>Your first game</h2>
      <p class="hint">Point Ballast at a game: an empty folder to start fresh, a project you already have, or a GitHub repo to run agents as Claude cloud sessions. Existing projects get surveyed first: an agent reads the repo, suggests a brief and fills the board.</p>
      <div class="row" style="gap:8px"><button type="button" class="primary" data-act="new-game">Create a game</button>${S.st.games.length ? `<span class="hint" style="margin:0">You have ${S.st.games.length} game${S.st.games.length > 1 ? 's' : ''} already.</span>` : ''}</div>
      <h3 class="sub-h">Then</h3>
      <ul class="su-next"><li>Send a note to the team from the game's Feed. Agents split it into tasks and get going.</li><li>Press <b>Director Review</b> while you play and talk; it becomes tasks too.</li><li>Your <b>Studio</b> page tracks output, cost and audiences across every game.</li></ul>`,
  }[step];
  const last = (S.setupStep || 0) === SETUP_STEPS.length - 1;
  return `<div class="scroll pad setup" style="flex:1"><div class="setup-wrap">
    <nav class="su-nav">${nav}</nav>
    <div class="su-body card">${body}
      <div class="row su-foot">${S.setupStep ? '<button type="button" class="ghost" data-act="setup-back">Back</button>' : ''}<span class="spacer"></span>
        <button type="button" class="ghost" data-act="setup-skip">${S.st.settings.setupDone ? 'Close' : 'Skip setup'}</button>
        <button type="button" class="primary" data-act="setup-next">${last ? 'Finish' : 'Next'}</button></div>
    </div></div></div>`;
}

async function renderSetup() {
  const step = SETUP_STEPS[S.setupStep || 0][0];
  if (step === 'accounts' && $('#su-accounts')) {
    $('#su-accounts').innerHTML = S.st.accounts.length
      ? S.st.accounts.map((a) => `<div class="su-acct"><span class="dot ${a.loggedIn ? 'idle' : 'error'}"></span><b>${esc(a.name)}</b><span class="hint grow" style="margin:0">${a.loggedIn ? esc([a.email, a.plan].filter(Boolean).join(' · ')) : 'not logged in'}${a.loggedIn ? ` · ${money(planPrice(a))}/month${planGuessed(a) ? ' (guessed)' : ''}` : ''}</span>
          ${a.loggedIn ? `<button class="ghost small" data-act="acct-edit" data-id="${a.id}">Set price</button>` : `<button class="primary small" data-act="acct-login" data-id="${a.id}">Log in</button>`}</div>`).join('')
      : '<p class="hint">No accounts yet. The first one can be the Claude login already on this PC.</p>';
  }
  if (step === 'phone' && $('#su-phone') && !$('#su-phone').dataset.done) {
    $('#su-phone').dataset.done = '1';
    $('#su-phone').innerHTML = phoneSetupHtml();
  }
  if (step === 'pc' && $('#su-checks') && !S.setupChecks) {
    S.setupChecks = 'loading';
    try { S.setupChecks = await api('GET', '/api/setup'); } catch (err) { S.setupChecks = null; return fail(err); }
    renderChecks();
  }
}

function renderChecks() {
  const c = S.setupChecks;
  if (!c || c === 'loading' || !$('#su-checks')) return;
  $('#su-checks').innerHTML = c.items.map((i) => `<div class="su-check ${i.ok ? 'ok' : i.required ? 'bad' : 'opt'}">
      <span class="su-mark">${i.ok ? '✓' : i.required ? '✕' : '–'}</span>
      <div class="grow"><b>${esc(i.label)}</b>${i.required ? '' : ' <span class="hint" style="display:inline">optional</span>'} <span class="hint" style="display:inline">${esc(i.detail)}</span>
        ${i.ok ? '' : `<div class="hint" style="margin:2px 0 0">${esc(i.fix)}</div>${i.cmd ? `<div class="cmd" style="margin-top:6px">${esc(i.cmd)}</div>` : ''}`}</div></div>`).join('')
    + (c.ready ? '<p class="hint" style="color:var(--green)">This PC is ready.</p>' : '<p class="hint">Install what\'s missing (run the commands in a terminal), then press Check again.</p>');
}

function setupSave() {
  const step = SETUP_STEPS[S.setupStep || 0][0];
  if (step === 'you') {
    const f = formData($('#su-you'));
    return api('PATCH', '/api/settings', { directorName: f.directorName || 'Director', workHours: { start: f['wh.start'], end: f['wh.end'], days: [0, 1, 2, 3, 4, 5, 6].filter((i) => f[`wh.day${i}`]) } });
  }
  if (step === 'work') {
    const f = formData($('#su-work'));
    const review = {};
    for (const k of Object.keys(f)) if (k.startsWith('review.')) review[k.slice(7)] = f[k];
    return Promise.all([api('PATCH', '/api/settings', { review, limitGuardPct: Number(f.limitGuardPct) }), api('POST', '/api/setup', { defaultRules: !!f.defaultRules })]);
  }
  return null;
}

function openSetup(step = 0) {
  S.view = 'setup';
  S.setupStep = step;
  S.setupChecks = null;
  renderLive();
}

async function setupMove(delta) {
  try { await setupSave(); } catch (err) { return fail(err); }
  const next = (S.setupStep || 0) + delta;
  if (next >= SETUP_STEPS.length) {
    await api('POST', '/api/setup', { done: true });
    toast('All set. Welcome to Ballast.');
    return selectStudio();
  }
  S.setupStep = Math.max(0, next);
  renderLive();
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
  'setup-open': () => { $('.modal-back')?.remove(); openSetup(0); },
  'phone-open': () => { $('.modal-back')?.remove(); phoneModal(); },
  'discord-open': () => { $('.modal-back')?.remove(); discordModal().catch(fail); },
  'digest-now': async () => { await api('POST', '/api/digest'); toast('Digest updated'); },
  'weekly-now': async () => { await api('POST', '/api/weekly'); toast('Writing this week’s report…'); },
  'weekly-copy': (d) => copyText(weeklyMarkdown(S.st.weeklyReports.find((r) => r.id === d.id), d.game), 'Weekly report'),
  'weekly-post-copy': (d) => copyText(S.st.weeklyReports.find((r) => r.id === d.id).games.find((e) => e.gameId === d.game).out.posts[Number(d.i)].text, 'Post'),
  'playtest-pick': (d) => playtestModal(d.id),
  'task-prio': (d) => api('PATCH', `/api/tasks/${d.id}`, { priority: d.dir }),
  'thread-open': (d) => { $('.modal-back')?.remove(); threadModal(d.id); },
  'hi-open': (d) => interventionModal(d.id),
  'hi-cowork': (d) => copyText(coworkText(S.st.interventions.find((i) => i.id === d.id)), 'Cowork brief'),
  'hi-done': (d) => modal({
    title: 'Done?',
    body: '<p class="hint" style="margin-top:0">The tickets waiting on this go back on the board, with your note for the agent.</p><label class="field"><span>Anything the agent should know (optional)</span><textarea name="note" rows="3" placeholder="e.g. The allowlist now has freesound.org and upload.wikimedia.org"></textarea></label>',
    actions: [{ label: 'Cancel' }, { label: 'Back on the board', kind: 'primary', onClick: async (root) => { await api('POST', `/api/interventions/${d.id}/resolve`, { note: $('textarea', root).value }); $$('.modal-back').forEach((m) => m.remove()); toast('Back on the board'); } }],
  }),
  'hi-close': async (d) => { await api('POST', `/api/interventions/${d.id}/resolve`, { close: true }); $$('.modal-back').forEach((m) => m.remove()); toast('Ticket closed'); },
  'hi-dismiss': async (d) => { await api('POST', `/api/interventions/${d.id}/dismiss`); $$('.modal-back').forEach((m) => m.remove()); toast('Dismissed: the tickets stay blocked'); },
  'task-triage': async (d) => { await api('POST', `/api/tasks/${d.id}/triage`); toast('Triaging…'); },
  'ask-toggle': () => { S.askMode = !S.askMode; store('askMode', S.askMode ? '1' : '0'); renderAskLine(); $('#composer-feed textarea')?.focus(); },
  'ask-reset': async () => { await api('POST', `/api/games/${S.gameId}/ask/reset`); toast('New conversation: earlier questions won’t be carried into the next one'); },
  'ask-to-team': (d) => sendAnswerToTeam(d.id),
  'ask-copy': (d) => copyText((S.feeds[S.gameId] || []).find((e) => e.kind === 'answer' && e.askId === d.id)?.text || '', 'Answer'),
  'roadmap-audit': async (d) => { try { await api('POST', `/api/games/${S.gameId}/roadmap/audit`, { model: d.model }); toast('Auditing every feature against the GDD and the repo. The levels update when it finishes (a few minutes).'); } catch (err) { fail(err); } },
  'roadmap-run': async (d) => { await api('POST', `/api/games/${S.gameId}/roadmap`, { model: d.model }); toast('Breaking down the GDD… (a few minutes)'); },
  'feature-open': (d) => featureModal(d.id),
  'ms-add': () => modal({ title: 'New milestone', body: '<label class="field"><span>Name</span><input name="name" placeholder="e.g. Steam Next Fest demo"></label>', actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: (root) => api('PATCH', `/api/games/${S.gameId}/roadmap`, { addMilestone: { name: $('input', root).value || 'Milestone' } }) }] }),
  'ms-reopen': (d) => api('PATCH', `/api/games/${S.gameId}/roadmap`, { milestone: { id: d.id, reopen: true } }),
  'build-run': async (d) => { const r = await api('POST', `/api/builds/${d.id}/run`); toast(`Started ${r.exe}`); },
  'build-quest': async (d) => { await api('POST', `/api/builds/${d.id}/quest`); toast('Installing on your Quest…'); },
  'build-itch': async (d) => { const r = await api('POST', `/api/builds/${d.id}/itch`); toast(`Uploading to itch.io (${r.channel})…`); },
  'playtest-flush': async (d) => { await api('POST', `/api/games/${d.id}/playtest/flush`); toast('Sent to the team'); },
  'phone-code': async (_, el) => { await api('POST', '/api/phone/code'); loadPhone(el.closest('#su-phone, #phone-panel')); },
  'phone-revoke': async (d, el) => { await api('DELETE', `/api/phone/devices/${d.id}`); loadPhone(el.closest('#su-phone, #phone-panel')); },
  'setup-go': (d) => { setupSave()?.catch(fail); S.setupStep = Number(d.i); renderLive(); },
  'setup-next': () => setupMove(1),
  'setup-back': () => setupMove(-1),
  'setup-skip': async () => { await api('POST', '/api/setup', { done: true }); selectStudio(); },
  'setup-recheck': async () => { S.setupChecks = null; $('#su-checks').innerHTML = '<p class="hint">Checking…</p>'; renderSetup(); },
  'inbox': () => { S.view = 'inbox'; store('view', 'inbox'); renderLive(); },
  'dept-mode': (d) => api('PATCH', `/api/games/${S.gameId}`, { review: { [d.d]: d.mode } }),
  'review-approve': async (d) => { const t = await api('POST', `/api/tasks/${d.id}/approve`); toast(`Approved #${t.num}`); },
  'review-changes': (d) => changesModal(d.id),
  'report-now': async () => { toast('Checking every account…'); await api('POST', '/api/usage/report'); },
  'targets-add': (d) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,video/*,audio/*';
    input.onchange = () => addTargetsModal(d.d, input.files);
    input.click();
  },
  'target-view': (d) => {
    const x = S.st.targets.find((t) => t.id === d.id);
    const media = x.kind === 'image' ? `<img class="viewer-img" src="${targetUrl(x)}">` : x.kind === 'video' ? `<video src="${targetUrl(x)}" controls style="width:100%"></video>` : `<audio src="${targetUrl(x)}" controls style="width:100%"></audio>`;
    modal({ title: `Target: ${x.title}`, wide: true, body: `${x.notes ? `<p class="hint" style="margin-top:0">Match: ${esc(x.notes)}</p>` : ''}${media}` });
  },
  'target-edit': (d) => editTargetModal(d.id),
  'target-delete': (d) => confirmModal('Remove this target?', 'Agents stop getting it with their tasks.', 'Remove', () => api('DELETE', `/api/targets/${d.id}`)),
  'targets-share': async () => { toast('Sharing targets…'); await api('POST', `/api/games/${S.gameId}/targets/share`); },
  'dn-breakdown':async (d) => { toast('Breaking it into tasks…'); await api('POST', `/api/dept-notes/${d.id}/breakdown`); },
  'dn-delete': (d) => confirmModal('Delete this note?', "It hasn't been broken into tasks yet, so nothing else changes.", 'Delete', () => api('DELETE', `/api/dept-notes/${d.id}`)),
  'review-start': reviewStart,
  'rs-toggle': (d) => {
    const s = RS.segments[Number(d.i)];
    if (!s) return;
    s.rejected = !s.rejected;
    rsSaveDraft();
    rsRender();
  },
  'review-done': reviewDone,
  'review-mark': () => { RS.segments.push({ t: rsElapsed(), text: 'marked moment', mark: true }); rsSaveDraft(); rsRender(); },
  'review-pause': () => {
    if (RS.paused) {
      RS.pausedMs += Date.now() - RS.pausedAt;
      RS.paused = false;
      rsListen();
    } else {
      whFlush(); // the phrase you were mid-way through still gets written
      RS.paused = true;
      RS.pausedAt = Date.now();
      try { RS.rec?.stop(); } catch { /* not running */ }
    }
    rsRender();
  },
  'review-discard': () => confirmModal('Discard this review?', 'The transcript so far will be deleted.', 'Discard', () => { RS.gen = (RS.gen || 0) + 1; reviewStop(); store(RS_DRAFT, ''); $('#review-session')?.remove(); }),
  'queue-earlier': async () => { const r = await api('POST', `/api/games/${S.gameId}/queue-earlier`); toast(`Queued ${r.queued} for review${r.skipped ? `, ${r.skipped} filed as not your field` : ''}`); },
  'review-all': async (d) => { const r = await api('POST', `/api/games/${S.gameId}/approve-all`, { discipline: d.d }); toast(`Approved ${r.approved}`); },
  'daily-now': async () => { try { await api('POST', '/api/daily-report'); toast('Writing today\'s updates. Each game\'s Feed gets its own.'); } catch (err) { fail(err); } },
  'jungle-docs-sync': async () => { try { await api('POST', '/api/jungle-docs/sync'); toast('Syncing the Jungle Engine docs. Changes show up in Jungle games\' Feeds.'); } catch (err) { fail(err); } },
  'q-answer': (d) => answerModal(d.id),
  'gdd-import': async () => { toast('Importing the GDD from where it lives…'); await api('POST', `/api/games/${S.gameId}/gdd/import`, {}); await loadGdd(); toast('GDD imported as a new version.'); },
  'gdd-paste': () => gddPasteModal(),
  'gdd-download': () => { const d = GDDV.data[S.gameId]; const v = d?.versions?.[0]; if (!d?.current) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([d.current], { type: 'text/markdown' })); a.download = `${(game().slug || 'gdd')}-gdd-v${v.v}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); },
  'gdd-discard': (d) => api('PATCH', `/api/games/${S.gameId}/gdd/drafts/${d.id}`, { discard: true }),
  'gdd-accept': (d) => confirmModal('Accept these edits?', 'They are saved as the next GDD version and written back where the GDD lives; then the board is re-checked against it.', 'Accept', async () => { await api('POST', `/api/games/${S.gameId}/gdd/drafts/${d.id}/accept`); toast('Saved. Writing it back and updating the board…'); }),
  'gym-ask': (d) => gymAskModal(d.section, d.gym || null),
  'gym-remove': (d) => confirmModal('Forget this gym?', 'Ballast stops showing it. The gym\'s code stays in the game.', 'Forget', () => api('DELETE', `/api/games/${S.gameId}/gyms/${d.id}`)),
  'gym-copy': (d) => { const gym = (game().gyms || []).find((x) => x.id === d.id); copyText(gym?.open || '', 'How to open the gym'); },
  'subject-edit': (d) => subjectModal(d.id || null),
  'subject-round': async (d) => { await api('POST', `/api/games/${S.gameId}/subjects/${d.id}/round`, {}); toast('Round is on the board.'); },
  'focus-edit': (d) => focusModal(d.id || null),
  'focus-toggle': (d) => api('PATCH', `/api/games/${S.gameId}/focus`, { toggle: d.id }),
  'focus-remove': (d) => { const f = focusesOf(game()).find((x) => x.id === d.id); confirmModal(`Remove "${f?.title}"?`, 'Its tickets stay on the board; they just stop going first.', 'Remove', () => api('PATCH', `/api/games/${S.gameId}/focus`, { remove: d.id })); },
  'focus-plan': async (d) => { await api('PATCH', `/api/games/${S.gameId}/focus`, { plan: d.id }); toast('Planning: reading the GDD and the code. New tickets land on the board in a few minutes.'); },
  'focus-match': (d) => api('PATCH', `/api/games/${S.gameId}/focus`, { match: true }),
  'section-toggle': (d) => { SEC.open.has(d.id) ? SEC.open.delete(d.id) : SEC.open.add(d.id); renderSections(); },
  'gate-pass': async (d) => { await api('PATCH', `/api/games/${S.gameId}/gates`, { gate: { featureId: d.id, gate: Number(d.gate) } }); toast(`Gate passed: work toward L${d.gate} starts now`); },
  'gates-sort': async () => { const r = await api('POST', `/api/games/${S.gameId}/gates/sort`); toast(`Sorting ${r.tickets} ticket${r.tickets === 1 ? '' : 's'} into sections…`); },
  'gateset-edit': (d) => gateSetModal(d.id || null),
  'gateset-apply': (d) => { const s = S.st.roadmaps[S.gameId].gates.sets.find((x) => x.id === d.id); confirmModal(`Apply "${s.name}"?`, 'Every section it lists moves to its target gate now. Work for gates that open starts right away; tickets above a lowered gate wait.', 'Apply', () => api('PATCH', `/api/games/${S.gameId}/gates`, { applySet: d.id })); },
  'gateset-move': (d) => api('PATCH', `/api/games/${S.gameId}/gates`, { moveSet: { id: d.id, dir: d.dir } }),
  'gateset-delete': (d) => api('PATCH', `/api/games/${S.gameId}/gates`, { deleteSet: d.id }),
  'jungle-brief': async (d) => { const r = await api('GET', `/api/games/${d.id}/jungle-share`); copyText(r.brief, `Brief for Jungle Studio (${r.tasks.length} ticket${r.tasks.length === 1 ? '' : 's'})`); },
  'task-owner': async (d) => { await api('PATCH', `/api/tasks/${d.id}/owner`, { owner: d.owner }); toast(d.owner === 'done-in-jungle' ? 'Marked done in Jungle Studio' : d.owner === 'jungle' ? 'Sent to Jungle Studio: no Ballast agent will take it' : 'Ballast\'s agents can take it now'); },
  'split-preset': (d) => {
    const form = $('#game-settings');
    for (const [k] of SPLIT_ROWS) form[`split_${k}`].value = d.preset === 'code' && (k === 'gameplay' || k === 'backend') ? 'jungle' : 'ballast';
    toast('Set. Press Save to keep it.');
  },
  'q-dismiss': (d) => api('POST', `/api/inbox/${d.id}/dismiss`),
  'q-addtask': async (d) => { try { const t = await api('POST', `/api/inbox/${d.id}/add-task`); toast(`On the board as #${t.num}.`); } catch (err) { fail(err); } },
  'q-reopen': async (d) => { try { await api('POST', `/api/inbox/${d.id}/reopen`); toast('Reopened. Its agent was told to disregard that answer.'); } catch (err) { fail(err); } },
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
  'game-ship': (d) => shipModal(d.id),
  'game-archive': (d) => {
    const g = S.st.games.find((x) => x.id === d.id);
    confirmModal(`Archive ${g.name}?`, 'Queued work is cleared and nothing runs on it any more. Its board, feed, builds and stats are kept, and you can restore it any time.', 'Archive', () => api('PATCH', `/api/games/${d.id}`, { status: 'archived' }));
  },
  'game-restore': (d) => api('PATCH', `/api/games/${d.id}`, { status: 'active' }),
  'toggle-archived': () => { S.showArchived = !S.showArchived; renderSide(); },
  'audit-run': auditModal,
  'audit-delete': (d) => api('DELETE', `/api/audits/${d.id}`),
  'audit-copy': async (d) => {
    const a = S.st.audits.find((x) => x.id === d.id);
    try { await navigator.clipboard.writeText(auditMarkdown(a)); toast('Copied the audit as Markdown'); } catch { modal({ title: 'Bartle Audit', wide: true, body: `<textarea style="width:100%;height:60vh">${esc(auditMarkdown(a))}</textarea>`, actions: [{ label: 'Done' }] }); }
  },
  'rule-add': () => $('#rules').insertAdjacentHTML('beforeend', ruleRow()),
  'rule-remove': (_, el) => el.closest('.rule').remove(),
  'rule-starter': () => addRuleRows(S.st.policy.presets.filter((p) => p.starter)),
  'cloud-track': (d) => trackModal({ url: d.url || '', accountId: d.account || '', discipline: d.discipline || '' }),
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
  'cloud-connect-all': async () => {
    const r = await api('POST', `/api/games/${S.gameId}/cloud/connect`);
    if (r.opened) {
      modal({
        title: 'Connecting cloud sessions',
        body: `<p style="margin-top:0">A terminal opened. For each of ${esc(r.agents.join(', '))}, it creates a Claude cloud session under that agent's account, then asks for the link.</p>
          <ol class="hint" style="padding-left:18px;line-height:1.7"><li>Copy the <b>View:</b> link it prints (https://claude.ai/code/session_…).</li><li>Paste it into the same terminal and press Enter.</li></ol>
          <p class="hint">Ballast connects each agent as soon as you paste its link, and work starts right away.</p>`,
        actions: [{ label: 'OK', kind: 'primary' }],
      });
    } else modal({ title: 'Run this in a terminal', body: `<div class="cmd">${esc(r.command)}</div>`, actions: [{ label: 'Done' }] });
  },
  'cloud-connect': () => {
    const a = agentOf(S.agentId);
    const g = game();
    modal({
      title: `Cloud session for ${a.name}`,
      body: `<p style="margin-top:0">Claude Code only starts a cloud session from an interactive terminal, so this is a one-time step per agent. After that, Ballast sends each task to the session as a message.</p>
        <ol class="hint" style="padding-left:18px;line-height:1.7">
          <li><button type="button" class="btn small" data-start>Start a session in a terminal</button> (runs <code>claude --cloud</code> as ${esc(acctOf(a.accountId)?.name || '')} on github.com/${esc(g.github)}, then asks you to paste the link it prints, and Ballast connects it on its own)</li>
          <li>Or start one yourself on claude.ai/code on that repo, signed in as ${esc(acctOf(a.accountId)?.email || 'that account')}, and paste its link here.</li>
        </ol>
        <label class="field"><span>Session link or id</span><input name="link" value="${esc(a.cloudLink?.url || '')}" placeholder="https://claude.ai/code/session_…"></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Connect', kind: 'primary', onClick: (root) => api('POST', `/api/agents/${a.id}/cloud`, formData(root)) }],
      onMount: (root) => {
        $('[data-start]', root).onclick = async () => {
          try {
            const r = await api('POST', `/api/agents/${a.id}/cloud/start`);
            if (r.opened) toast('Terminal opened. Paste the link it prints into that terminal.');
            else modal({ title: 'Start it in a terminal', body: `<div class="cmd">${esc(r.command)}</div>`, actions: [{ label: 'Done' }] });
          } catch (err) { fail(err); }
        };
      },
    });
  },
  'survey': async () => { await api('POST', `/api/games/${S.gameId}/survey`); toast('Survey queued for the lead agent.'); },
  'brief-accept': async () => { await api('PATCH', `/api/games/${S.gameId}`, { acceptBriefSuggestion: true }); S.shellKey = ''; renderLive(); },
  'brief-dismiss': async () => { await api('PATCH', `/api/games/${S.gameId}`, { dismissBriefSuggestion: true }); S.shellKey = ''; renderLive(); },
  'tab': (d) => openTab(d.tab),
  'new-game': () => (S.st.accounts.length ? newGameModal() : toast('Add a Claude account first.', true)),
  'new-account': newAccountModal,
  'acct-login': (d) => loginFlow(d.id),
  'acct-repair': async (d, el) => {
    if (el) el.disabled = true;
    toast('Checking the sign-in with a real call…');
    try {
      const r = await api('POST', `/api/accounts/${d.id}/repair`);
      if (r.status === 'ok') toast(r.message);
      else modal({ title: 'Repair sign-in', body: `<p>${esc(r.message)}</p>${r.opened === false && r.command ? `<p class="hint">No window could open here. Run this in a terminal:</p><pre>${esc(r.command)}</pre>` : ''}`, actions: [{ label: 'OK', kind: 'primary' }] });
    } finally { if (el) el.disabled = false; }
  },
  'acct-detach': (d) => {
    const a = acctOf(d.id);
    confirmModal(`Give ${a.name} its own login?`, `Ballast gives ${a.name} its own Claude profile, like your other accounts, and opens a terminal to sign it in. Sign in as ${a.email}. After that, whatever you're signed into in the Claude app or CLI never changes who Ballast runs as. Its agents keep their conversations.`, 'Open the sign-in', async () => {
      const r = await api('POST', `/api/accounts/${d.id}/detach`);
      toast(`Sign in as ${r.signIn} in the terminal that opened${r.sessionsCopied ? ` (${r.sessionsCopied} agent conversation${r.sessionsCopied > 1 ? 's' : ''} copied over)` : ''}`);
    });
  },
  'acct-accept': (d) => api('POST', `/api/accounts/${d.id}/accept-identity`),
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
  'task-cancel': (d) => api('PATCH', `/api/tasks/${d.id}`, { status: 'done', cancelled: true }),
  'board-archive': () => archiveModal(),
  'gdd-review': async () => {
    try {
      await api('POST', `/api/games/${S.gameId}/gdd-review`);
      toast('Re-evaluating against the GDD. New tasks land on the board and the feed gets a summary.');
    } catch (err) { fail(err); }
  },
  'archive-reopen': async (d, el) => {
    await api('PATCH', `/api/tasks/${d.id}`, { status: 'open' });
    el.closest('.arch-row')?.remove();
    toast('Back on the board');
  },
  'note-check': async (d) => { await api('POST', `/api/games/${S.gameId}/notes/${d.num}/check`); toast(`Checking note #${d.num} against the blocked tickets`); },
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
  'chip-remove': (d) => { const [f] = S.pending[d.kind].splice(Number(d.i), 1); f?.cancel?.(); renderChips(d.kind); },
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
// Phone layout: the sidebar is a drawer; picking anything in it closes it.
$('#menu-btn').onclick = () => document.body.classList.toggle('side-open');
$('#side-scrim').onclick = () => document.body.classList.remove('side-open');
$('#side').addEventListener('click', (e) => { if (e.target.closest('[data-act="game"], [data-act="studio"], [data-act="inbox"], #open-settings, #new-game')) document.body.classList.remove('side-open'); });

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
      // A brand-new install opens on the setup guide.
      if (!S.booted && !S.st.settings.setupDone && !S.st.accounts.length) { S.view = 'setup'; S.setupStep = 0; }
      S.booted = true;
      if (!game()) {
        S.gameId = S.st.games[0]?.id || null;
        if (S.gameId) store('gameId', S.gameId);
        else if (S.view === 'game') S.view = 'studio';
      }
      // A redraw between a button's press and release replaces the button, so the click is lost:
      // while a pointer is down, live updates wait for its release.
      if (POINTER.down) POINTER.pending = true;
      else renderLive();
      loadUsage();
    } catch (err) { fail(err); } finally { refreshing = null; }
  })();
  return refreshing;
}

const POINTER = { down: false, pending: false };
document.addEventListener('pointerdown', () => { POINTER.down = true; }, true);
const pointerReleased = () => {
  if (!POINTER.down) return;
  POINTER.down = false;
  // After the click this release produces has been handled.
  if (POINTER.pending) { POINTER.pending = false; setTimeout(renderLive, 60); }
};
document.addEventListener('pointerup', pointerReleased, true);
document.addEventListener('pointercancel', pointerReleased, true);
window.addEventListener('blur', pointerReleased);

function handleEvent(ev) {
  if (ev.type === 'state') return refresh();
  if (ev.type === 'loops') return loopsChanged(ev.gameId);
  if (ev.type === 'thread' || ev.type === 'thread-live') {
    const list = $(`#thread-msgs[data-task="${ev.taskId}"]`);
    if (!list) return;
    if (ev.type === 'thread-live') return threadLive(ev.taskId, ev.account, ev.text);
    if (ev.entry.role === 'assistant') $('#thread-live').innerHTML = '';
    if (!list.querySelector('.th-msg, .th-sys')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', threadMsg(ev.entry));
    list.scrollTop = list.scrollHeight;
    if (ev.entry.role === 'assistant' && !ev.entry.error) { const b = $('[data-thread-update]'); if (b) b.disabled = false; }
    return;
  }
  if (ev.type === 'video') {
    const box = $(`.entry.video-entry[data-video="${ev.id}"]`);
    if (!box) return;
    const pill = $('.vid-stage', box);
    const line = $('.vid-progress', box);
    if (ev.stage === 'done') { pill.className = 'pill success vid-stage'; pill.textContent = `🎬 reviewed · ${ev.items} note${ev.items === 1 ? '' : 's'}`; line.textContent = 'Reviewed: the note with the review is below.'; }
    else if (ev.stage === 'error') { pill.className = 'pill error vid-stage'; pill.textContent = '🎬 review failed'; line.textContent = `${ev.error} The note goes out with the video attached.`; }
    else line.textContent = ev.stage;
    return;
  }
  if (ev.type === 'ask') {
    if (ev.gameId === S.gameId && S.tab === 'feed' && !(S.feeds[ev.gameId] || []).some((e) => e.kind === 'answer' && e.askId === ev.askId)) liveAnswer(ev.askId, ev.account, ev.text);
    return;
  }
  if (ev.type === 'feed') {
    S.feeds[ev.gameId]?.push(ev.entry);
    if (ev.entry.kind === 'answer') {
      $(`#live-${ev.entry.askId}`)?.remove();
      if (S.asking[ev.gameId] === ev.entry.askId) { delete S.asking[ev.gameId]; renderAskLine(); }
    }
    // The question often lands before the request that asked it returns, so don't wait on that.
    if (ev.entry.kind === 'ask') {
      S.asking[ev.gameId] = ev.entry.askId;
      if (ev.gameId === S.gameId) setTimeout(() => { if (!$(`#live-${ev.entry.askId}`) && !(S.feeds[ev.gameId] || []).some((e) => e.kind === 'answer' && e.askId === ev.entry.askId)) liveAnswer(ev.entry.askId, ev.entry.to || 'Claude', ''); }, 0);
    }
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
