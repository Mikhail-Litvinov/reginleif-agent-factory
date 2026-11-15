import type { RuntimePorts } from "../src/ports.js";

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildShellLaunch } from "../src/exec-shell.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

// Bounds a real shell process, including profile startup.
const SHELL_TIMEOUT_MS = 15_000;
const WINDOWS_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const SPECIAL = 'echo "quoted" %PATH% !value! $HOME `literal`';
const BOM = [0xef, 0xbb, 0xbf];
const decoder = new TextDecoder();

const hasRealShell = (shell: "pwsh" | "cmd" | "bash"): boolean => {
  if (shell === "cmd") return process.platform === "win32" && Bun.which("cmd.exe") !== null;
  if (shell === "bash" && process.platform === "win32") return Bun.which(WINDOWS_BASH) !== null;
  if (shell === "pwsh") return Bun.which("pwsh") !== null || Bun.which("powershell.exe") !== null;
  return Bun.which(shell) !== null;
};

describe("shell launches", () => {
  for (const platform of ["windows", "linux"] as const) {
    for (const shell of ["pwsh", "cmd", "bash"] as const) {
      test(`${platform} ${shell} keeps command text out of argv`, async () => {
        const h = createMemoryRuntime(platform);
        h.environment.set("PATH", "/bin");
        h.fs.seed(platform === "windows" ? "/bin/pwsh.exe" : "/bin/pwsh", "");
        h.environment.set("NORMAL", "present");
        h.environment.set("claude_secret", "secret");
        h.environment.set("TELEGRAM_HUB_TOKEN", "secret");
        h.environment.set("ANTHROPIC_API_KEY", "secret");
        // A failed registry lookup exercises the clean fallback on Windows.
        h.runtime.process.run = async () => ok({ stdout: "", stderr: "", exitCode: 1 });
        const result = await buildShellLaunch(h.runtime, shell, SPECIAL, "/runs/one");
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        const launch = result.value;
        expect(launch.argv.join(" ")).not.toContain(SPECIAL);
        expect(launch.env.NORMAL).toBe("present");
        expect(launch.env.claude_secret).toBeUndefined();
        expect(launch.env.TELEGRAM_HUB_TOKEN).toBeUndefined();
        expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
        if (shell === "pwsh") {
          expect(launch.argv.slice(0, 6)).toEqual(["pwsh", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
          expect(launch.files.map((file) => [...file.bytes.slice(0, BOM.length)])).toEqual([BOM, BOM]);
          expect(decoder.decode(launch.files[0]?.bytes)).toBe(SPECIAL);
          expect(decoder.decode(launch.files[1]?.bytes)).toContain("Parser]::ParseFile");
          expect(decoder.decode(launch.files[1]?.bytes)).toContain("command.run.ps1");
        } else if (shell === "bash") {
          expect(launch.argv[0]).toBe(platform === "windows" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
          expect(launch.argv[1]).toBe("-l");
          expect(decoder.decode(launch.files[0]?.bytes)).toBe(`set -eo pipefail\n${SPECIAL}`);
          expect(launch.env.CHERE_INVOKING).toBe("1");
        } else {
          expect(launch.argv.slice(0, 4)).toEqual(["cmd.exe", "/d", "/v:on", "/s"]);
          expect(launch.argv.join(" ")).toContain("chcp 65001");
          expect(launch.env.RIG_EXEC_LINE).toBe(`"${SPECIAL}"`);
          expect(launch.verbatimArguments).toBe(true);
          expect(launch.files).toEqual([]);
        }
      });
    }
  }

  test("cmd refuses either kind of line break before looking up the environment", async () => {
    const h = createMemoryRuntime();
    for (const text of ["one\ntwo", "one\rtwo", "one\r\ntwo"]) {
      const result = await buildShellLaunch(h.runtime, "cmd", text, "/run");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("usage");
    }
    expect(h.processCalls).toEqual([]);
  });

  test("registry values merge case insensitively, expand and discard secrets", async () => {
    const h = createMemoryRuntime("windows");
    h.environment.set("SystemRoot", "C:\\Windows");
    h.environment.set("PARENT_ONLY", "no");
    const registry: Record<string, string> = {
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment": "    Path    REG_EXPAND_SZ    %SystemRoot%\\bin\n    SHARED    REG_SZ    machine\n    ANTHROPIC_KEY    REG_SZ    secret",
      "HKCU\\Environment": "    path    REG_SZ    userbin\n    shared    REG_SZ    user\n    EXPANDED    REG_EXPAND_SZ    %SHARED%\\x\n    CLAUDE_TOKEN    REG_SZ    secret",
      "HKCU\\Volatile Environment": "    Shared    REG_SZ    volatile\n    TELEGRAM_HUB_TOKEN    REG_SZ    secret",
    };
    h.runtime.process.run = async (_command, args) => ok({ stdout: registry[args[1] ?? ""] ?? "", stderr: "", exitCode: 0 });
    const result = await buildShellLaunch(h.runtime, "bash", "true", "/run");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.env.Path).toBe("C:\\Windows\\bin;userbin");
    expect(result.value.env.shared).toBe("user");
    expect(result.value.env.EXPANDED).toBe("user\\x");
    expect(result.value.env.PARENT_ONLY).toBeUndefined();
    expect(result.value.env.ANTHROPIC_KEY).toBeUndefined();
    expect(result.value.env.CLAUDE_TOKEN).toBeUndefined();
    expect(result.value.env.TELEGRAM_HUB_TOKEN).toBeUndefined();
  });
});

describe("real shells", () => {
  for (const shell of ["pwsh", "cmd", "bash"] as const) {
    test.skipIf(!hasRealShell(shell))(`${shell} emits UTF-8 lines when available`, async () => {
      const h = createMemoryRuntime(process.platform === "win32" ? "windows" : "linux");
      const runtime: RuntimePorts = {
        ...h.runtime,
        fs: { ...h.runtime.fs, stat: async (path) => { try { const stat = statSync(path); return { size: stat.size, mtimeMs: stat.mtimeMs }; } catch { return null; } } },
        environment: { get: (name) => process.env[name], entries: () => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) },
        resolvePath: (...parts) => join(...parts),
        process: {
          ...h.runtime.process,
          isAvailable: async (command) => Bun.which(command) !== null,
          run: async (command, args) => {
            const result = spawnSync(command, [...args], { encoding: "utf8", timeout: SHELL_TIMEOUT_MS });
            return ok({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 });
          },
        },
      };
      const greeting = "\u041f\u0440\u0438\u0432\u0435\u0442";
      const text = shell === "cmd" ? `echo first & echo ${greeting}` : shell === "pwsh" ? `Write-Output 'first'\nWrite-Output '${greeting}'` : `printf 'first\\n'\nprintf '${greeting}\\n'`;
      const dir = mkdtempSync(join(tmpdir(), "rig-shell-"));
      try {
        const result = await buildShellLaunch(runtime, shell, text, dir);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        const launch = result.value;
        const executable = launch.argv[0];
        if (executable === undefined) throw new Error(`No executable configured for ${shell}`);
        if (Bun.which(executable) === null) throw new Error(`Configured executable is unavailable: ${executable}`);
        for (const file of launch.files) writeFileSync(file.path, file.bytes);
        const child = spawnSync(executable, launch.argv.slice(1), { env: launch.env, encoding: "utf8", timeout: SHELL_TIMEOUT_MS, windowsVerbatimArguments: launch.verbatimArguments });
        expect(child.status).toBe(0);
        expect(child.stdout).toContain("first");
        expect(child.stdout).toContain("\u041f\u0440\u0438\u0432\u0435\u0442");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, SHELL_TIMEOUT_MS + 5_000);
  }
});
