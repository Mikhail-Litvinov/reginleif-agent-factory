# Agent Factory: audit of Rig and the local environment

Purpose: facts that limit or help the design of Agent Factory (PostgreSQL, Temporal, API, a local Windows worker, as an optional Rig component). This file states facts only; decisions belong to the architecture document.

Marks: [V] verified by reading code, files or official pages; [I] inferred; [?] not verified. Paths are relative to the Rig repo unless a prefix says otherwise. Rig is version 0.7.14 (HEAD 95a6729). The hub is the separate repo claude-telegram-hub, plugin 0.5.6, called HUB below (its source is under the Claude plugin cache, `telegram-hub/0.5.6/src`).

## 1. What Rig is today

| Component | Where | What it does |
|---|---|---|
| CLI `rig` | src/cli.ts (entry :270-274, usage :38-61) | Bun TypeScript, no runtime dependencies. One JSON object on stdout; failure is `{"error":{code,message}}` with exit 1; progress is JSON lines on stderr (src/output.ts:1-5, 55-61) [V] |
| Feature graph | base/feature.json, features/*/feature.json, src/feature-graph.ts:56-67, src/feature.ts:132-169 | Declares rules, hooks, settings, plugins, assets, agents, skills, programs per feature [V] |
| Apply/install/update | src/commands/install.ts:46-98, apply.ts, update.ts:54-96, src/update/update.ts | Writes rules/settings/agents into `~/.claude` and `~/.codex`, installs shim, cron, updates by git fast-forward [V] |
| Sessions | src/commands/session*.ts, session-core.ts, base/hooks/session_record.py | List, stop, cleanup, compact, rename, autocompact, run (resume only), mode [V] |
| Exec runner | src/commands/exec*.ts, exec-core.ts | Generic detached shell runner with log, heartbeat, stop [V] |
| Window plugin | plugins/agent-rig-window/mod/window.ts (0.3.2) | Claude Code mod; polls every 1000 ms for ops compact, rename, autocompact, usage, mode [V] |
| Codex delegation | features/codex/tools/codex-run.py (738 lines), agents/codex.md | Detached supervisor around `codex exec` [V] |
| Volunteers | features/volunteers/tools/volunteer-run.py (1189 lines) | Same shape as Codex, worker is OpenCode via a local proxy; Windows only, off by default [V] |
| Telegram | features/telegram (two rule files, no code); HUB repo | Rig only manages the hub service; the hub owns the bot, WebSocket and HTTP endpoints [V] |
| Hooks | base/hooks/*.py, features/subagent-tasks-guard | Guards (ampersand, system temp, subagent tasks) and session records [V] |

Facts about the shape of Rig:
- No permanent process of its own. Running things are: the hourly cron update, detached exec runners, the hub service, Codex/volunteer supervisors [V].
- State is JSON and JSONL files under `~/.agent-rig`; no database, no schema versions except `rig status --json` schemaVersion 1 [V].
- Output is JSON only; there is no web UI and no HTTP server in Rig itself [V].
- Process identity everywhere is pid plus creation time [V].

## 2. CLI, features, install, update, rollback, state on disk

### 2.1 CLI
- Hand-written parser: parseCommand src/cli.ts:82-109; execute switch :233-268; Command union :64; COMMAND_NAMES :161-176 [V].
- Adding a command touches 5 places in cli.ts, a fixture in tests/api-output.test.ts:107-110, and en/ru messages (src/messages.ts, src/messages-ru.ts) [V].
- No plugin point for commands. The `legacy` outcome is dead code [V].
- Internal commands: `exec-runner`, `update-step` [V].
- Errors use `Result<T>` (src/result.ts); exit codes are 0 or 1 [V].

### 2.2 Feature manifests
- Fields: name, description, translations, enabledByDefault, platforms, dependencies, rules (conditions only), hooks, settings, plugins, assets, agents, skills, programs, files (no consumer), hubCommands (no consumer) [V].
- Platform values: linux, windows, darwin (src/feature.ts:23) [V].
- One broken manifest breaks install, apply, feature, check and update, but not status [V].
- Plugin marketplaces are limited to claude-plugins-official and openai-codex (apply.ts:554-558); a plugin may use `rig:<folder>` [V].
- Managed programs: codex (`bun add --global @openai/codex`), opencode (pinned opencode-ai@1.19.4), rtk (release with sha256 check) [V].
- There is no feature-removal command [V].
- A feature cannot ship today: a CLI subcommand, its own dependencies, a long-running process, an autostart entry, its own tables or state dir, a web UI [V].
- Telegram is hard-wired outside manifests: feature.ts:53, 81; check.ts:136-140; update.ts:236-239, 408-410; session-run.ts:72-75; real-runtime.ts:457, 504-535; install.ts:23 [V].

### 2.3 Install
- src/commands/install.ts:46-98. Server paths: `~/.agent-rig/repo` and `~/.agent-rig/hub`. Shim at `~/.local/bin/rig` [V].
- Cron is installed only on non-dev installs (install.ts:87, 140-164) [V].
- No install step exists on user machines for dependencies (README.md:7, INSTALL.md:76) [V].

### 2.4 Update and rollback
- Gates: clean tree, branch main, not ahead of origin/main, fetch of both repos (rig and hub), pair not in badPairs [V].
- Then `merge --ff-only`, then `update-step apply|check` runs in the new code; exit codes 0, 1, 2 [V].
- Rollback (src/update/update.ts:470-537, 554-586): record badPairs, `git reset --keep`, re-apply, service restart [V].
- Pending hub restart is Telegram-only with a 5 minute timeout [V].
- Cron: `rig update` hourly and `rig update --pending` every 5 minutes (src/update/cron.ts:4-5, 17-36) [V].
- There are no migrations. A rollback cannot undo a database schema; only two repos move on update [V/I].
- Plugin installs and managed programs are not reverted by a rollback [I].

### 2.5 State on disk
- Inside `~/.agent-rig`: state.json, rig.lock, events.jsonl (trimmed at 1 MiB), hub-restarting.json, hub-ready.json, update.log, generated/CLAUDE.md, sessions/, exec/, launch-stderr, account-allowlist.json, volunteer-projects.json [V].
- state.json is flat; unknown top-level keys are dropped on rewrite (state.ts:76-86); records prefixed `setting:`, `asset:`, `plugin:` are rebuilt by apply [V].
- Outside it: `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.claude/agents`, `~/.claude/skills`, `~/.claude/projects`, `~/.claude/channels/telegram-hub`, `~/.local/bin`, crontab, systemd units, a Windows Scheduled Task, `/etc/claude-code/managed-settings.json`, temp dirs [V].
- Locks: rig.lock is held by install, apply, feature, language and update. It is not held by status, check, info, session list or exec. A live owner is waited on with no deadline [V]. The session-ending lock is a separate mechanism (src/session-ending.ts) [V].
- User-settings protection: ownership records and surgical edits in settings.json (merge-settings.ts), marker blocks in CLAUDE.md and AGENTS.md, `.bak-*` backups, asset hashes, symlink check [V].
- There is no secrets model in Rig [V].

## 3. Sessions, exec runs, process identity, stop guarantees, platforms

### 3.1 Sessions
- Rig has no function that starts a new Claude or Codex run. `rig session run` only resumes with `claude --resume <id>` in a visible terminal (session-run.ts:172-198) [V].
- Terminal launch: Windows `cmd /c start "" wt.exe -w new ...` (src/launch-command.ts:9-21); Linux without display uses tmux; macOS uses osascript [V]. Real Windows Terminal behaviour [?].
- `session run` returns `{session,pid,mode,account}`; polls every 1 s for up to 90 s plus 2 s grace, then fails with launch-timeout (session-run.ts:28-32, 40) [V].
- Accounts: `accountOf` (src/commands/info.ts:138), `resolveLaunch` (session-run.ts:154-170), used only if the external tool cswap is found [V]; cswap behaviour [?].
- Session records are written by Claude hooks (base/hooks/session_record.py), not by Rig: sessions/<id>.json, sessions/<id>/processes/<pid>.json, ending lock and ending.json, request claims by `mkdir claims/<id>` [V].
- A record is retired when it has no transcript, no live process and no live ending owner; only readers delete records [V].
- Commands: list, stop, cleanup, compact, rename, autocompact, run, mode (session.ts:17-25) [V]. Cleanup = compact + stop + transcript clean (session-cleanup.ts:12) [V].
- No scheduler, worktree or workspace management exists; only src/update/cron.ts for the update job [V].

### 3.2 Exec runs
- `exec start <pwsh|cmd|bash> --cwd`, `exec start rig -- <args>`, `exec status <id> [--from N [--wait ms]]`, `exec stop <id>`, `exec list` (src/commands/exec.ts:9-27) [V].
- Run dir `exec/<id>/`: record.json, heartbeat (every 10 s), identity.json, log, result, stop-request, exit.json (exclusive write), runner-stderr, command scripts [V].
- Log chunks at most 64 KiB (exec-core.ts:20); waiting polls every 250 ms; root keeps 50 runs (EXEC_MAX_RUNS, exec-core.ts:18); a directory with no valid record older than 30 s is removed [V].
- On Windows bash is hardcoded to `C:\Program Files\Git\bin\bash.exe` (exec-shell.ts:10) [V].
- Crash and reboot: a stale heartbeat never ends a run; a run is marked `lost` lazily, only when pid and creation time mismatch (exec-core.ts:139-153) [V]. Behaviour after a reboot [I].

### 3.3 Process identity
- `createdAt` shells out to `python -I base/hooks/session_record.py created-at` (real-runtime.ts:365-383) [V]. macOS support [?].
- A process is live only if pidCreated is non-null and equal (session-core.ts:101-103); a table missing a pid gives `processTableIncomplete`, never "dead" [V].
- Lock ownerStartTime is separate (real-runtime.ts:405-447) [V].

### 3.4 Stop guarantees
- Session stop compacts first above 120k tokens (session-stop.ts:12), then killTree and polls 15 s (STOP_TIMEOUT_MS) [V].
- Exec stop (exec-core.ts:301-350): grace 5 s (EXEC_STOP_GRACE_MS), outside kill, identity verification within 1 s, then `stopped` is written [V].
- Windows: runs inside a kill-on-close job object (windows-job.ts:44-64, needs bun:ffi). POSIX: process group. `killGroup` errors on Windows (real-runtime.ts:361). killTree at real-runtime.ts:339-359 [V].
- Windows detached spawn (src/commands/windows-spawn.ts) tries CREATE_BREAKAWAY_FROM_JOB, falls back to a WMI Win32_Process.Create broker; the hub runs as a Scheduled Task [V].

### 3.5 Embedding
- Mostly importable without the CLI: an injected `RuntimePorts` (src/ports.ts:55-93); `createRealRuntime` in src/commands/real-runtime.ts (684 lines) [V].

### 3.6 Platform differences
- Windows needs Git Bash and bun:ffi; WSL is not a target. Ubuntu 24.04 is the Linux target. macOS has partial branches; no darwin service path [V].
- Windows-only features: volunteers, pwsh, cmd [V].

## 4. Codex and volunteers delegation

### 4.1 Codex (features/codex/tools/codex-run.py)
- Subcommands: start, wait, attach, reply, cancel, list, prompt-path, session-hint, hidden `_supervise` (:3-12, 701-732). No `--json`: output is a text digest [V].
- Job dir `~/.claude/codex-jobs/<timestamp-hex>/`: state.json (atomic writes; fields :321-324, 356-357, 514-518), events.jsonl, last.md, prompt.md, reply.md, cancel, heartbeat, digest_offset, codex.err, supervisor.log [V].
- Statuses: starting, running; TERMINAL = done, question, blocked, malformed, cancelled, orphaned, limit (:81). Reply allowed from done, question, blocked, malformed, limit (:85, 645) [V].
- The `STATUS:` line is validated by base/tools/run-report.py:21-56; missing gives `malformed` after one follow-up [V].
- `start` returns at once with a detached supervisor (:498-524) [V].
- Command: `codex exec --json --skip-git-repo-check -m <slug> -c model_reasoning_effort=.. -c sandbox_mode=read-only|workspace-write -o last.md`; prompt on stdin; continuation by `codex exec resume <session_id>` (:332-344); wrapped by base/tools/process-job.py [V].
- Supervisor: cancel flag gives cancelled; heartbeat older than 30 min gives orphaned (CODEX_RUN_ORPHAN_SECONDS, touched on each wait call); idle 20 min (60 min during a shell command) counts as hung and restarts; MAX_RESTARTS=3 then blocked (:435-449) [V].
- Reattach after a worker crash (:608-628) does not respawn the supervisor; it sets blocked and only `reply` continues [V].
- Cancel waits 15 s then kills the supervisor (:660-681) [V].
- Terminal jobs older than 14 days are deleted on each start (:78, 470-477) [V].
- Model gates by line (luna, terra, sol, astra) from `~/.codex/models_cache.json` (:62, 262-278). Effort above high or astra needs `--approved` (:501-504): a flag, not authentication [V].
- Account gating: account_allowlist.refuse_if_blocked("codex") against `~/.agent-rig/account-allowlist.json` (:499, 640) [V].
- Limit detection is reactive (LIMIT_RE, free-text limit_reset, :86-87, 437-440); no quota query [V].
- Platforms: Linux, Windows, macOS (:480-491, 222-252) [V].
- A machine consumer would parse state.json and events.jsonl; the schema is de facto and unversioned [I].
- Codex CLI facts: see section 8.

### 4.2 Volunteers (features/volunteers)
- enabledByDefault false, Windows only (feature.json:9-12). Same subcommands as Codex; jobs in `~/.claude/volunteer-jobs/` [V].
- Worker is OpenCode (`opencode run --format json`) through a local freellmpool proxy at 127.0.0.1:18080 (VOLUNTEER_PROXY_URL). ALLOWED_PROVIDERS = openrouter, groq, requesty, zhipu (volunteer-models.py:46) [V].
- Direct model API calls in the repo: only list URLs for OpenRouter and Requesty (volunteer-models.py:41-42) [V].
- `volunteer-models.py limits [--json]` gives daily counters [V].
- cwd allowlist `~/.agent-rig/volunteer-projects.json` (volunteer-run.py:387-409); without it every folder is refused [V].
- OpenCode permission map is code-enforced (volunteer-run.py:173-177, 544-566): read-only mode allows a short bash list; write mode denies git commit, push, reset; webfetch, websearch, external_directory always denied [V].
- Design doc: volunteer-design.md. The hub does not show volunteer jobs (its card code is Codex-specific) [V].

## 5. Telegram hub

- Rig has no Bot API client. It manages the hub service: systemctl --user `telegram-hub.service` on Linux, Scheduled Task `telegram-hub` on Windows (real-runtime.ts:457, 504-535) [V]. Which side creates the unit: the hub repo's script creates it per one report; Rig starts, stops and restarts it [I].
- docker/fake-hub holds only a marketplace.json and an empty README [V].
- The hub is a separate repo (head 08f23dc). One poller long-polls getUpdates (hub.ts:281, 1690-1730); two pollers on one token give HTTP 409; the offset is persisted per bot (poll-offset.ts) [V].
- Listens on 127.0.0.1 only via Bun.serve (hub.ts:486-489). WebSocket path `/ws` (:563-565). HTTP: /health, /hook, /turn-end, /turn-failed, /question (:568-611). An Origin header gives 403. No authentication [V].
- Plugin to hub: hello{v,windowKey,sessionId,cwd,configDir?,busy?,entrypoint?,title?}, session, send, sendFiles, req{enable|disable|download}, permission, title, card, seen, busy, caughtUp. Hub to plugin: state, inbound, res, ack, filesSent, switchSession, permissionReply, turnEnd, turnFailed, catchUp, language (protocol-schema.ts:13-51) [V].
- A non-Claude WebSocket client can speak the protocol (hub.ts:801-807); a file spool ingests JSON files (hub.ts:1608-1630) [V].
- Buttons exist only in hub-owned features (questions, permissions, /rig confirmations). No generic custom button or callback [V].
- Fixed bot commands: /run /stop /cleanup /mode /info /compact /rename /pwsh /cmd /bash and /rig forms (router.ts:73, 90). No API to add a menu command; other /commands arrive as plain messages [V].
- Access: chat.id equals groupId, non-bot sender, id in allowFrom (router.ts:25-42, 58-66) [V].
- /bash, /pwsh, /cmd run arbitrary text through `rig exec` for allowFrom users; /rig commands act on the hub host's Rig [V].
- A remote server cannot reach the PC's hub; with the PC off nothing serves the bot [V/I].
- Needs a hub change: new buttons or callbacks, new menu commands, Agent Factory job cards, any non-loopback access, a second consumer of the bot token [I].

## 6. Enforced by code versus prompt text only

Enforced by code:
- no_ampersand.py (base/feature.json:427-433), system-temp-guard.py (:434-440) [V].
- subagent-tasks-guard (fails open) [V].
- Account allowlist, `--approved` flag check, Codex model/effort gates, volunteer cwd allowlist in the scripts [V].
- Volunteer OpenCode permission map [V].
- Settings written by the codex feature (features/codex/feature.json:120-140): permissions.allow for codex-run.py, permissions.deny `Agent(codex:codex-rescue)` [V].
- Exec and session stop verification by pid plus creation time [V].
- Hub access check by chat id and allowFrom [V].

Prompt text only:
- Codex must not commit or push (RUN_RULES, codex-run.py:126-145, 513) [V].
- Meaning of `--approved`, report format, Windows shell rules, Telegram mode rules, delegation rules, tier choices [V].

Not limited by Rig:
- Network access of Codex jobs (sandbox default workspace-write is inferred) [I]; cwd of Codex jobs (no allowlist) [V]; who may start jobs [V].

## 7. Tests, Docker, versions, platforms, specs

### 7.1 Tests
- `bun test` with root ./tests; plugin tests excluded (bunfig.toml:1-3). tsconfig strict, noEmit, includes src and tests. Scripts: test, typecheck (package.json:6-9) [V].
- About 73 test files; helpers in tests/helpers (isolated home); fake runtime tests/fakes/memory-runtime.ts with fixed FAKE_TIME and no-op sleep [V].
- Real-process tests are `*-real.test.ts`. tests/live is gated by RIG_LIVE=1 and runs a real `claude -p --model haiku` (Claude Code 2.1.325, session-live.test.ts:29), which costs money [V].
- No CI [V].
- Docker: docker/ubuntu-24.04/Dockerfile, fakes in docker/fakes, scenarios tests/docker/01-09 via run-all.sh; scripts/test-docker.sh installs the latest bun unpinned; scripts/prepare-server.sh is root server prep. Docker Compose is not used. Docker tests are Linux only [V].

### 7.2 Fit of a second package
- Single package.json, devDependencies only, no workspaces [V].
- `bun test` sees only ./tests; tsc includes only src and tests [V].
- The update test copies only src, base, features, plugins, package.json, tsconfig.json (tests/update-real.test.ts:15) [V].
- tests/no-cyrillic.test.ts:19 scans all tracked files (`git ls-files`); other repo-wide scans: tests/command-wiring.test.ts:597-604, message-catalogue-guard.test.ts:122 [V]. New tracked files must be English only and pass these scans.

### 7.3 Versions
- No Bun version pinned (bun:ffi, Bun.stdin, Bun.argv used). @types/bun and typescript are "latest" (resolved typescript 5.9.3) [V].
- Claude Code 2.1.314 in the spec, 2.1.325 in tests [V].

### 7.4 Existing specs
- docs/superpowers/specs/agent-rig-design.md (641 lines), rig-exec-design.md (57), rig-sessions-design.md (183); docs/research/claude-pid-from-hook.md, rig-owns-actions-recon.md; docs/content-index.md; README.md (97), INSTALL.md (233) [V].
- Spec :576 names `scripts/restart-hub.ps1`; it does not exist (scripts/ holds plugin-fingerprint.ts, prepare-server.sh, test-docker.sh) [V].

### 7.5 Conflicts with a server, worker or database
- Persistent process: README.md:7 and spec :38 say "no permanent process". Already present in practice: exec runner, hourly cron, hub service [V].
- Server component: spec :39 says the hub is separate [V].
- State only in `~/.agent-rig`: spec :52-56, :638. Already broken by the paths listed in 2.5 [V].
- Database: none today; state is JSON and JSONL [V].
- Web UI: none; output is JSON only [V].
- Multi-user: features are machine-wide [V].
- Self-modification: Rig writes rules, settings and agents into `~/.claude` [V].

## 8. External facts

Confidence: H = official doc or repo page read directly, M = secondary or inferred, L = weak. Research was done on the web only.

### 8.1 Temporal and Bun
- Worker officially supports Node 20, 22, 24; README: "we strongly discourage running Temporal Workers in anything except authentic Node.js". Worker needs Node-API native modules, worker_threads, vm, AsyncLocalStorage. https://raw.githubusercontent.com/temporalio/sdk-typescript/main/README.md (H). engines.node ">= 20.3.0" for @temporalio/worker 1.26.0: https://raw.githubusercontent.com/temporalio/sdk-typescript/main/packages/worker/package.json (H).
- Client alone is "believed to work properly" on Bun; not regularly tested; use at own risk (same README, H).
- Experimental Bun Worker support since SDK 1.15.0 (M). SDK 1.23.0 "Fixed compatibility with Bun 1.4", still experimental, repo pins Bun 1.3.14. https://github.com/temporalio/sdk-typescript/releases/tag/v1.23.0 (H). No release note calls Bun support stable.
- Issue 2608 (closed, not planned): SDK 1.25.0 on Bun 1.4.4 on Windows x64 works for native bridge, webpack bundling, Worker.create, workflow isolate; promise-stack diagnostics disabled (v8.promiseHooks missing in Bun). https://github.com/temporalio/sdk-typescript/issues/2608 (M-H).
- Same issue: on Windows a relative workflowsPath gives a backslash entrypoint webpack cannot resolve; an absolute forward-slash path works around it, on Node and Bun (M).
- Issue 2627 (open): a Worker built with `bun build --compile` is non-functional; workflow thread entry not bundled; a prebuilt `workflowBundle: {codePath}` works. https://github.com/temporalio/sdk-typescript/issues/2627 (H).
- Bun postMessage buffer-detach bug (Bun issue 18705) is worked around in the SDK (M). One forum report of activities not scheduling after the first under Bun, fixed by Node, cause unknown (M). https://community.temporal.io/t/activities-not-scheduled-after-first-activity-completes/18185
- Windows x64 official platform matrix: not found. Only 119 GitHub results for Bun issues were sampled (first page) [?].

### 8.2 Versions
- Temporal Server 1.32.2 (latest). https://github.com/temporalio/temporal/releases (H). 1.32 is the last release with the deprecated Build-ID versioning APIs; removed in 1.33 together with the legacy visibility query converter.
- TypeScript SDK 1.26.0. https://github.com/temporalio/sdk-typescript/releases (H). Temporal UI 2.58.1. https://github.com/temporalio/ui/releases (H).
- PostgreSQL versions tested for persistence: 13.18, 14.15, 15.10, 16.6; newer majors not listed. https://docs.temporal.io/temporal-service/persistence.md (H).
- SQL visibility works on PostgreSQL 12+ (since server 1.20); Elasticsearch/OpenSearch optional. https://docs.temporal.io/self-hosted-guide/visibility (H).
- Crossing 1.30 or 1.31 on PostgreSQL rebuilds executions_visibility (can take hours); use 1.30.5+ or 1.31.3+, keep up to twice the table size free. https://docs.temporal.io/self-hosted-guide/upgrade-server.md (H).

### 8.3 Docker Compose and operations
- Official compose files (samples-server, folder compose) are "intended for local development and testing". https://github.com/temporalio/samples-server/tree/main/compose (H).
- Images: temporalio/server, admin-tools, ui. Postgres compose runs an admin-tools setup container (setup-postgres.sh) that the server waits for, plus a create-namespace container. https://raw.githubusercontent.com/temporalio/samples-server/main/compose/docker-compose-postgres.yml (H).
- `temporalio/auto-setup` is deprecated and unmaintained. https://hub.docker.com/r/temporalio/auto-setup (H).
- Schema updates are manual with admin-tools. https://docs.temporal.io/self-hosted-guide/deployment.md (H).
- Upgrade one minor version at a time at its latest patch: persistence schema, then visibility schema (temporal-sql-tool update-schema), then binary. Schema tools only move forward; rollback is binary only; numHistoryShards must stay unchanged (H).
- Config template is embedded in the binary from 1.30; Helm chart 0.73.1+ for 1.30+ images (H).
- Minimum RAM/CPU: no official figure. A staff post gives medium-to-large baselines (frontend 1.5-2 CPU/4 GiB, history 4 CPU/6+ GiB, matching 1 CPU/2 GiB, worker 0.5-1 CPU/1 GiB). https://community.temporal.io/t/baseline-server-resource-consumption/19267 (M). A user measured `start-dev` near 112 MB (L-M). No reliable small single-node figure.

### 8.4 Security
- Without an Authorizer, Temporal uses noopAuthorizer: every API request allowed. Port 7233 is open by default; plain gRPC is cleartext unless TLS is set (M). https://docs.temporal.io/self-hosted-guide/security.md (H).
- mTLS in internode and frontend sections; clientCAFiles/clientCAData plus requireClientAuth restrict clients (H).
- Default JWT ClaimMapper reads the "permissions" claim (`<namespace>:<role>`, roles read, write, worker, admin; temporal-system reserved), JWKS key provider, Bearer tokens (H). Whether the default claim mapper is a noop: not stated.
- With default authorizer and claim mapper the system worker needs an internal-frontend (M). https://community.temporal.io/t/how-does-internal-service-auth-work-with-default-authorizer-claim-mapper/18610
- API keys are documented for Temporal Cloud only (https://docs.temporal.io/cloud/api-keys.md). The TS client has an `apiKey` option (Bearer, enables TLS) (M). No official self-hosted API-key recipe found.
- UI auth needs TEMPORAL_AUTH_ENABLED=true plus an OIDC provider; otherwise none (H). UI-to-server mTLS [?].
- Docs: secure the service like a database; do not expose it to the public internet (H).

### 8.5 Semantics
- Heartbeat timeout: max time between heartbeats; expiry fails the attempt and retries; 0 disables; capped at Start-To-Close. https://docs.temporal.io/encyclopedia/detecting-activity-failures.md (H).
- Heartbeats are throttled: interval is the smaller of 0.8 x heartbeatTimeout and 60 s (default 30 s); the last one before failure is sent unthrottled; details reach the next attempt (H).
- Activity cancellation is delivered only on heartbeat; an activity that never heartbeats cannot be cancelled; throttling can delay it (H).
- No documented limit on hours-long activities; Start-To-Close must cover the whole attempt [?].
- Async completion in TS: `activityInfo().taskToken`, `throw new CompleteAsyncError()`, `client.activity.complete(taskToken, result)`. https://docs.temporal.io/develop/typescript/activities/asynchronous-activity.md (H); one forum report that the doc example failed (L).
- TS SDK has no Sessions API (Go only); worker-specific task queues are built with a unique per-host queue name and scheduleToStartTimeout (M-H). https://docs.temporal.io/design-patterns/worker-specific-taskqueue
- Updates are deduplicated server-side by Update ID per run (after Continue-As-New dedupe in workflow code); signals have no ID dedup; update validators can reject before history; an update failure does not fail the workflow. https://docs.temporal.io/handling-messages.md (H). Behaviour of a resent Update ID and its retention: not found.
- History limits: warning at 10,240 events; terminated above 51,200 events, 2,000 updates or 10,000 signals. https://docs.temporal.io/workflow-execution/event.md (H). Size: warning 10 MB, error 50 MB; single payload warning 512 KB, error 2 MB. https://docs.temporal.io/self-hosted-guide/defaults.md (H). Continue-As-New is the remedy.
- Worker Versioning (Worker Deployments): Pinned and Auto-Upgrade; needs TS SDK 1.12+, Server 1.29.1+, CLI 1.4.1+, UI 2.38.0+. https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning.md (H). GA status not stated.

### 8.6 Codex CLI
- `codex exec` is the official non-interactive mode with --json, --output-schema, -o, and a TypeScript SDK; API-key auth via CODEX_API_KEY is the recommended default for automation; ChatGPT-plan login in CI is an advanced path for trusted runners; `~/.codex/auth.json` is to be treated like a password. https://learn.chatgpt.com/docs/non-interactive-mode (H).
- OpenAI API terms for programmatic use: not checked [?].

## 9. Local tools and generators

The inventory of a developer PC is kept outside this public repository. What the design uses: one GPU shared by all
generators; ComfyUI 0.28.0 has an HTTP and WebSocket API to queue, watch and cancel a job and to fetch files
(`ComfyUI/server.py`) [V]; LM Studio ships the `lms` command-line tool [V]; a tool may be installed but absent from
PATH (adb inside the Unity Android module), so the worker takes tool paths from its settings and checks them.

## 10. Reuse table for AgentAdapter

Claude column: existing Rig function (file:line) and fit. Codex column likewise. "partial" = something usable but not the operation; "missing" = nothing.

| Operation | Claude | Codex |
|---|---|---|
| getCapabilities | missing; nearest findCswap session-run.ts:58, prepareLaunch :60 | partial; model gate and cache read codex-run.py:62, 262-278; no capability query |
| validateEnvironment | partial; prepareLaunch session-run.ts:60-98, resolveLaunch :154-170, `rig check` src/commands/check.ts | partial; account_allowlist refusal :499, 640; model and approval checks :501-504; `check` covers the managed codex program |
| start | missing for a new run; resume runSession session-run.ts:172, runCommand :200; generic shell startExec exec-core.ts:352 | partial; `start` codex-run.py:498-524 (detached supervisor, text output) |
| attach | missing for a live process; resume of a stopped session is runSession | partial; attach :608-628 (sets blocked, does not respawn supervisor) |
| getStatus | partial; lookupSession session-core.ts:134, readSession :75, sessionLive :115, liveProcesses :106, listSessions :165; exec statusExec exec-core.ts:355, listExecs :356 | partial; state.json fields :321-324, 356-357, 514-518; `wait` digest; `list` |
| streamOutput | missing for Claude; exec statusExec from/wait exec-core.ts:247 for shell runs; transcript path SessionRecord.transcriptPath session-core.ts:30 | partial; events.jsonl, digest_offset, `wait` (unversioned schema) |
| cancel | partial; stopSession session-stop.ts:70, endSession :20; exec stopExec exec-core.ts:354 | partial; `cancel` :660-681 (15 s wait, then kill supervisor) |
| collectResult | missing; helpers transcriptMode session-run.ts:100, transcriptHeadCwd session-core.ts:35; exec `result` exec-core.ts:262 | partial; last.md, `STATUS:` validation base/tools/run-report.py:21-56 |
| cleanup | partial; cleanupSession session-cleanup.ts:12, removeSessionUnlessEnding session-ending.ts:91, exec pruning exec-core.ts:192-202 | partial; 14 day terminal job deletion codex-run.py:78, 470-477 |

## 11. Not verified (merged)

- macOS support for process creation time (`createdAt`) and macOS service paths.
- cswap behaviour (account switching tool).
- Real Windows Terminal launch behaviour and behaviour after a real reboot.
- Body of tests/session-ports-guard.test.ts.
- Whether Rig or the hub script creates the hub systemd unit (reports differ; Rig only starts and restarts it).
- Whether plugin installs and managed programs survive a rollback unchanged.
- Codex sandbox network defaults; the structure of Codex events.jsonl across versions.
- Windows x64 as an officially supported platform for the Temporal TypeScript Worker; other open Bun issues beyond the first result page.
- Temporal: default claim mapper being a noop, UI-to-server mTLS settings, resent Update ID behaviour and retention, any limit on hours-long activities, GA status of Worker Versioning, PostgreSQL majors above 16.
- Temporal single-node minimum RAM and CPU (no official figure).
- OpenAI API terms for programmatic use.
- ComfyUI authentication; LM Studio image generation usability; AI Toolkit version.
- Deeper search for other generators on D: and E:, Docker volumes, WSL, other profile folders.

Disagreements between reports settled by code:
- One report said rig-exec-design.md was not found: it exists at docs/superpowers/specs/rig-exec-design.md (57 lines) [V].
- Reports 1 and 5 differ on lock use by exec and session commands: src/lock.ts users are language.ts, shared.ts, update.ts, output.ts and session-ending.ts; exec-core.ts and session.ts do not take rig.lock [V by grep].
