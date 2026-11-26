# Ballast

Home base for **author developers**: solo developers making games entirely with AI. Ballast leashes several Claude Code accounts into one game-dev team, and keeps every game you're making, its output, its costs and its audience in one place.

Each Claude account you add becomes an **agent**. Point a **game** at a repo, send it notes (gameplay review, art notes, direction) and every agent working in that repo picks them up. One agent splits each note into tasks on a shared **board**, the agents claim tasks and work them in parallel (each can also spin up its own subagents), and Ballast keeps them going until the board is empty. Run as many games side by side as you like.

No dependencies: Node's standard library and the `claude` CLI you already have.

## Run it

Requirements: Node 20+, git, and Claude Code (`claude --version`).

```bash
node src/server.mjs
```

Or double-click `start-ballast.cmd`. It opens <http://127.0.0.1:4477>. Use a different port with `node src/server.mjs 4500`, or skip opening the browser with `--no-open`.

### Windows installer

Download `BallastSetup.exe` and run it. It installs Ballast for your Windows account only (no admin needed) into `%LOCALAPPDATA%\Programs\Ballast` and adds **Ballast** to the Start menu and desktop.

- It checks for Node.js 20+, Claude Code and git, and offers to install any that are missing (Node and git with `winget`, Claude Code with its official installer). Each one asks first.
- **Ballast** starts it in the background (no console window) and opens your browser. If it's already running, it just opens the browser. **Stop Ballast** closes it.
- Running a newer `BallastSetup.exe` updates Ballast in place. Your data in `~/.ballast` is never touched.
- **Uninstall Ballast** (Start menu, or Settings > Apps) removes the app and shortcuts and keeps your data unless you choose to delete it too.
- The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.

Build it yourself with `powershell -ExecutionPolicy Bypass -File installer\build.ps1`. It uses Windows' built-in IExpress and writes `installer\dist\BallastSetup.exe`. `installer\test-install.ps1 -TestPort 4491` checks it end to end against temp folders and a throwaway registry key.

## Setup in four steps

A fresh install opens on the **setup guide**, which walks through all of this: it checks this PC (Node, Claude Code, git, the GitHub CLI, Whisper) and shows the command for anything missing, then asks your name and working hours, your Claude accounts and what each plan costs, how you want to review each kind of work, whether new games start with the usage starter rules, phone access, and your first game. Open it again any time from Settings.

1. **Add accounts** (sidebar, `+`). Tick *Use the Claude login already on this computer* for your normal login. Every other account gets its own Claude profile in `~/.ballast/accounts/<name>`. Ballast opens a terminal running `claude auth login` for it and notices on its own when you're done.
2. **Create a game** and choose where its agents run:
   - **This PC:** give it a folder. An existing git repo works, and so does a new or empty folder (Ballast runs `git init` for you).
   - **Claude cloud, on a GitHub repo:** give it `owner/name`. See [Cloud games](#cloud-games).

   Tick which accounts should work on it. If the repo already has work in it, the lead agent surveys it first.
3. **Write a game brief** (Settings tab). Every agent reads it.
4. **Send a note** from the Feed.

## How a note becomes work

```
you ──note──▶ lead agent triages it into board tasks (no coding)
                      │
                      ▼
        every agent on the game gets the note + task numbers
                      │
        each one: board_claim → work → land on integration → board_done
                      │
        autopilot: an idle agent with open tasks left gets "claim the next one"
```

- **All agents vs one agent.** The composer sends to *All agents* by default (the triage flow above). Pick *Only <name>* to talk to a single agent directly; the Agents tab shows each agent's full transcript and has its own composer.
- **What becomes work.** Everything about the game's project does: the game itself, everything in its repo that keeps it working (failing tests, CI, builds, merges, performance, repo tools and docs), and your instructions to the team ("keep pushing features and QA", "set up the coordinator file"). A broad request ("make a big polish list and fix things") is broken into concrete tickets. Only feedback about Ballast itself or its tools (the review tool, Ballast's screens, account setup) is left out. Triage opens the note's attachments, and when it can't open one it adds a ticket to investigate it.
- **A note that makes no tasks is never dropped quietly.** If tickets already cover it, the feed names them ("already covered by #384"). Otherwise the note lands in your Inbox with triage's reason, and **Add as a task anyway** puts it on the board as written (**Leave it off the board** closes it).
- **Board.** Agents use Ballast's MCP tools (`board_list`, `board_add`, `board_claim`, `board_done`, `board_block`, `post_update`, `publish_artifact`, `read_notes`). Agents can add tasks for each other. When they do, idle agents get woken to pick them up. You can add, edit, reopen and delete tasks too.
- **Autopilot** (header switch) keeps idle agents claiming open tasks. It's capped at a daily number of automatic turns per game (global Settings). **Wake idle** hands out open tasks immediately.
- **Stop** kills an agent's turn, puts its task back on the board, and pauses it: autopilot leaves it alone until you message it or press Wake.
- **Usage limits.** When an account runs out of usage, its claimed tasks go back on the board for the other accounts. Its agents resume when the limit resets. The sidebar shows each account's 5-hour and 7-day usage.
- **Stuck turns.** If an agent ends a turn still holding a task, it gets one nudge. If it ends the next turn still holding it, the task is marked blocked so you see it.

## Delegate chats: fanning work out

An agent on this PC can open **delegate chats** with `open_delegate`. A delegate chat is a new, fully capable Claude chat: its own session, every tool, the board, and its own branch starting from the parent's work. It works on part of the parent's job at the same time as the parent. Delegates can open their own delegates, so the work spreads out like a web.

- **Brief and handover.** The parent writes a self-contained brief and can hand over board tasks (`task_ids`). The delegate opens on whichever logged-in account has the most room right now.
- **Reporting back.** The delegate finishes with `delegate_done` and a summary. The parent gets a message to merge the delegate's branch and land it, and handed-over tasks return to the parent. If a delegate ends without reporting, it gets one nudge, and then its last message is sent back as the report. A delegate whose parent has closed reports to the nearest open chat above it.
- **Managing.** The parent uses `list_delegates` and `message_delegate`. In the Agents tab, delegates are nested under their parent with their brief, status and report. The Studio header counts open delegate chats.
- **Limits (Settings).** *Delegate chats per agent* (default 3, open at once) and *delegate depth* (default 2 levels). Games can override the per-agent limit. Account limits still apply, so delegates queue rather than overload an account.

**Subagents** are different: short-lived helpers inside a single chat (Claude Code's Task/Agent tool). Ballast tracks them per agent and enforces *subagents per agent* (default 4 at once) with a hook that asks Ballast before each one starts.

**Cloud games:** cloud agents can't call Ballast, and Claude only creates cloud sessions from a terminal, so they can't open delegate chats. To fan a cloud game out, add more agents per account and connect them all with **Connect cloud sessions**.

## Git: worktrees vs shared tree

**Worktrees (default for git repos).** Each agent gets its own worktree at `<repo>.ballast/<agent>` on branch `ballast/<agent>`. Finished work is rebased and fast-forwarded onto `ballast/integration` (`git push . HEAD:ballast/integration`), which nothing has checked out. Agents never step on each other's files. Bring the team's work into your branch whenever you like:

```bash
git merge ballast/integration
```

Unity note: each worktree imports its own `Library` the first time it opens, which is slow once and then fine.

**Shared tree.** All agents edit the repo folder directly. Agents are told to stage only their own files and to never stash, reset or clean. It's simpler, but agents can collide.

## Studio: all games and accounts at once

The **Studio** page (top of the sidebar) is the author developer's home: every game, what it's producing, what it costs, and who it's for.

- **Your output.** Tasks finished this week (against the week before), a 14-day chart with your streak of days with finished work, builds and captures this week, how many games are in development, shipped and archived, and weekly headroom across accounts.
- **Costs.** What your plans cost a month (set each account's price with ✎ on the account; until then Ballast guesses from the plan: Pro $20, Max $100, Team $30), **cost per finished task** over the last 30 days, and the **API value** of Ballast's own runs: what they'd have cost on the API. Cloud sessions aren't metered, so cloud games show no API value.
- **Games.** A card per live game plus a table of every game: status, age (or time to ship), tasks done this week and in total, open tasks, last activity, its **share of your output** over 30 days, its **share of your plan cost** (plans split by share of finished tasks, which is fair to cloud games too), API value, and its top audience from the latest Bartle Audit.
- **Ship, archive, restore.** **Ship** records a release (version, platforms, store page, notes) and marks the game shipped: autopilot and check-in builds stop, but your notes still reach the agents for patches. **+ Release** records each update after that, and **Back to development** turns autopilot on again. **Archive** clears queued work and stops everything; archived games fold away at the bottom of the sidebar, keep their board, feed and stats, and come back with **Restore**.
- **Audiences: Bartle Audit.** Tick the games to audit. Claude reads each one (repo, brief, board) and ranks Bartle's eight player subtypes by how well the game serves them: Planner and Opportunist (Achievers), Scientist and Hacker (Explorers), Networker and Friend (Socialisers), Politician and Griefer (Killers). For the top four you get the evidence in the game, what they'd want more of, a pitch, where to find them, content that lands, and what to say and avoid. Plus a positioning line, a store page draft, comparable games, a launch plan and audience risks. **Copy as Markdown** takes it anywhere. Opus by default, or Sonnet to go lighter on usage. It takes a few minutes per game and runs on the account with the most headroom.

- **Accounts and limits.** Each account shows its **Session** (5-hour) and **Weekly** (7-day) limit, plus any per-model weekly limit, as a percentage with time to reset. The numbers come from Claude's own rate-limit reports, which arrive with every run. Idle accounts get a one-word probe on a small model every 30 minutes (about a fifth of a cent) so the numbers stay current. **Refresh** checks one now.
- **Token usage.** Tokens and cost per account, per game and per day, for every run Ballast makes: agent turns, triage, artifact syncs, limit probes. Usage outside Ballast (claude.ai chats, your own terminal sessions) counts toward the limits above but not toward these totals. So do cloud sessions: their tokens aren't reported back.
- **Usage reports.** During your **working hours** (Settings: default 09:00 to 18:00, Monday to Friday), every account reports its session and weekly limit, time to reset and today's tokens **every 90 minutes**. Stale numbers are refreshed first. Reports show on the Studio page with their history, **Report now** runs one immediately, and an optional Slack or Discord webhook gets each one. Background limit checks only run during working hours.
- **Limit-aware routing.** Work goes to the agents whose accounts have the most headroom. Autopilot stops handing work to an account above 95% of either limit (configurable). Your own messages still go through.
- **Game cards.** Every game's agents, board counts, last build and next check-in. You can **Pause** a game, which frees its accounts for other games, and set its **priority**, which decides who gets account time first when accounts are busy.
- **Note to several games.** One note, triaged separately onto each ticked game's board.

### Daily digest and weekly report

- **Daily digest**, at the start of your working day (or **Digest now**): per game, what finished since the last one, what's blocked and why, what's waiting for you (reviews, Inbox questions), builds, and each account's session and weekly usage. No Claude run; it's just your numbers.
- **Weekly report**, every Friday at 16:00 by default (Settings) or **Write this week's report**: for each game with finished work, Claude writes a devlog for players, 3-5 social posts for named channels, clips worth capturing, and what's coming next. Posts are aimed at the audiences and channels from the game's Bartle Audit. Copy one post or the whole report.
- Both appear on the Studio page and go to the report webhook if you set one. A Discord channel webhook is the easy way to get them as phone notifications.

### Daily update in each game's Feed

Once a day, at the time set in Settings → **Daily update and time away** (your working day's end by default), each game's Feed gets an update written for you in plain words:

- **In one line**: the day's biggest change for players.
- **What changed for players**: what a player notices now, grouped by experience (moving around, the match, the look, the sound), and how it plays or feels differently.
- **Worth checking**: what to try next time you play, where to look, and what good looks like, leading with work waiting for your review.
- **Still in progress**, and **Needs you**: only what really waits on you.

It's written from the agents' own reports, and says so when something was only checked in simulation or is still a placeholder. A day with nothing done is one line, with no Claude run. **Write today's updates now** (in Settings) writes them on demand.

### Time away (sick or on vacation)

Settings → **Time away**: Off sick, On vacation or Away, with the first and last day, and an optional note for the team. While you're away:

- Agents don't pick up work that needs you: tickets in a department you approve first, and tickets that ask for your playtest, decision, approval or sign-off. That work stays on the board for your return.
- Every hand-off tells agents you're away until that day: do work you can finish and verify yourself, never start anything that needs a decision or a new creative direction, keep asking questions without waiting.
- When what agents can do without you runs low (fewer open tickets than agents), Ballast adds up to 8 review-free improvement tickets for that game, at most every 6 hours. Examples: evaluating the latest Jungle Engine release on a branch, asset quality within the current style (budgets, import settings, broken references), QA and regression checks, bot-driven and simulated-headset sessions, performance captures, robustness.
- The game header shows the away state, each Feed notes when it starts, and daily updates keep coming. The first update after you're back covers the whole time away.

### Playtesters on Discord

Players' feedback in your Discord becomes notes for the game's team. Settings → **Discord**: create a bot in the Discord Developer Portal, turn on its *Message Content Intent*, paste its token (stored on this PC only), and add it to your server with the link Ballast gives you. Then in each game's Settings → **Playtesters**, pick its channels. Ballast reads them every minute and reacts ✅ to each message it picks up. It gathers new messages for 15 minutes (or 25 messages) and sends them as one note labelled as playtester feedback, so agents weigh issues several players raise over one-off opinions. It starts from the newest message, so old chatter isn't fed in. Nothing is hosted: Ballast polls Discord from this PC.

### Ballast on your phone

Settings → **Phone** (or the setup guide). Ballast keeps running on this PC and your phone opens it, with no server and no cloud bill:

- **On my home Wi-Fi**: Ballast also listens on this PC's home-network address (port 4479).
- **Anywhere, through Tailscale**: install [Tailscale](https://tailscale.com/download) (free) on the PC and phone. Ballast listens on its private address, encrypted end to end.
- Open the address it shows on your phone and type the 6-digit **pairing code** (good for one phone, 15 minutes, 5 tries). Each paired phone gets its own key you can remove. Agent endpoints never leave this PC. Windows may ask once whether Node.js can use private networks; allow it.
- The layout fits a phone (the sidebar becomes a ☰ drawer), and *Add to Home Screen* installs it like an app.

### Per-game usage cap and rules

Your games share the same few accounts, so each game decides how far into them it may go (game **Settings → Usage limits & rules**):

- **Stop at** caps the game at a percentage of an account's session or weekly limit. Past it, the game's agents on that account stop taking work and show **held by usage rules**. Messages you send to one agent still go through. Work picks up again when the limit resets.
- **Rules** change how agents work as an account fills up: *when session / weekly / either is over N%*, or *when weekly (or session) use is more than N points ahead of pace*, then one of: claim one task at a time, no delegate chats or subagents, switch to Sonnet or Haiku, lower effort, finish claimed tasks and claim nothing new, tell the agents something in your own words, tell me (feed and report webhook), or stop. **Add a prefilled rule** offers ready-made ones, and **Add the starter set** adds six that pace an account across its week (one task at a time over 60% session, a "keep it small" instruction 10 points ahead of weekly pace, Sonnet 20 ahead, no fan-out over 80% session, no new claims 30 ahead, tell me over 90%). Pace compares use with how much of the window has gone by: 60% used with two days left is fine, 60% on day two is not. The starter set never holds an account back for being high late in its week, since what's left then resets unused. New games start with it when **Start new games with the usage starter rules** is on (setup guide).
- Rules are checked before every turn against that agent's own account; the feed notes each time the set in force changes. Model and effort rules apply to agents on this PC (cloud sessions choose their own model); the rest apply to cloud agents too.
- **Reset-aware scheduling.** Weekly limits reset at different times per account, and budget left at a reset is lost. Autopilot hands work to the account with the most weekly budget to spend per remaining hour first (then the lowest session use), and an account whose weekly limit resets within a day with 20% or more left takes one extra ticket per claim.
- **Models by ticket type** (Settings): tickets tagged, say, `[docs]`, `[backend]` or `[qa]` go to agents set to Sonnet (Agents → Edit → Model). They wait for such an agent while one can take work, and go to anyone otherwise, so nothing stalls. A cloud agent's model is set in its claude.ai session; set the same one in Ballast so routing matches. Local agents run with their model.
- **Check before hand-in** (Settings): a command such as `npm run check` that agents run before they push or hand work in, handing in only when it passes. Failures already on the base branch are named in the report instead of fixed. New Jungle Engine games get `npm run check`.

## Department tabs and review

Every game has a **Gameplay**, **Art**, **Audio** and **Backend** tab. Tasks are filed by their tag: `[ui]` and `[qa]` count as Gameplay, and `[tech]`, `[build]` and `[docs]` count as Backend. Each tab shows:
- work waiting for your review
- open questions
- what's in progress and up next
- a gallery of captures: screenshots, GIFs, video and audio clips agents attached
- that department's claude.ai artifacts

**Review never holds the team up.** For each department you choose how involved you are. Set the studio default in Settings, or override it per game in the tab:

| Mode | What agents do | What you see |
|---|---|---|
| **Not my field** | merge and keep going | nothing queued; finished work listed for reference |
| **Review after** (default) | merge and keep going | finished work queues for you; *Request changes* creates a follow-up task for the same agent |
| **Approve first** | leave the change unmerged and **move straight on to other work** | *Approve & merge* lands it; anything left unreviewed is auto-approved after 24h (configurable) |

Backend defaults to *Not my field*. *Approve first* needs per-agent worktrees or a cloud game. With a shared working tree it acts like *Review after*.

**Captures.** Local agents publish captures with `publish_artifact`. Cloud agents commit them to `.ballast/media/t<task>/` on their branch, and Ballast pulls them in when the task reports.

## Quality targets

Each department tab has a **Quality targets** section for reference images (or clips) that set the bar: concept art, a screenshot from a game you admire, a lighting look, a texture with the right wear. Drop files on it or use **Add targets**. Give each a title, the **subjects** it covers (e.g. `barrels, crates, dock props`) and **what to match** (e.g. "this level of grime, warm lantern light").

- **On every task:** an agent claiming a task in that department gets the matching targets with it, matched on shared words between the subjects and the task. With no match, it gets the department's whole set. Local agents open the files directly and can look them up with `reference_targets`.
- **Cloud games:** Ballast pushes the targets and an index to a separate `ballast/targets` branch of the game's GitHub repo (never `main`), and cloud agents read them from there.
- **Agents' captures:** agents are told to meet the bar without copying, frame their captures like the closest target, and say how close they got.
- **In review:** review cards show the matching **target** next to the agent's **result**.

**Tagging assets.** In the target dialog, pick a **category** (Characters, Level design, Props, Vehicles, UI, VFX, Animation, Audio, Materials & textures), then search the game's assets and tick the ones the target applies to. Agents get the asset names and their defining files with the target, and tasks that mention a tagged asset get that target.

The asset list comes from two places:
- **Asset files** found by scanning the repo (models, textures, prefabs, scenes, audio). This is instant.
- **An asset catalog** Claude builds by reading the game: what's in it, named the way a player would name it, with the files that define it. This is what makes code-built games searchable. It's built the first time you search, and again whenever you press **Scan the game**.

## Department notes

Each department tab has a **Leave a note** box for feedback aimed at the whole department, like "everything looks too clean" in Art. A note goes through four stages:

1. **NEW:** the note waits for an agent in that department.
2. **Picked up:** the next agent that claims a task in that department gets the note. A local agent breaks it into board tasks with `task_dept_note` before starting its own work. A cloud agent lists the tasks in its report, and Ballast adds them to the board.
3. **TASKED:** the note links to each task it produced, showing each task's live status.
4. **ARCHIVED:** once every one of those tasks is done, the note moves to the department's archive.

Notes never stall. If nobody picks a note up within 15 minutes (*Settings*), or whoever picked it up doesn't break it down, Ballast breaks it down itself. **Break down now** does that immediately.

## Task priority

Every task is **Urgent**, **High**, **Normal** (the default) or **Low**. On the Board, **▲ / ▼** on a card promotes or demotes it one step (or set it in Edit), and each column lists the highest priority first.

Priority decides what gets picked up next. Cloud agents are handed tasks by Ballast, highest priority first, ahead of role fit; tasks assigned to an agent still come first for that agent. Agents on this PC see the board sorted by priority with URGENT, high and low tags, and are told to take urgent work first and low only when nothing else fits. Promoting a task to Urgent wakes idle agents straight away.

## Playtest videos

Attach a playtest recording in the Feed like a screenshot (**📎**, drag and drop, or paste). Any size works: it streams to disk with a progress bar, and plays in the feed with seeking.

When you send a note with a video, Ballast reviews it before the team gets it. The video shows in the feed right away with the review's progress. Ballast:

1. pulls up to 40 frames from across the video (ffmpeg);
2. transcribes what you said while playing, with timestamps (local Whisper, if it's set up);
3. has Claude look at every frame against your commentary and your note, on the account with the most weekly room.

Your note then goes out with a short summary and timestamped review notes, each tagged with its department (`[1:42] [art] Timer hard to read against the fog: ...`), what Whisper heard you say, and the key frames attached. What you said carries the most weight; Claude adds what it can clearly see, and doesn't invent problems. Cloud agents get the text; agents on this PC can open the frames too.

Over music and game sound, speech recognition makes up words with full confidence, so the transcript is only used when it's clearly you talking. If the lines mostly repeat (a sure sign it's hearing game audio), or Claude judges them garbled or off-topic, the transcript is left out and the note says the commentary didn't come through. For the best commentary, record with your mic on and the game volume down. With the Silero voice-activity model installed (`~/.ballast/whisper/vad/ggml-silero-v6.2.0.bin`, about 1 MB, from huggingface.co/ggml-org/whisper-vad), video commentary goes through whisper-cli with voice detection, so only stretches where someone is actually talking are transcribed and game audio can't turn into made-up words.

### Attachments for cloud games

Cloud agents run on GitHub and can't open files on this PC, so for cloud games Ballast puts **text attachments inside the note**: profiler JSON, logs, CSV, Markdown, configs and code (up to 48 KB per file and 120 KB per note; bigger files are trimmed with a marker). The note splitter and the agents read them like the rest of your note. Videos are reviewed into text (above). Images and other files stay with the note in Ballast, and the feed says which ones.

Needs ffmpeg (`winget install ffmpeg`). Without Whisper, only the frames are reviewed.

## Performance tab

Every profiler run you attach to a note becomes a run on the game's **Performance** tab. You can also use **Add a profiler run** there to add one without sending it to the team. Ballast reads any JSON with a `budgets` list (`{ name, value, limit, unit, pass }`). If the run also has `samples` over time, those get their own charts. A profiler can name its sample columns with `sampleFields`. Without that, Ballast assumes Look Normal's layout: time, fps, crowd sim ms, crowd draw ms, draw calls, townsfolk drawn, CPU ms, GPU ms, render scale. A value of -1 means the profiler didn't measure it.

- **How we're trending**: one chart per budget, with a dot for each test run and the budget as a dashed line. Each chart shows the latest value and its change since the run before. Whatever is over budget in the latest run comes first. A change only reads as better or worse when a budget is at stake. If a measure is within budget both times, it's shown as a plain change.
- **Compare two runs**: every measure side by side, with the change, the budget and the result. It also lists the tickets that landed between the two runs, so you can see what moved the numbers.
- **One run over time**: frame rate, CPU and GPU frame time, draw calls, townsfolk drawn, render scale and crowd cost across the round. Hover anywhere to see that moment on every chart at once.
- **All runs**: label a run (for example "after #344"), or untick it to leave it out of the charts, such as a broken run that flatters the numbers. A run attached twice counts once.

## Spend per project

Studio → **Spend per project** totals every project's token use, all time and for the last 30 days: input, output and cache tokens, the API-equivalent cost, and the biggest uses (conversation mode, blocked-ticket triage, audits…). Archived games stay listed, and housekeeping (artifact syncs, limit checks) has its own row. Tokens are exact for every Claude run Ballast makes itself. Cloud agent sessions don't report tokens, so their work is shown as an estimate from account limit readings, in account-weeks (one account's full weekly limit). Each game's Budget tab ends with the same figures for that game, broken down by kind of run.

## Budget tab

What development costs in account limits, per game. Cloud sessions don't report tokens to Ballast, so costs are estimates from the accounts' own limit readings: every rise in an account's weekly use is split across the tickets it had in hand at the time, by how long each was held. Rises with no ticket in hand count as off-ticket (Ballast's own runs, or the account used by hand). Figures are percent of one account's week. Ballast logs every limit reading to `limits.jsonl` for this; turning on the idle-account probe (**limitRefreshMin**) makes the estimates finer.

- **Pace**: each account's weekly use against the share of the week gone (the tick on the bar), when it resets, how much would go unused at the current rate, which account gets work first, hours it sat idle behind pace while tickets waited, and its off-ticket use.
- **Spend**: the period's total, the last 7 days, tickets done, cost per ticket, and spend against tickets done per day.
- **Cost by discipline**: spend and cost per ticket by the ticket's `[tag]`, plus the most expensive tickets.
- **Work redone or dropped**: tickets sent back in review, reopened by playtest feedback, that went blocked, or cancelled, with their cost; failed builds when the game has a build schedule.
- **Time lost waiting**: open Human Interventions and how long they take, reviews waiting on you, blocked tickets, and account-hours idle behind pace.
- **Results against spend**: each Performance-tab profiler run against the one before, with the budget spent between them, tickets landed, budgets met and measures that got better or worse.

## Accounts and the Claude app

Ballast doesn't depend on which account you're signed into in the Claude app or CLI. Each account is locked to the email it was first signed in as: if its login ever turns out to be someone else, it's paused with a warning (its agents wait) rather than running on the wrong account's usage.

**Repair sign-in.** A claude.ai sign-in can lapse while the CLI still reports the account as logged in ("OAuth session expired and could not be refreshed"). The first run or cloud message that fails that way marks the account signed out: its agents are paused instead of retrying every second, and each of its games says so once. **Repair sign-in** appears on the account (sidebar and Studio) and in the header of every game it works on. Pressing it first tests the sign-in with a real call; if that fails, it opens a terminal signed in as that account to log in again, then tests every few seconds and puts its agents back to work once a real call succeeds. An account that was signed in before and now isn't gets Repair too.

The one account that can be affected is one added with *Use the Claude login already on this computer*: it shares the login with the Claude app and CLI, so switching accounts there changes it. Its card says so and offers **Give it its own login**: Ballast moves it to its own profile (keeping its agents' conversations) and opens a terminal to sign it in once. After that, switch accounts in the app as much as you like. If a switch was on purpose, **Use … from now on** accepts the new account instead.

## Blocked tickets triage themselves

When a ticket blocks (an agent gives it back, a cloud session reports BLOCKED or goes quiet), Claude triages it within a minute on the account with the most weekly room. It reads the ticket and the code it touches, and decides:

- **Retry**: an agent can still do it another way (a workaround, a simulation, a smaller version). The ticket is rewritten with that approach and goes back on the board. A ticket can retry itself twice; after that it has to go to a person.
- **Split**: part of it can go ahead now. This ticket becomes that part and goes back on the board; the rest becomes its own ticket waiting on a person.
- **Human**: only a person can unblock it: a device, an account or sign-in, a service or environment setting, a payment, your voice, or your call. It gets a **🙋 NEEDS YOU** tag and a Human Intervention request at the top of the Director's Inbox, with:
  - exactly what to do, as numbered steps with real names, URLs and values, how long it takes, and how you'll know it worked;
  - who can do it: only you, or **you or a Cowork Claude**. For the second, it lists exactly what the Cowork Claude needs your authorization to do (which site, which account, which setting, read or write), and **Copy the Cowork brief** gives you a paste-ready brief for it;
  - which tickets it's holding. One request can hold several tickets (one network allowlist, one headset); triage attaches new blocks to an open request when they need the same thing.
- **Obsolete**: it looks like it's no longer needed. You're asked to confirm closing it.

Press **Done** when you (or the Cowork Claude) have done it, with an optional note for the agent: every ticket waiting on it goes back on the board with your note. **Dismiss** leaves them blocked and stops asking. Open requests count toward the Inbox badge and appear in the daily digest. Blocked tickets also have a **Triage** button to run it again, and you can turn self-triage off in Settings.

### Feedback closes the loop

Every note to the whole team that comes from you, a Director Review, a reviewed playtest video or Discord playtesters is checked against the board's blocked tickets, since most of them wait on exactly that: a headset run, profiler numbers, your call. Claude reads the note (with its text attachments and key frames) and gives each blocked ticket one of three results:

- **Done**: the note shows the ticket's own goal is met, for example profiler numbers that meet its target.
- **Back on the board**: the note shows it isn't there yet, or gives it what it was waiting for. The ticket gets the evidence and what to do next.
- **Still waiting**: the note doesn't cover it.

The result is posted in the feed and shown on each card. A Human Intervention request closes, marked "answered by note #N", once all its tickets have moved on. To run the check again on a note you've already sent, press **Check blocked tickets** under that note in the feed.

### Board archive

The Done column shows the latest 50 tickets. Older done tickets and every cancelled one move to **Archive** in the Done column header, where you can search them and reopen any of them. **Cancel** on a card closes a ticket without doing it. Agents can still find archived tickets when they search the board.

### Re-evaluate against the GDD

**Re-evaluate against the GDD & update tasks** (top of the Board tab) keeps the board in step with the design:

1. It pulls the latest GDD: the game's GDD pages on claude.ai (role GDD, or a title with "GDD" or "Game Design Document") are re-read now, and a cloud game's clone is synced to its base branch. GDD and design files in the game's folder count too.
2. It compares the GDD with the copy from the last run, paragraph by paragraph, so the run knows what changed.
3. One Claude run (Sonnet by default; Opus or Haiku from the bar) reads the GDD, the code and the board, and adds up to 12 tasks for what the GDD asks for that is neither built nor already ticketed, changes first, with a priority. Tickets the GDD no longer asks for are listed in the feed, not cancelled. Roadmap tasks still to come aren't duplicated.

**Run it** schedules it: every hour, every 6 hours, every day at a time, or every week on a day and time. Scheduled runs skip the model when the GDD hasn't changed since the last run (untick to always run). Once a game uses the re-evaluation, a change to its GDD page on claude.ai starts a run instead of becoming a note for triage, so the change is ticketed once; comments on the page still arrive as notes.

## Talking a ticket through

Any ticket on the Board can carry its own conversation with Claude. Blocked tickets get a **Work it out with Claude** button (it starts you off with the agent's reason for blocking); every other ticket has **💬 Discuss**, and the button shows how many messages a ticket's conversation has.

- Each message is answered by the account with the most weekly room. It sees the ticket (detail, block reason, what the agent reported), the game's brief, board and roadmap, and reads the repo before suggesting anything. It lays out the options with their tradeoffs, recommends one, and asks you only about things that are your call. It changes nothing.
- When you've decided, press **Update the ticket**. Claude drafts the rewritten ticket from the conversation: a new title and a self-contained detail with the approach you agreed on, a priority, and what happens next: back on the board for an agent, keep it as it is, or close it as no longer needed. If you didn't reach a decision, the draft says so.
- Edit anything and **Apply**. The ticket is updated, the decision is noted on it and in the feed, and a blocked ticket going back on the board is unblocked. If an agent is working on it right now, Ballast can tell that agent straight away, since it won't reread the ticket mid-task.
- The conversation stays with the ticket, so you can come back to it.

## Asking Claude (conversation mode)

Sometimes you just need an answer. Press **💬 Ask Claude** in a game's Feed composer to switch it to conversation mode: what you type goes to Claude as a question instead of to the agents as a note.

- Each question goes to the logged-in account with the most **weekly** room right now (the session limit breaks ties). The composer shows which one, and how much of its week is left.
- It reads the game's files and can search the web, but changes nothing. It also knows the game's brief, board, roadmap progress and your latest notes, so you can ask "why does the mob trigger here?" or "what's left for the first playable?".
- Follow-ups work: your recent questions and answers go along with each new one, whichever account answers. **New conversation** starts fresh.
- Answers stream into the feed. Agents never see them. **Send to team** turns one into a note for every agent, which you can edit first. Screenshots you paste go along with the question.
- Toggle it off to go back to sending notes. Ballast remembers the mode.
- **It can troubleshoot Ballast itself.** Ask "why is nobody claiming #12?", "is anything stuck?" or "why did the GDD run fail?". Every question comes with a fresh read-only diagnostics snapshot of the game, under `~/.ballast/tmp/diagnostics-<game>`:
  - every agent's live state: running, queued and what it waits for, held tickets, its account's load, usage rules in force;
  - accounts' sign-in, limits and pace; the board with claim ages and block reasons;
  - feed entries reporting problems, and Ballast's own logs;
  - schedules: autopilot, builds, GDD re-evaluation, level audit;
  - Ballast's latest Claude runs with their cache counts, and agents' latest transcript lines.

  Troubleshooting questions also run live checks: GitHub lookup, the remote reachable, the clone's state, worktrees, and the Claude and GitHub CLIs. Claude can read Ballast's own source too, so an answer names the cause, the evidence (the snapshot line and the source function) and the fix: what to click, or the change Ballast needs. Tokens, keys, cookies and webhook URLs are never written into the snapshot.

## Director Review (voice)

Press **Director Review** in a game's Feed, play, and talk:
- **While you play:** the browser transcribes as you speak (Chrome or Edge; allow the microphone once). Lines are timestamped, and speech within 10 seconds of the last line joins it. Say **"mark that"**, or press **★ Mark moment**, to flag a spot. You can paste screenshots into the box below at any time. Words caught mid-sentence when the browser restarts recognition are kept. The recording keeps going if you switch tabs, and an unsent review survives a page reload.
- **Whisper (on this PC):** when local Whisper is installed, it writes the transcript instead of the browser. Ballast records the mic, cuts it into phrases at pauses and has [whisper.cpp](https://github.com/ggml-org/whisper.cpp) transcribe each one on your GPU. Each phrase is primed with the game's name, recent board task titles and the line before, so names come out right. Lines land a moment after you finish a phrase; the grey words while you talk are Chrome's live preview. Audio never leaves the PC. Ballast starts `whisper-server` (port 4478) when a review starts and stops it after 15 idle minutes to free GPU memory. Switch to **Chrome** in the engine picker under the transcript if you need to.
  Install: put a whisper.cpp Windows build in `~/.ballast/whisper/bin/` (the `cuda-12.4.0` one for NVIDIA GPUs; the CUDA 11.8 build lacks cuBLAS and falls back to the CPU) and one `ggml-*.bin` model in `~/.ballast/whisper/models/` (`ggml-large-v3-turbo-q8_0.bin` is the default). The server log is `~/.ballast/whisper/server.log`.
- **Fixing it as you go:** click any line to correct a word (Enter or clicking away keeps it; corrected lines show in amber). Press **✕** on a line to leave it out of what gets sent, and **↺** to put it back. Type into the box under the transcript to write a line in at the current time. New speech never merges into a line you've corrected, typed or left out. Set the **accent** picker beside that box to yours (e.g. English (UK) or English (Canada)); the browser's recognizer is noticeably more accurate when it matches.
- **When you're done:** press **Tidy up with Claude** to fix misheard words using the game's own vocabulary and drop filler, keeping timestamps, markers and your meaning. You can undo it. Then **Send to all agents**. It goes out as a Director Review note. Only feedback about the game becomes tasks; remarks about Ballast or testing a feature are ignored.
- **Coordination:** the agent with the **most usage headroom** coordinates it. It reads through the rambling and recognition errors, merges repeated points, and splits the feedback into department-tagged tasks. If the game has a **Coordinator file** (Settings, e.g. `games/looknormal/coordinator.md`), the feedback and breakdown are recorded there first.
- **Claiming:** every agent then claims its next tasks, **2 at a time** by default (*Tasks per claim* in Settings). It works through them in order, and each task closes as soon as it's done.

## Director's Inbox

One place (sidebar) for every question from every agent, on every game and account, in **one column per project** (plus a Studio column for questions that belong to no game). Each column shows what needs you first (human interventions), then the questions, oldest first. An agent asks with `ask_director`, or adds a `## Questions` section to a cloud report. It writes down the assumption it's going with and keeps working. **It never waits.** Your answer goes back to that agent as a message, and it adjusts if your answer differs. *Assumption is fine* closes a question without a reply.

**One answer settles its duplicates.** Questions pile up, and agents often ask the same decision again in other words. After you answer, a quick Sonnet run reads the game's other open questions and closes the ones your answer decides: the same decision asked again, an older or narrower version, or a case it plainly covers. Each closed question's agent gets your decision worded for its own question. Questions on the same topic that need a different decision stay open, and so does anything it's unsure about. Your answered card lists what else it closed, and the feed says so too. A closed card says which answer settled it and has **Reopen**, which reopens the question and tells its agent to disregard that answer.

Cloud reports' questions are read whether the agent writes `### question` blocks or bold labels (`**Decision:**`, `**Context:**`, `**Options:**`…); a question is never split into one card per line.

## GDD and delivery schedule

- **GDD.** Track the game design document on claude.ai with the **GDD** role. Every agent treats it as the source of truth. When it changes, the change becomes a note for the team, and triage adds a task to update the GDD when a note changes the design.
- **Delivery.** Set check-ins (e.g. `07:00, 12:00, 17:00`). Every task hand-off tells the agent when the next build is cut. Close to a build, agents land only finished work. The feed gets a heads-up 45 minutes before each one.

## Working within Jungle Engine

Ballast is a companion to [Jungle Engine](https://thecompanylive.github.io/jungle-engine/), so it keeps up with the engine's docs and works within them.

- **Daily copy.** Once a day (and on start, if the last sync is older than that) Ballast reads the site's page hashes and fetches only the guide pages that changed: the API guide, the Game Pack guide, getting started, release, playtest and the changelog, about 155 pages. It keeps them as plain text in `~/.ballast/jungle-docs/`, with an `INDEX.md`. The ~3,000 generated API reference pages are read on the site when needed. **Sync now** is in Settings → Jungle Engine, with the last sync and the latest engine release.
- **What changed.** When pages change, Claude summarizes the changes (new releases from the changelog, new or changed rules, renamed or removed APIs, deprecations, better recommended patterns) and marks which ones a game may need to act on. The summary goes to every Jungle game's Feed, and the last 30 are kept in `CHANGES.md`.
- **Games checked against it.** For changes that may need action, Ballast checks each Jungle game's code and setup and adds up to 5 tickets where that game is actually affected, naming the docs page. It also says which changes don't apply.
- **Catching up from an older engine.** A game whose code was written against an older engine can be checked against every release since, from the changelog (all four packages). Upgrading the engine only regenerates the lockfile; it doesn't touch the game's code. Ballast summarizes the releases in between, posts the summary to the game's Feed, and adds up to 8 tickets where the game is affected. It records the version each game was checked against (`engineChecked`), so the next catch-up starts from there. Run it with `POST /api/jungle-docs/catch-up` (optional `gameIds` and `from`, a version); `GET` on the same path shows the last run's results.
- **Used everywhere.** For Jungle games (a repo that depends on the engine), these all read the docs copy, so tickets and answers fit the engine's framework: triage, the GDD re-evaluation, the level audit, conversation mode, away work and local agents. Cloud agents get the docs address, the latest engine release and the last week's engine changes with each hand-off, and read the site themselves.

## Jungle Studio and Jungle Engine, per game

Game Settings → **Jungle Engine and Jungle Studio**:

- **Who does what.** For each department (gameplay, backend and tech, art, audio, untagged), choose Ballast or Jungle Studio. **Programming in Jungle Studio, art and audio in Ballast** sets the usual split in one click. Tickets for Jungle Studio stay on the board, marked **Jungle Studio**, but no Ballast agent takes them. The Board tab shows how many are waiting and has **Copy brief for Jungle Studio**, which copies every one as a single brief to paste there. On a ticket: **Done in Jungle Studio** closes it, **Ballast does it** hands one back, and **Send to Jungle Studio** moves a Ballast ticket over. Ballast's agents are told not to write the other side's code beyond what their own change needs to load, and to add a ticket for it instead. Triage still writes those tickets, as briefs a Jungle Studio pod can act on. The split follows each ticket's [tag]; QA tickets count as gameplay.
- **Engine rules: Strict.** For games set up with Jungle. Agents change only the game's own folder (`games/<id>/`) plus any paths you list under **Also allowed**, use the engine's documented APIs and Game Pack conventions, and ask you (a Decision in their report) instead of building around the engine. Triage writes tickets the same way. Every pull request an agent reports is checked with `gh`: files changed outside the folder come back as a ticket to move or revert them, and the Feed says which. **Guided** (the default) follows the engine's docs without the confinement. Repo work is exempt from both.

## Repo work

Studio → **Repo work** is for maintenance across a repo rather than one game: "unblock and resolve all the PR merge issues", CI, dependency bumps. Pick the repo and say what's needed. It becomes a high-priority `[repo]` ticket on the board of the repo's first active game, and the first free agent of **any** game in that repo takes it. Its brief says it may touch any folder, so strict confinement doesn't apply. Studio lists recent repo tickets with their status, who has them and their PR.

## New Jungle Engine games

**New game → Start from: A new Jungle Engine game** starts a game that runs on the engine alone (no Jungle Studio,
no pod), the way the engine's [Your first game](https://thecompanylive.github.io/jungle-engine/guide/getting-started)
page describes, without the manual steps. The form first checks this PC: Node 22+, git, the GitHub CLI, and that npm
can read the engine packages (the GitHub Packages token in your user `~/.npmrc`; the form links the install page when
it is missing). **Save it in** picks where the game goes.

### In your games repo (the default)

One project, one Game Pack per game: a developer's `thecompanylive/jungle-<name>` repo holds every game in its `games/`
folder. Give the folder's link (e.g. `https://github.com/thecompanylive/jungle-nat/tree/main/games`); the form fills in
the last one used, or the folder an existing cloud game lives in.

1. Ballast reads which engine version the repo installs (its `package-lock.json`) and takes the starter's demo pack
   from that release's own engine commit, so the new game matches the project.
2. It copies the pack to `games/<id>` and its art to `art-source/<id>`, renames `demo` to the game id everywhere the
   docs list (`@game/<id>`, keys, events, `g.<id>.*` messages, TypeScript names), sets the title and tagline, and
   registers the game in the project's three app files: `apps/client/src/main.ts`, `apps/client/src/room.worker.ts`
   and `apps/server/src/` (the server, bots and gameDocument).
3. The game appears in Ballast as a cloud game on that folder. The feed then reports `npm install`, the game's tests,
   the engine API check and the typecheck, run on a shallow copy of the repo (root files, `apps/` and the games folder).
4. Ballast pushes the branch `ballast/new-game-<id>` and opens a pull request into the base branch, with the checks in
   its description. Nothing goes to the base branch directly.
5. Autopilot stays off until the pull request is merged; Ballast checks every five minutes and turns it on then.
   Connect the agents' cloud sessions on the Agents tab meanwhile. The game's check before hand-in is the repo's
   `npm run check`.

A second game on the same repo reuses Ballast's existing clone of it, so the repo isn't downloaded again.

### As a project of its own

Ballast copies the whole starter (from the latest engine release's commit) into a new folder on this PC, with the same
renames, drops the « Taille humaine » sample pack unless you keep it, adds a `CLAUDE.md` with the engine rules and an
`npm run check` script, and commits. The feed reports `npm install`, the tests, the engine API check, the typecheck
and a build; the agents you picked join once the install passes, and a failed check becomes a board task. With a
GitHub repo filled in, Ballast creates it (private) with `gh` and pushes the first commit. The build command is
`npm install --no-audit --no-fund && npm run build` with output `apps/client/dist`. To play it yourself:
`npm run dev` in the project folder, then https://localhost:5173.

## Existing games

- **Survey.** Linking a repo that already has work (or pressing *Survey project* in Settings) has the lead agent read the code and history, suggest a brief (accept it in Settings), and put the next tasks on the board.
- **Adopt old sessions.** Agent → **Sessions** lists the Claude Code conversations that account already has in that repo. Adopting one continues it as a fork, so the agent keeps everything that conversation knew and the original stays as it was.

## claude.ai artifacts and director reviews

Ballast mirrors the artifacts your accounts have on claude.ai: design docs, review pages, trackers.

- **Sync.** Every 10 minutes, each account runs a short read-only Claude turn. It lists the account's artifacts, reads the tracked ones (content, live database data, comment threads) and reports back. Pages edited today are re-read at most hourly. Untracked artifacts show up under *Found on your accounts* in Studio. **Track** links one to a game.
- **Claude Docs documents.** A Claude Docs link (a doc, possibly with many tabs) is only the shared Docs viewer to the Artifact tools, so Ballast reads the document itself through the account's Claude Docs connector: a cheap Haiku run reads the doc for its tabs, then exports each tab as Markdown, a few tabs per run. Ballast takes the Markdown straight from the tool results, so the text is exact, and keeps it as `page.md` and `page.html` beside the other mirrors. A 16-tab, 23,000-word GDD takes about 20 seconds and /usr/bin/bash.05. The artifact card shows the tab and word count, and any tab it couldn't read. Changes are found by comparing the text, and a GDD or review change carries what changed, line by line. Triage reads the GDD's full text, and cloud agents are told to open a Docs GDD with the connector. The account that tracks the doc must be able to open it (the owner, or anyone it's shared with).
- **Roles.**
  - *Review*: when the page changes, the update becomes a director note to the team.
  - *Reference*: agents read it on demand.
  - *Output*: something an agent published.

  New comments on any tracked artifact become notes for that game. Set **Reviewers** in Settings to only route comments from certain people.
- **Cross-account.** Agents call `claude_artifacts` / `read_claude_artifact` to read Ballast's latest copy. That includes artifacts owned by a different account than their own.
- **Freshness.** This is polling, not push. Headless Claude runs can't hold a live watch on an artifact, so changes arrive within one sync interval.
- **Unofficial dependency.** Claude Code only loads its Artifact tools when it believes the Claude desktop app launched it. Ballast sets `CLAUDE_CODE_ENTRYPOINT=claude-desktop` for these read-only sync runs. A Claude Code update could change this. If syncing stops working, Studio shows the error. The switch is in Settings.

## Cloud games

A cloud game's agents run as **Claude Code cloud sessions** (claude.ai/code) on its GitHub repo, so your PC doesn't do the work.

**Quiet sessions.** Each session is judged by its last progress: a pushed report, or a new commit on one of its tickets' branches. After 90 minutes without either it gets a check-in message: push the report if done, push a `STATUS: BLOCKED` report if stuck, otherwise push work in progress. After 4 hours without progress, its unfinished tickets are marked blocked (they triage themselves) and the agent takes new work. Both times are settings (`cloudNudgeMin`, `cloudTaskTimeoutMin`), and neither grows with the number of tickets in a batch.

- **Notes.** Cloud sessions can't reach Ballast, so Ballast splits each note into tasks itself, with a quick local run.
- **Connect once per agent.** Claude Code only creates a cloud session from an interactive terminal, so each cloud agent gets one session that it keeps. Agent → **Connect cloud session** opens a terminal running `claude --cloud` under each agent's account, one after another. On Windows the terminal reads each session link (`https://claude.ai/code/session_…`) off its own screen and hands it to Ballast, so there's nothing to paste; it only asks you to paste if it can't find one. On macOS and Linux you paste each link into the terminal. A session you start yourself on claude.ai/code for the repo works too.
- **Dispatch.** Ballast sends each task to the agent's session as a message (`claude -p --cloud <session>`, which works headless). The message carries the brief, recent notes, what others are working on, and the tracked artifact summaries. One task at a time per agent.
- **Folder links.** A link like `github.com/owner/name/tree/main/game` keeps agents inside `game/`, and their reports go in `game/.ballast/reports/`.
- **Delivery.** The agent works on its own branch, opens a pull request into the base branch, and commits `.ballast/reports/t<task>.md`. Its first line is `STATUS: DONE` or `STATUS: BLOCKED`.
- **Completion.** Ballast checks GitHub every 90 seconds for that report, closes or blocks the task with the PR link, and hands the agent the next task.
- **Messages.** A message to a cloud agent goes straight to its session.
- **Builds.** Builds run in Ballast's own clone (`~/.ballast/clones/<game>`) at the latest base branch, so check-ins show merged PRs.

Requirements:
- Every account needs GitHub connected on claude.ai/code: run `/web-setup` once in Claude Code, or install the Claude GitHub app.
- Your git on this PC must be able to read the repo.
- Model and permissions for cloud sessions are set on claude.ai/code. Attachments in notes stay on this PC.

## Builds and daily check-ins

In a game's Settings:

- **Check-in times**, e.g. `09:00, 13:00, 17:30`. At each one Ballast builds and posts a check-in to the feed: commits since the last build plus the board tasks finished. A missed slot still fires if Ballast starts within 90 minutes of it.
- **Build command** runs in a dedicated `_build` worktree checked out at `ballast/integration` (or in the repo, in shared mode). It gets `BALLAST_OUTPUT_DIR`, `BALLAST_BUILD_ID`, `BALLAST_COMMIT` and `BALLAST_GAME` in its environment. Example for Unity:
  ```
  "C:\Program Files\Unity\Hub\Editor\6000.0.40f1\Editor\Unity.exe" -batchmode -quit -projectPath . -executeMethod Builds.Quest -logFile -
  ```
  Don't have a build method yet? Send a note: *"add a batchmode build method Builds.Quest that writes the APK to BALLAST_OUTPUT_DIR"*.
- **Output to collect**: a path relative to the repo, copied into the build record. You can skip it if your build writes to `BALLAST_OUTPUT_DIR`.
- **Share folder**: successful builds get copied here (a Google Drive, OneDrive or network folder is the easy way to share them).
- **Webhook**: a Slack or Discord incoming webhook gets the check-in summary.
- **Written check-in report**: optionally the lead agent writes a short "what's playable, what changed, what's next" report after each check-in.

**Build now** on the Builds tab runs one immediately.

### Playing a build

Every build offers what its output supports, and the game header has **▶ Play latest**:

- **Web builds** (an `index.html` anywhere in the output) open from a local play server at `http://localhost:4480`. It's a separate origin from Ballast, sends the cross-origin isolation headers threaded Godot and Unity web exports need, serves Unity's pre-compressed `.gz`/`.br` files, and counts as secure, so WebXR works in a desktop browser.
- **Windows builds** (`.exe`) start with **▶ Run**.
- **Android builds** (`.apk`) go to a Quest plugged in by USB with **Install on Quest**. Needs `adb`, which comes with Meta Quest Developer Hub (or set its path as `adbPath`). Ballast tells you if no headset is found or USB debugging hasn't been accepted in the headset.
- **Upload to itch.io** pushes the build with [butler](https://itch.io/docs/butler/) to the itch.io page set in the game's Settings (`yourname/your-game`): web builds to the `html5` channel, `.exe` to `windows`, `.apk` to `android`. Install butler and run `butler login` once.

## Roadmap: GDD features, L0-L3 quality levels, milestones

The **Roadmap** tab turns the GDD into a plan. **Break down the GDD** has Claude read the design docs in the repo (and a claude.ai GDD you track) plus the board, and split the game into features. Each feature gets four quality levels, with what "done" means at each and the tasks to get there:

| Level | Means |
|---|---|
| **L0 Greybox** | Placeholder art and logic that proves the idea is fun. |
| **L1 Functional** | Works end to end with real rules; rough edges and placeholder content are fine. |
| **L2 Polished** | Feels good: tuned, juicy, target-quality art and audio. |
| **L3 Ship** | Performance, edge cases, accessibility and final content: ready for players. |

- **Milestones** are features at a level: *First playable* (core features at L1, the rest at L0), *Vertical slice* (core L2, rest L1), *Content complete* (all L2) and *Launch* (all L3). Change the levels per milestone, mark which features are core, or add your own milestones (a festival demo, say).
- **Automatic backlog.** For the current milestone, Ballast puts the next level's tasks for each feature on the board, one level at a time. When all of a feature's tasks for a level are done, it reaches that level and the next level's tasks go up. When every feature reaches the milestone's targets, the milestone closes and the next one starts.
- **Forecast.** Each milestone shows progress, features already there, tasks left (open ones plus planned ones for levels not on the board yet) and a date at the game's own pace over the last 14 days (30 if it's been quiet).
- Re-running the breakdown keeps your core flags and reached levels. If it misjudged how far a feature is, set its level in the feature's details.

### Level audit

Finished tickets aren't proof of a level: agents close their own tickets, so levels earned that way drift upward. **Audit levels honestly** (Opus; **Sonnet** next to it for a lighter pass) sets every feature's level from evidence instead:

1. It pulls the latest GDD (as the GDD re-evaluation does) and syncs the repo.
2. One run reads the code of each feature where a player meets it: wired into the client and server the game runs, not only in shared rules, tests or a debug menu. It also weighs your review verdicts (send-backs and "Changes to #…" tickets, with your words), your notes and playtest feedback, and the latest profiler run.
3. Strict rules: **L0** needs a player to be able to do it in the real game; **L1** works end to end with real rules and nothing open that breaks it; **L2** needs your approval or positive playtest feedback, and code-made or placeholder art doesn't count; **L3** needs the performance budgets met on the headset. When unsure it rounds down.

Each feature shows **✓ verified Lx (was Ly)**, with the evidence, its confidence and what's missing in its tooltip and details. The audit can lower levels, adds tickets for what's missing up to the current milestone's targets, and reopens a milestone that was only reached on the old levels. Tickets finished before an audit no longer raise levels; work done after it does, until the next audit checks it. A re-run breakdown keeps audited levels, and setting a level yourself in a feature's details counts as verified too.

## Gameplay Loop tab

Checks that a game's design is coherent and delivers a compelling, repeatable loop. Mechanics change as you test them, and that's expected; what it watches for is the design no longer holding together. It's built on *The Readable Loop*, a Rational Game Design framework checked against recent player-experience research: a loop is a readable question with an uncertain answer, asked at several time scales, where every answer changes what the player knows or wants.

- **Audit** (Opus by default; Sonnet or Fable in the model menu). It reads the latest GDD, the code, your notes, playtest notes and video reviews, your review send-backs and Inbox answers, and the latest profiler run. It names the game's loops across the **moment, encounter, session and meta** time scales and marks the core ones. It scores each loop on six tests: one skill, predict then act, keep the answer open, dose the feedback, every pass moves the model, and nest the clocks. Each score says what it rests on (telemetry, playtest, your call, code, or an assumption); the weakest test is where the loop leaks. Run it from the tab, or schedule it (every hour, every 6 hours, daily or weekly at a time). An audit adds no tickets; a summary goes to the Feed.
- **Verdict and actions first.** The top of the tab says whether the loop **holds together**, is **strained** or is **broken**, in one sentence. It shows the core loop as a player meets it today, step by step, with weak links marked, and where the design stops holding together and how to fix it. Below that is **What to do**: at most 6 actions ranked now / next / later, each one line, with buttons: **Queue for Lock In**, **Try on the sliders** (tuning), **I played it** (playtests for you) and set aside. An audit made before this format has **Rewrite as a verdict and actions** (a quick Sonnet pass over what it found). The loops are listed in a table; open one for its tests, sliders and conversation.
- **Ticket focus** (folded away). Each audit sorts the last 3 weeks' tickets (and everything open) by the loop they feed, as groundwork (builds, crashes, performance), or as feeding no loop, with the trend across audits. It only shows where effort went. Triage sees the loops too, so a new ticket that adds a system feeding no loop says so ("Off-loop: …").
- **Tuning.** Each loop has sliders for its real tunables, read from the code with their file and line, and graphs of the loop's model: formulas over those numbers, such as the chance of a clean swing by player skill, with an "answer still open" band. Moving a slider redraws the graphs at once; the solid line is your value and the dashed line is the code today. Headline numbers (longest drive, time to kill) show against their targets. Drafts are saved; **Back to the code's values** undoes them.
- **What playtests say.** Each loop lists the playtest results and reviews that bear on it, how they read by the framework, and what they imply. Next iterations come with **Try it on the sliders** (when it's a tuning change) and **Add to changes**.
- **Ask a loop.** Each loop has its own conversation. An answer reads the code, and when a number or curve would help it adds the sliders and a graph for it, updates or replaces a graph, or moves sliders when you ask for a change or a scenario. A design change you settle in the conversation is queued to lock in.
- **Lock In Changes.** Slider changes and decided changes collect in a bar at the top. Pressing it turns them, with the conversation behind them, into board tasks (`Gameplay Loop`). Each task gives the files and values from → to, what the change does to the loop's skill, uncertainty, feedback and pacing, and how to check it in a playtest. Locked sliders show their tasks; the next audit reads the new value from the code once it has landed.

Formulas are evaluated without `eval` by a small formula engine (`public/loopmath.js`, shared by the page and the server). The server checks every formula Claude writes and drops any it can't evaluate.

## GDD tab: writing the GDD with Ballast

Ballast keeps the GDD as numbered Markdown versions (`~/.ballast/gdd/<game>/`) and changes it with you.

**One GDD.** Once a game's GDD has a version in Ballast, the current version is the GDD everything reads: the GDD re-evaluation that keeps the board stocked, the section breakdown, the level and loop audits, focus planning and note triage. Tracked GDD pages and the repo's design files stop being read separately. An edit made directly in the tracked Claude Docs doc comes back as the next version (when its text differs), and the re-evaluation runs on it as before. If writing an accepted change into the doc didn't fully work, the Feed says so when the doc's own edit arrives, because taking the doc's text would leave those edits out.

- **Import.** **Import the GDD** takes it from where it lives: a tracked GDD page (a Claude Docs doc through its Markdown copy, or another claude.ai page), or, when nothing is tracked, the repo's GDD files. **Paste or upload** takes Markdown or text. **Import again** makes a new version from the source, and **Download** saves the current one.
- **Feedback becomes a draft.** Write feedback on the design. Claude (Opus, or Sonnet for speed) reads the whole GDD and the code, and proposes exact edits: the section, the passage as it stands, the new text, and which part of your feedback it answers. It keeps the GDD's own structure and terms, and fixes anything elsewhere that the change would contradict. Where your feedback leaves a real design choice open, it asks, with options and the assumption it drafted on. Answer the questions (or tap an option), add anything, and it revises the whole draft. Edits whose passage isn't in the current GDD are marked *not found*.
- **Accept.** Untick what you don't want, then accept. The edits are applied to the current version and saved as the next one, then written back where the GDD lives: into the Claude Docs doc through the connector (the card reports which edits landed), or as an urgent `[docs]` ticket that commits them to the repo's GDD files (or to `gdd/GDD.md` when the GDD lives only in Ballast). A read-only claude.ai page can't be written to. The GDD re-evaluation then brings the board in line.
- **Notes that change the design.** When triage finds that a Feed note changes the design (a rule, number, system, content or goal), it also starts a GDD draft for your review, so the GDD keeps up with what you decide while playing. The GDD tab's count shows drafts waiting for you.

## The director's workbench

Ballast is built around how a director makes a game: play, notice, write a note, get one specific thing tweaked, play again. These are the places to do that on one thing at a time.

- **How sections are cut** (Sections tab). Choose the scheme the GDD breakdown follows: **Systems** (one section per system, its rules, numbers and feedback, with content inside the system it exercises), **Features**, **Content** (levels, characters, items) or **Player journey**, and add your own instructions ("one section per system: digging, power, air, clients…; art direction is its own section"). Each section gets a kind (system, content, character, level…). **Re-break the GDD this way** keeps the gate and tickets of sections that keep their name; tickets of sections that disappear go back to "no section" for **Sort into sections**.
- **Gyms** (on a section's card). **Ask for a gym** and say what you want in it. The ticket asks for a test scene that opens directly (a URL query, dev menu or one command) into that one system, with its tuning numbers as live controls, readouts, presets and a one-action reset, built into the game's own code (the engine's way, for Jungle games) without touching the real game's balance. The agent ends its report with `GYM: <how to open it>`, which Ballast puts on the card with a copy link. Notes sent from the gym's box go to that section, so their tickets land there. **Ask for changes** adds to the same gym. Gym tickets go ahead whatever the gates or focuses say.
- **Art subjects** (Art tab). A character, creature, level, environment, prop, UI or effect with a brief, a section, reference targets (the tab's quality targets) and other references. Each **round** is a ticket carrying the brief, the references, your notes on the earlier rounds and what the last round changed, and asks for captures from the same views every round (turnarounds for characters, fixed camera positions for levels), named by round. Rounds show newest first with their captures, so you compare them side by side. When a round is done: write notes and start the next round, **Approve** it, or **Pause**. A new round waits until the last one is done, and art rounds go ahead whatever the gates or focuses say.

## Focus

What you want worked on right now, in your own words. On the Board tab, **+ Write a focus**: a short title, a description (what, why, what done looks like), how strictly, and an optional end date.

- **First** puts the tickets that serve it ahead of the rest. **Only** holds other work, apart from urgent tickets and repo work.
- Saving has Claude match the board's tickets to it (each gets a ★ focus tag). Triage tags new tickets with the focuses they serve, and tickets from anywhere else (roadmap, audits, the GDD check) are matched every 10 minutes.
- **Plan tickets for it** reads the GDD and the code, says where the focus stands in the game today, and adds the board-sized tickets still missing (up to 8), tagged with their section and level.
- Agents are told the focus with every hand-off, so they lean their work toward it and add tickets for gaps they notice.
- A focus never pulls work past a section gate; the card shows how many of its tickets wait above one. Focuses show in the game's header; Pause, Resume, Edit and remove them from the card. The Sections tab's per-department focus (by section) works alongside it.

## Sections and production gates

For when a game needs one part honed for a while instead of everything moving at once. The **Sections** tab shows the GDD broken into sections (the roadmap breakdown's features), each with what L0 Greybox, L1 Functional, L2 Polished and L3 Ship mean for it. A game with no breakdown gets one from the tab.

- **Gates.** Each section has a level-of-quality gate: Hold, L0, L1, L2 or L3. The team builds a section up to its gate and no further. Tickets above it wait (the card says why), the roadmap and the level audit don't stock past it, and agents are told not to start a section's next level. When a section meets its gate it's marked *at its gate · your call*, and the tab's count shows how many are waiting. Only you move a gate: pick a level, or press **Pass to L2**. **Hold** stops all work on a section. Starting gates are each section's target in the current milestone, so switching gates on stops nothing in flight. The **Production gates** switch turns them off, and the milestones drive the work again.
- **Production gate sets.** Named sets of section targets, kept in order: First playable, Vertical slice, Art pass 1. **New gate set** starts from the gates you have now; set each section's target, or *Leave* to keep it as it is. **Apply** moves every gate in the set at once, and work for gates that opened starts right away. Each set shows how many of its sections have reached their targets. Nothing moves on by itself.
- **Focus.** Each department (gameplay, art, audio, backend) can focus on chosen sections: **These first** puts their tickets ahead of the rest (urgent tickets still come first), **Only these** holds that department's other tickets.
- **Tickets know their section.** Triage gives every ticket the section it develops and the level it works toward. Each section has its own note box: a note sent from it lands its tickets in that section, at or under its gate unless it asks for the next level. **Sort N tickets into sections** has Claude place older open tickets (or marks them as groundwork no section owns).
- A section's level still rises when every ticket at a level is done, so a section can show L2 on tickets alone. The level audit (Roadmap tab) checks levels against the game itself.

## Artifacts

Agents publish anything you should look at with `publish_artifact`: HTML prototypes (a folder with `index.html` works), mockups, design docs, screenshots, videos. They land on the game's Artifacts tab and in the feed. HTML artifacts are served sandboxed. Ask for them in notes: *"make an HTML mock of the new HUD and publish it"*.

## Taking over a session

Agent → **Terminal** opens that agent's Claude session (`claude --resume <id>`) in a terminal, under the right account, in its worktree. Stop the agent first.

## Prompt caching

Claude reads back what a conversation already sent from its [prompt cache](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) at a fraction of the cost of fresh input, as long as the start of the prompt is byte-for-byte the same and the entry hasn't expired. Ballast drives Claude Code, which places the cache markers itself ([how Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)), so Ballast's part is keeping what it sends stable:

- **Cache lifetime pinned to 1 hour.** Agent turns are often minutes to hours apart, and one-off runs of a kind repeat within the hour. Claude Code uses 1 hour on a subscription but drops to 5 minutes once an account runs on usage credits; Ballast sets `CLAUDE_CODE_PROMPT_CACHE_TTL` so it stays at 1 hour there too. Settings → **Prompt cache lifetime** (1 hour, 5 minutes, or let Claude Code decide).
- **No mid-session model switches from usage rules.** Each model keeps its own cache, so switching a resumed session re-reads its whole conversation uncached. A model or effort change that comes from a usage rule waits while that agent's cache is warm and applies with its next session or once the cache has gone cold, so a rule flapping around its threshold can't force repeated full re-reads. Changes you make yourself apply at once.
- **Stable starts.** Ballast's one-off runs (`--safe-mode`) start with the same small system prompt and tool list for every run of a kind, whatever game folder or account they run in; per-run material (the note, the board, the GDD) comes after it. Agents' sessions keep the system prompt recorded on their first turn when resumed, so the per-turn instructions Ballast adds don't break their cache.
- **A standing check.** The Budget tab's **Prompt cache** section shows, per kind of run, how much input was read from the cache, written to it, or sent uncached. A run kind whose cache share suddenly drops means something now changes the start of its prompt. Cloud sessions cache on claude.ai and aren't counted there.

## Safety

- Games default to `bypassPermissions` so agents can work unattended: **they run any command without asking**. Only point Ballast at repos and machines you're comfortable with that. You can switch a game to `auto` or `acceptEdits` in Settings, but agents may then stall on actions that need approval.
- The server listens on `127.0.0.1` only. The UI uses an HttpOnly, SameSite=Strict cookie and rejects cross-origin writes and foreign `Host` headers, so a web page can't drive your agents. Agents call back with a separate key.
- Ballast strips `ANTHROPIC_API_KEY` from agent environments so one key can't silently bill every account.
- Check that running several Claude plans side by side fits the terms of those plans.

## Data

Everything lives in `~/.ballast` (set `BALLAST_HOME` to move it):

```
state.json            accounts, games, agents, board, builds, artifacts index
usage.jsonl           one line per Claude run: account, game, tokens, cost
accounts/<name>/      Claude profile per account (CLAUDE_CONFIG_DIR)
cloud/<id>/           last copy of each tracked claude.ai artifact
clones/<game>/        Ballast's clone of each cloud game's GitHub repo
games/<id>/feed.jsonl game feed; attachments/ holds pasted images
agents/<id>/          transcript.jsonl, system prompt and MCP config
artifacts/<game>/     published artifacts
builds/<game>/<id>/   build.log + output/
```

## Code map

| File | What |
|---|---|
| `src/server.mjs` | HTTP API, SSE, static files, auth |
| `src/orchestrator.mjs` | accounts, games, agents, board, dispatch, autopilot, usage limits |
| `src/pace.mjs` | pace per account (use against time gone), reset-aware ordering, the limit reading log |
| `src/budget.mjs` | Budget tab: cost per ticket from limit readings, waste, waiting, results against spend |
| `src/jungledocs.mjs` | Jungle Engine docs: daily copy by page hash, change summaries, games checked against changes, docs for runs and agents |
| `src/claudedocs.mjs` | Claude Docs documents tracked as artifacts: read through the Claude Docs connector, tab by tab, as Markdown |
| `src/gddedit.mjs` | GDD tab: GDD versions, feedback drafts with clarifying questions, accepting and writing back |
| `src/workbench.mjs` | the director's workbench: gyms for systems, art subjects with iteration rounds |
| `src/focus.mjs` | Focuses: the director's written focus, ticket matching, claim order, planning the missing tickets |
| `src/gates.mjs` | Sections tab: level-of-quality gates per GDD section, production gate sets, department focus, sorting tickets into sections |
| `src/worksplit.mjs` | work split with Jungle Studio per discipline, strict Jungle Engine mode and its PR file check, repo-wide maintenance tickets |
| `src/loops.mjs` | Gameplay Loop tab: loop audit (six stage tests), where the work went, loop models and sliders, per-loop conversation, Lock In Changes |
| `public/loopmath.js` | the formula engine for loop models (browser and server) |
| `src/daily.mjs` | the daily update in each Feed, time away (welcome-back update), away work when a board runs low |
| `src/away.mjs` | time away: which work needs the director, what agents are told |
| `src/diagnostics.mjs` | read-only diagnostics snapshot for conversation mode: live agent state, accounts, board, errors, logs, schedules, live checks |
| `src/levelaudit.mjs` | Roadmap: evidence-based level audit (GDD, code a player meets, director verdicts, profiler runs) |
| `src/gddreview.mjs` | Board: re-evaluate against the GDD (pull, compare, read the repo, add tasks), on demand or scheduled |
| `src/jungle.mjs` | new Jungle Engine projects from the engine's starter: PC check, rename, install, checks |
| `src/claude.mjs` | runs `claude -p --output-format stream-json` per turn, logins, terminals |
| `src/prompts.mjs` | every piece of text sent to agents (tune the team protocol here) |
| `src/mcp-server.mjs` | the stdio MCP server each local agent loads (board, feed, artifacts, claude.ai mirror) |
| `src/scheduler.mjs` | check-in schedule, builds, limit probes, artifact syncs, cloud polling |
| `src/usage.mjs` | token accounting and summaries |
| `src/policy.mjs` | per-game usage cap and rules, and their presets |
| `src/audits.mjs` | Bartle Audit: audience ranking and marketing plan per game |
| `src/whisper.mjs` | local Whisper server for Director Review |
| `src/roadmap.mjs` | GDD breakdown, L0-L3 levels, milestones, backlog, forecasts |
| `src/play.mjs` | play server for web builds, run/Quest install/itch.io upload |
| `src/digest.mjs` | daily digest and weekly devlog report |
| `src/discord.mjs` | Discord playtest channels to game notes |
| `src/phone.mjs` | phone access: home network / Tailscale listener and pairing |
| `src/setup.mjs` | setup guide checks |
| `src/ask.mjs` | conversation mode: questions answered by the account with the most weekly room |
| `src/threads.mjs` | ticket conversations, and rewriting a ticket from what was decided |
| `src/unblock.mjs` | blocked-ticket self-triage and Human Intervention requests |
| `src/video.mjs` | playtest video review: frames, commentary transcript, Claude's notes |
| `installer/` | Windows installer (IExpress): build, install, launch, uninstall, tests |
| `src/cloud.mjs` | claude.ai artifact sync and review routing |
| `src/remote.mjs` | cloud games: triage, cloud sessions, GitHub report polling |
| `src/review.mjs` | departments, review modes, approve / request changes, auto-approve |
| `src/inbox.mjs` | Director's Inbox |
| `src/git.mjs` | worktree and integration-branch helpers |
| `public/` | the UI (vanilla JS, no build step) |
