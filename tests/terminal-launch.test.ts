import { expect, test } from "bun:test";
import { buildLaunchCommand } from "../src/launch-command.js";
import { prepareLaunch, runSession } from "../src/commands/session-run.js";
import { apiOk } from "../src/output.js";
import { baseManifest, createMemoryRuntime, seedFeature, seedHubManifest } from "./fakes/memory-runtime.js";

test("a remote session starts a detached supervisor with literal cwd and its original history", () => {
  const facts = { platform: "windows" as const, cwd: "C:/work/a;b", session: "session-id", account: "", mode: "auto", plugins: ["telegram-hub@telegram-hub"], cswap: null, terminal: null, tmux: null,
    relay: { node: "C:/tools/node.exe", script: "C:/hub/terminal/main.mjs", home: "C:/owner", transcript: "C:/history.jsonl", claude: "C:/tools/claude.exe" } };
  const command = buildLaunchCommand(facts)!;
  expect(command.slice(0, 2)).toEqual([facts.relay.node, facts.relay.script]);
  const payload = JSON.parse(Buffer.from(command[2], "base64url").toString());
  expect(payload).toEqual({ session: "session-id", cwd: "C:/work/a;b", home: "C:/owner", transcript: "C:/history.jsonl", command: "C:/tools/claude.exe",
    args: ["--dangerously-load-development-channels", "plugin:telegram-hub@telegram-hub", "--resume", "session-id", "--permission-mode", "auto"] });
  expect(command).not.toContain("wt.exe");
});

test("the supervisor preserves the selected cswap account", () => {
  const command = buildLaunchCommand({ platform: "linux", cwd: "/work", session: "one", account: "2", mode: null, plugins: [], cswap: "/bin/cswap", terminal: null, tmux: null,
    relay: { node: "/bin/node", script: "/hub/terminal/main.mjs", home: "/home/owner", transcript: null, claude: "/bin/claude" } })!;
  expect(JSON.parse(Buffer.from(command[2], "base64url").toString()).args).toEqual(["run", "2", "--share-history", "--", "--resume", "one"]);
});

test("run returns a supervised startup before Claude can run its registration hook", async () => {
  const h = createMemoryRuntime();
  const id = "11111111-1111-1111-1111-111111111111";
  h.fs.directories.add("/work");
  h.fs.seed(`${h.runtime.home}/.agent-rig/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: { telegram: true }, records: {}, badPairs: [], pendingHubRestart: null }));
  seedFeature(h.fs, "/repo", { ...baseManifest(), name: "telegram", plugins: ["telegram-hub"] });
  seedHubManifest(h.fs, "/hub", "telegram-hub");
  for (const file of ["/hub/terminal/main.mjs", "/hub/terminal/node_modules/node-pty/package.json", "/usr/bin/node", "/usr/bin/claude"]) h.fs.seed(file, "");
  const record = `${h.runtime.home}/.agent-rig/terminals/${id}.json`;
  h.fs.seed(record, JSON.stringify({ session: id, generation: "previous-run", childPid: 123 }));
  const result = await runSession(h.runtime, { id, cwd: "/work", transcriptPath: "/transcript", startedAt: "2026-01-01", processes: [] }, "auto", "", async command => {
    expect(command[0]).toBe("/usr/bin/node");
    h.fs.seed(record, JSON.stringify({ session: id, generation: "current-run", childPid: 456 }));
    return apiOk(h.runtime.clock.now().getTime());
  });
  expect(result).toEqual(apiOk({ session: id, pid: 456, mode: "auto", account: null, terminal: true }));
});

test("Windows remote launches resolve an npm Claude shim instead of passing an unresolved bare command", async () => {
  const h = createMemoryRuntime("windows");
  const id = "11111111-1111-1111-1111-111111111111";
  h.fs.directories.add("C:/work");
  h.fs.seed(`${h.runtime.home}/.agent-rig/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: { telegram: true }, records: {}, badPairs: [], pendingHubRestart: null }));
  seedFeature(h.fs, "/repo", { ...baseManifest(), name: "telegram", plugins: ["telegram-hub"] });
  seedHubManifest(h.fs, "/hub", "telegram-hub");
  for (const file of ["/hub/terminal/main.mjs", "/hub/terminal/node_modules/node-pty/package.json", "C:/bin/node.exe", "C:/bin/claude.cmd"]) h.fs.seed(file, "");
  const result = await prepareLaunch(h.runtime, { id, cwd: "C:/work", transcriptPath: "/transcript", startedAt: "2026-01-01", processes: [] }, "", null, null);
  expect(result.ok).toBe(true);
  if (result.ok) expect(JSON.parse(Buffer.from(result.value[2], "base64url").toString()).command).toBe("C:/bin/claude.cmd");
});
