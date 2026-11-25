# Provider terms for a private, single-owner headless setup

Scope: one owner, own PC now and a rented server later, Claude Code and Codex CLI run headlessly, no resale, no third-party users.
All pages fetched 2026-11-25. Quotes are verbatim from fetch summaries. Anthropic consumer-terms section numbers were re-checked on 2026-11-25 (see the rows).
Lines marked (interp.) are interpretation, not text.

## Anthropic

| Topic | What the text says | Source | Fetched |
|---|---|---|---|
| Which terms apply | "Consumer Terms of Service - for Free, Pro, Max, and Ultra users" govern Claude Code; Commercial Terms govern Team, Enterprise, API | https://code.claude.com/docs/en/legal-and-compliance | 2026-11-25 |
| Automation, consumer | Users may not "access the Services through automated or non-human means, whether through a bot, script, or otherwise", except "via an Anthropic API Key or where we otherwise explicitly permit it." (3.7) | https://www.anthropic.com/legal/consumer-terms | 2026-11-25 |
| Documented headless use | `claude -p` is documented for "scripts and CI/CD"; `--permission-prompts none` is for "a scheduled job" | https://code.claude.com/docs/en/headless | 2026-11-25 |
| Subscription token | `claude setup-token`: "a one-year OAuth token" for "CI pipelines, scripts, or other environments where interactive browser login isn't available". "This token authenticates with your Claude subscription" | https://code.claude.com/docs/en/authentication | 2026-11-25 |
| Intended use of OAuth | "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." | legal-and-compliance (above) | 2026-11-25 |
| Usage limits | "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK." | legal-and-compliance | 2026-11-25 |
| Products and Agent SDK | "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication ... Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens." | legal-and-compliance | 2026-11-25 |
| Agent SDK login | "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." SDK is "governed by Anthropic's Commercial Terms of Service" | https://code.claude.com/docs/en/agent-sdk/overview | 2026-11-25 |
| Own binary, own login | The page "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription" | legal-and-compliance | 2026-11-25 |
| Bare mode | Bare mode "doesn't use your subscription login"; needs `ANTHROPIC_API_KEY` or `apiKeyHelper` | headless (above) | 2026-11-25 |
| Account sharing | "You may not share your Account login information, Anthropic API key, or Account credentials"; no "make your Account available to anyone else" (2) | consumer-terms | 2026-11-25 |
| Multiple machines, parallel | No text found limiting machines or parallel sessions; multiple accounts use separate `CLAUDE_CONFIG_DIR`; limits are plan usage limits. The authentication page has no sentence on servers, scheduled or background subscription use | https://code.claude.com/docs/en/authentication | 2026-11-25 |
| Token scope | `setup-token` token "can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors"; "Renewing early matters most for sessions that run unattended" (login expiry) | authentication | 2026-11-25 |
| `-p` billing source | "when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits." (update of Oct 7, 2026); June 15, 2026 update: "We've paused the previously-announced changes to Claude Agent SDK usage." Plan credits (Max/Ultra/Team) apply only "when you run them with an API key from your linked Claude Console organization" and "can't be used in Claude Code or the Claude apps" | https://support.claude.com/en/articles/15036540-use-the-claude-plan-usage-limits ; https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans (search summary, not fetched) | 2026-11-25 |
| Scheduled / server / multi-machine, official | Not found. Only cloud scheduled tasks (Anthropic-hosted) are documented as counting against plan usage; nothing about own scheduler, own server or several machines for a subscription | https://code.claude.com/docs/en/routines.md (search hit, not fetched) | 2026-11-25 |
| PermissionRequest hook | Event fires "When a tool call needs a permission decision". Output: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{...}}}}`. `decision` fields: `behavior` ("allow" or "deny"; "The hook can't approve what a deny rule refuses, unless a mod overrides the rule"), `updatedInput` (allow only; replaces the whole input, re-checked against deny and ask rules), `updatedPermissions` (allow only; permission update entries), `message` (deny only; tells Claude why), `interrupt` (deny only; if `true`, stops Claude). "Claude Code doesn't read exit code 2 as a decision on this event." The page shows no deny example; a deny is `behavior: "deny"` plus optional `message`, `interrupt` (interp. from the field table) | https://code.claude.com/docs/en/hooks.md | 2026-11-25 |
| Hooks in `-p` | "In a `-p` run outside `dontAsk` mode with neither a `--permission-prompt-tool` nor a `canUseTool` callback, nobody can answer a prompt. A call that would prompt you is denied there unless something approves it, such as a PermissionRequest hook." So PermissionRequest hooks do fire in `-p`. With a prompt tool or callback "the hooks run alongside your host, and whichever decides first applies" | hooks.md | 2026-11-25 |
| PreToolUse in `-p` | Same JSON as elsewhere: `hookSpecificOutput.permissionDecision` (`deny` with `permissionDecisionReason`, `allow`, ask); exit 2 blocks and stderr is the reason; exit 0 with no output is no decision. `"defer"` is honored only in `-p` and only when Claude makes a single tool call in the turn: it ends the turn with `stop_reason: "tool_deferred"` and the caller resumes with `claude -p --resume <session-id>`. Page parts after char 200000 not read | hooks.md | 2026-11-25 |
| Section numbers (verified) | Section 3 intro: "You may not access or use, or help another person to access or use, our Services in the following ways:"; item 2 competing/train/resell, item 3 reverse engineering, item 4 scraping, item 7 automation; account sharing is section 2; non-commercial is section 11; "bypassing any of our systems or protective measures" is in the unnumbered paragraph after the Section 3 list, not an item | consumer-terms | 2026-11-25 |
| Non-commercial use (section 11) | "Non-commercial use only. You agree that you will not use our Services for any commercial or business purposes". No exceptions in the section; no Claude Code or API carve-out for it. Preamble: Commercial Terms govern API-key use, "For clarity, this does not include Claude.ai or Claude Pro use for individuals or entities." | consumer-terms | 2026-11-25 |
| Competing, training | No use "To develop any products or services that compete with our Services" or "to develop or train any artificial intelligence or machine learning algorithms or models" (3.2); Usage Policy bars "Use outputs to train an AI model" without authorization | consumer-terms; https://www.anthropic.com/legal/aup | 2026-11-25 |
| Reverse engineering, scraping | No "decompile, reverse engineer, disassemble" (3.3); no "crawl, scrape, or otherwise harvest data" (3.4) | consumer-terms | 2026-11-25 |
| Bypass | "bypassing any of our systems or protective measures"; usage caps are "technical restrictions" for paid plans; AUP: "Intentionally bypass or interfere with capabilities, restrictions, or guardrails" | consumer-terms; AUP | 2026-11-25 |
| Resale, commercial | No "resell the Services" (3.2); "not use our Services for any commercial or business purposes" (11). Commercial: "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf" | consumer-terms; legal-and-compliance | 2026-11-25 |
| Data use | Anthropic may train on Materials "unless you opt out of training through your account settings" (consumer); Commercial B: "Anthropic may not train models on Customer Content from Services." | consumer-terms; https://www.anthropic.com/legal/commercial-terms | 2026-11-25 |
| Branding | "Claude Code" naming is not permitted for your own product | agent-sdk/overview | 2026-11-25 |

## OpenAI

| Topic | What the text says | Source | Fetched |
|---|---|---|---|
| Auth choice | "Sign in with ChatGPT for subscription access." With an API key "Codex uses standard API pricing instead of included ChatGPT plan credits." | https://learn.chatgpt.com/docs/auth (redirect from developers.openai.com/codex/auth) | 2026-11-25 |
| Automation default | "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs." "API keys are still the recommended default for automation." | auth (above) | 2026-11-25 |
| ChatGPT login in CI | "The right way to authenticate automation is with an API key. Use this guide only if you specifically need to run the workflow as your Codex account." "This is an advanced workflow for enterprise and other trusted private automation." | https://learn.chatgpt.com/docs/auth/ci-cd-auth | 2026-11-25 |
| Server / CI limits | "Do not use this workflow for public or open-source repositories." "Access tokens are intended for trusted scripts, schedulers, and private CI runners." "Don't expose Codex execution in untrusted or public environments." | ci-cd-auth; auth | 2026-11-25 |
| Scope of the CI guide | The guide's own scope sentences: "This guide shows how to keep ChatGPT-managed Codex auth working on a trusted CI/CD runner"; "Use this guide only when all of the following are true:"; seeding happens "On a trusted machine where browser login is possible". It never says "runners only" nor contrasts with local runs. The "public or open-source repositories" and "concurrent jobs or multiple machines" sentences sit inside this CI/CD workflow. (interp.: they are written for the CI workflow of the guide; a local interactive login on the owner's PC is the ordinary flow of the auth page, not this guide) | https://learn.chatgpt.com/docs/auth/ci-cd-auth | 2026-11-25 |
| `codex exec` auth | "`codex exec` reuses saved CLI authentication by default." ChatGPT-managed auth is for CI jobs that "run CI/CD jobs with a Codex user account instead of an API key"; "API keys are the right default for automation because they are simpler to provision and rotate."; use the ChatGPT path "only if you specifically need to run as your Codex account."; "Do not use this workflow for public or open-source repositories." `CODEX_API_KEY` works with `codex exec`. Parallel `codex exec` runs: no guidance on the page | https://learn.chatgpt.com/docs/non-interactive-mode (also listed as developers.openai.com/codex/non-interactive-mode) | 2026-11-25 |
| Machines, parallel | "Use one `auth.json` per runner or per serialized workflow stream." "Do not share the same file across concurrent jobs or multiple machines." Refresh when `last_refresh` older than ~8 days; reseed from a trusted machine | ci-cd-auth | 2026-11-25 |
| Credential handling | "Treat `~/.codex/auth.json` like a password"; headless login: device-code (beta) preferred, or log in elsewhere and copy `auth.json` | auth | 2026-11-25 |
| Account sharing | "may not share your account credentials or make your account available to anyone else" | https://openai.com/policies/terms-of-use/ (EU version) | 2026-11-25 |
| Harness in own products | App Server is "a client-friendly, bidirectional JSON-RPC API"; partners "embed the same harness in their own products"; SDK is "A TypeScript library for programmatically controlling local Codex agents from within your own application." No terms stated | https://openai.com/index/unlocking-the-codex-harness/ | 2026-11-25 |
| Plan usage in apps | Eligible Go/Plus/Pro/Business users may let supported apps use their plan: "Allow this app to consume usage from your ChatGPT Plan's limits."; "App usage counts toward your existing plan limits."; "Connecting an app does not add a new allowance." | https://learn.chatgpt.com/docs/sign-in-with-chatgpt | 2026-11-25 |
| Automation, scraping | Prohibited: "Automatically or programmatically extracting data or Output" | terms-of-use | 2026-11-25 |
| Reverse engineering, limits | No "reverse engineer, decompile or discover the source code"; no "circumventing any rate limits or restrictions" | terms-of-use | 2026-11-25 |
| Competing | "Using Output to develop models that compete with OpenAI." | terms-of-use | 2026-11-25 |
| Resale | No "Modifying, copying, leasing, selling or distributing any of our Services." | terms-of-use | 2026-11-25 |
| US terms | The main Terms of Use (effective January 1, 2026) apply outside EEA/Switzerland/UK: "If you reside in the European Economic Area, Switzerland, or the UK, your use of the Services is governed by" the EU terms; main Terms under California law. Same wording as the EU row on: "You may not share your account credentials or make your account available to anyone else."; "Automatically or programmatically extract data or Output"; "circumvent any rate limits or restrictions"; "Use Output to develop models that compete with OpenAI."; "Modify, copy, lease, sell or distribute any of our Services." No extra automation or sharing clause found | https://openai.com/policies/row-terms-of-use/ | 2026-11-25 |
| Business terms | "Our Business Terms govern use of ChatGPT Enterprise, our APIs, and our other services for businesses and developers." | terms-of-use | 2026-11-25 |
| Services Agreement scope | "This OpenAI Services Agreement only applies to use of OpenAI's APIs, ChatGPT Enterprise, ChatGPT Business, ChatGPT for Clinicians, and other services for customers who are businesses and developers, and does not apply to OpenAI services used by consumers or individuals unless specified above." Codex not named; Plus/Pro not named (interp.: a personal Plus/Pro plan falls under the Terms of Use). Business Terms page not fetched | https://openai.com/policies/services-agreement/ | 2026-11-25 |
| Codex output | "Output generated by code generation features of our Services, including OpenAI Codex, may be subject to third party licenses" | https://openai.com/policies/service-terms/ | 2026-11-25 |

## Both: consumer web interfaces and undocumented APIs

Both consumer terms ban bot/script/programmatic access except through the official API or explicit permission (Anthropic 3.7, OpenAI "Automatically or programmatically extracting data or Output"), ban reverse engineering, scraping, and rate-limit circumvention. Neither page names undocumented endpoints; the bans above are the only text. (interp.) A client that drives claude.ai or chatgpt.com web UIs, or calls their private endpoints with session tokens, falls under these bans.

## Not settled by the text

- Whether unattended `claude -p` on a subscription falls under the 3.7 "explicitly permit" exception. The docs promote `-p` and `setup-token` for scripts, but no sentence ties that to consumer terms.
- Whether a rented server counts as the same "individual" use, or whether one OAuth token on two machines is "making your Account available". No multi-machine rule found for Claude; for Codex the rule is per-runner `auth.json`.
- Whether an own orchestrator on the Agent SDK with subscription OAuth, for the owner only, is allowed. The text forbids offering login to others; owner-only use is not addressed.
- Where "ordinary, individual usage" ends for heavy parallel, round-the-clock use.
- Whether the Anthropic consumer-terms section 11 "commercial or business purposes" ban bites an orchestrator that builds software for the owner's business or a public repository. The text has no exception and no definition; the preamble routes only API-key use to Commercial Terms. This is the strongest open point for Claude on a subscription; an API key for Claude would remove it. Scope: the page read is the edition of Anthropic Ireland, "These Terms apply to you if you are a consumer who is resident in the European Economic Area or Switzerland." (the server chose it). The edition for other countries was not read, so whether the clause binds the owner depends on the country of residence.
- Whether Codex CI-guide rules (public repos, no sharing across concurrent jobs or machines) bind local runs on the owner's PC. The guide frames itself as a CI/CD runner workflow; no sentence extends it to local runs, none excludes them.
- Official statement on subscription Claude Code in own scheduled or background runs, on several machines or on a server: not found.
- OpenAI Business Terms page not fetched; the Services Agreement excludes individual consumer use, so only relevant if the owner moves to a Business plan.
- Hooks page read to char 200000 of 301722; the exact `-p` behaviour of PermissionRequest beyond the quoted paragraph is not checked.

## Consequences for the design

Allowed as designed (interp.):
- Owner's own logins on own PC: `claude -p`, `codex exec` (reuses the saved CLI login by default), PermissionRequest hooks (documented; they fire in `-p` and are the documented way to approve prompts there), own orchestrator spawning the unmodified binaries. `claude -p` on a subscription still draws from plan limits (help center, Oct 7, 2026).
- Parallel sessions: no text forbids them; the limit is the plan's usage limits.
- `setup-token` on a private rented server for Claude (documented for scripts), `auth.json` on a private runner for Codex.

Needs a change:
- Claude section 11 risk: if the factory's output serves the owner's business, the consumer terms ("not use our Services for any commercial or business purposes") may be a live conflict (interp.; only if the owner's edition has the clause, see above); decide between an API key for Claude or written confirmation from Anthropic.
- One Codex `auth.json` per runner or serialized stream; never copy one file to several machines or concurrent jobs (the rule is written for CI; on one PC, local runs share the one saved login; do not copy it to the server, log in there separately).
- Do not build on the Agent SDK with subscription login beyond owner-only use; use an API key for any SDK component, and for Codex automation prefer an API key (the docs' recommended default).
- Orchestrator must not collect, store or relay claude.ai credentials or session tokens beyond the official token variable.
- Do not name the product "Claude Code".
- Before moving to a rented server, ask Anthropic support in writing about server and multi-machine use of a subscription token.
- Opt out of training in account settings if outputs or code must not be used.

Forbidden:
- Offering either login or subscription to any other user; reselling or routing others' usage through the owner's plan.
- Sharing credentials or `auth.json`/token with others.
- Driving web UIs, scraping, or using private endpoints with session tokens.
- Circumventing rate limits or usage caps (extra accounts to dodge limits included).
- Training models on outputs; building a competing product.
- Public or open-source repositories on ChatGPT-login automation.
