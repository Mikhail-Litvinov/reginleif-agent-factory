import type { RuntimePorts } from "./ports.js";
import type { ApiResult } from "./output.js";

import { cleanEnvironment } from "./clean-environment.js";
import { findOnPath } from "./executable-path.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, ERROR_CODE_USAGE, EXEC_UNAVAILABLE } from "./output.js";

// Git for Windows installs bash here; on Windows the exec shell runs this bash by its full path.
const WINDOWS_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const CMD_LINE_VAR = "RIG_EXEC_LINE";
const POSIX_PATH_SEPARATOR = ":";
const WINDOWS_PATH_SEPARATOR = ";";
// Both live under the Windows system directory (SystemRoot); pwsh is searched on PATH first, these are the fallbacks.
const WINDOWS_CMD_FILE = ["System32", "cmd.exe"];
const WINDOWS_POWERSHELL_FILE = ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"];
// Limit on one `reg query` call, in milliseconds: a hung registry read must not hang an exec start.
const REG_TIMEOUT_MS = 10_000;
const MACHINE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USER_KEY = "HKCU\\Environment";
const VOLATILE_KEY = "HKCU\\Volatile Environment";
const REG_LINE = /^ {4}(.+?) {4}(REG_SZ|REG_EXPAND_SZ)(?: {4}(.*))?$/;
const VAR_REF = /%([^%]+)%/g;
const SYSTEM_VARS = new Set([
  "SystemRoot", "windir", "SystemDrive", "COMPUTERNAME", "USERNAME", "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
  "LOCALAPPDATA", "PUBLIC", "ALLUSERSPROFILE", "ProgramData", "ProgramFiles",
  "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
  "CommonProgramW6432", "NUMBER_OF_PROCESSORS", "OS", "PATHEXT", "ComSpec",
  "LOGONSERVER", "SESSIONNAME", "DriverData",
].map((name) => name.toLowerCase()));

type RegValue = { type: "REG_SZ" | "REG_EXPAND_SZ"; value: string };
type Launch = { argv: string[]; env: Record<string, string>; files: { path: string; bytes: Uint8Array }[]; verbatimArguments: boolean };

const parseRegistry = (output: string): Record<string, RegValue> => {
  const values: Record<string, RegValue> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = REG_LINE.exec(line);
    const name = match?.[1];
    const type = match?.[2];
    if (name !== undefined && (type === "REG_SZ" || type === "REG_EXPAND_SZ")) {
      values[name] = { type, value: match?.[3] ?? "" };
    }
  }
  return values;
};

const mergeEnvironment = (base: Record<string, string>, machine: Record<string, RegValue>, user: Record<string, RegValue>, volatile: Record<string, RegValue>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (SYSTEM_VARS.has(name.toLowerCase()) || /^PROCESSOR_/i.test(name)) env[name] = value;
  }
  const keyOf = (name: string): string | undefined => Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  const set = (name: string, value: string): void => {
    const old = keyOf(name);
    if (old !== undefined) delete env[old];
    env[name] = value;
  };
  const resolve = (value: RegValue): string => value.type === "REG_EXPAND_SZ" ? value.value.replace(VAR_REF, (ref, name: string) => {
    const key = keyOf(name);
    return key === undefined ? ref : env[key] ?? ref;
  }) : value.value;
  const isPath = (name: string): boolean => name.toLowerCase() === "path";
  for (const vars of [machine, volatile, user]) {
    const entries = Object.entries(vars).filter(([name]) => !isPath(name));
    for (const [name, value] of entries) if (value.type === "REG_SZ") set(name, value.value);
    for (const [name, value] of entries) if (value.type === "REG_EXPAND_SZ") set(name, resolve(value));
  }
  const machinePath = Object.entries(machine).find(([name]) => isPath(name));
  const userPath = Object.entries(user).find(([name]) => isPath(name));
  const pathName = machinePath?.[0] ?? userPath?.[0];
  if (pathName !== undefined) set(pathName, [machinePath, userPath].flatMap((entry) => entry === undefined ? [] : [resolve(entry[1])]).join(";"));
  return cleanEnvironment(env);
};

const freshEnvironment = async (runtime: RuntimePorts): Promise<Record<string, string>> => {
  const parent = runtime.environment.entries();
  if (runtime.platform !== "windows") return cleanEnvironment(parent);
  const query = async (key: string): Promise<Record<string, RegValue> | undefined> => {
    const result = await runtime.process.run("reg", ["query", key], { timeoutMs: REG_TIMEOUT_MS });
    if (!result.ok || result.value.exitCode !== 0) return undefined;
    return parseRegistry(result.value.stdout);
  };
  const machine = await query(MACHINE_KEY);
  const user = await query(USER_KEY);
  if (machine === undefined || user === undefined) return cleanEnvironment(parent);
  const volatile = await query(VOLATILE_KEY) ?? {};
  return mergeEnvironment(parent, machine, user, volatile);
};

function psWrapper(userFile: string, runFile: string): string {
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$OutputEncoding = [Text.Encoding]::UTF8",
    "$rigErrs = $null",
    `$rigAst = [Management.Automation.Language.Parser]::ParseFile(${q(userFile)}, [ref]$null, [ref]$rigErrs)`,
    "if ($rigErrs) { $rigErrs | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }",
    "$rigBase = $rigAst.Extent.StartOffset",
    "$rigN = 0",
    "$rigEdits = foreach ($s in $rigAst.FindAll({ param($n)",
    "  if (-not ($n -is [Management.Automation.Language.PipelineBaseAst])) { return $false }",
    "  if (-not ($n.Parent -is [Management.Automation.Language.StatementBlockAst] -or $n.Parent -is [Management.Automation.Language.NamedBlockAst])) { return $false }",
    "  for ($p = $n.Parent; $p; $p = $p.Parent) { if ($p -is [Management.Automation.Language.DataStatementAst]) { return $false } }",
    "  $true",
    "}, $true)) {",
    "  $rigN++",
    "  $redirected = $s.Find({ param($r)",
    "    $r -is [Management.Automation.Language.RedirectionAst] -and ($r.FromStream -eq 'Error' -or $r.FromStream -eq 'All')",
    "  }, $false)",
    "  $before = '$global:LASTEXITCODE = 0; '",
    "  $after = '; if ($LASTEXITCODE) { exit $LASTEXITCODE }'",
    // One variable per statement: a nested one in $( ) shares the scope.
    "  if ($redirected) {",
    "    $before += \"`$rigEap$rigN = `$ErrorActionPreference; `$ErrorActionPreference = 'Continue'; try { \"",
    "    $after = \" } finally { `$ErrorActionPreference = `$rigEap$rigN }\" + $after",
    "  }",
    "  [pscustomobject]@{ At = $s.Extent.StartOffset - $rigBase; Order = 1; Text = $before }",
    "  [pscustomobject]@{ At = $s.Extent.EndOffset - $rigBase; Order = 1; Text = $after }",
    "}",
    // A marker at the end of what runs last tells a script that ran to its
    // end from one that called exit. With named blocks that is the end
    // block's body, or an end block of its own; text after them would not parse.
    "$rigMarker = \"`r`n`$global:RigExecDone = `$true`r`n\"",
    "$rigEnd = $rigAst.EndBlock",
    "$rigNamed = $rigAst.BeginBlock -or $rigAst.ProcessBlock -or $rigAst.DynamicParamBlock -or ($rigEnd -and -not $rigEnd.Unnamed)",
    "$rigTail = ''",
    "if (-not $rigNamed) { $rigTail = $rigMarker }",
    "elseif (-not $rigEnd) { $rigTail = \"`r`nend {$rigMarker}`r`n\" }",
    // Before the closing brace; at a tie the statement's own check goes first.
    "else { $rigEdits = @($rigEdits) + [pscustomobject]@{ At = $rigEnd.Extent.EndOffset - 1 - $rigBase; Order = 0; Text = $rigMarker } }",
    "$rigText = New-Object Text.StringBuilder $rigAst.Extent.Text",
    "$rigSorted = @($rigEdits | Sort-Object @{ Expression = 'At'; Descending = $true }, @{ Expression = 'Order'; Descending = $false })",
    "foreach ($e in $rigSorted) { [void]$rigText.Insert($e.At, $e.Text) }",
    "[void]$rigText.Append($rigTail)",
    `[IO.File]::WriteAllText(${q(runFile)}, $rigText.ToString(), (New-Object Text.UTF8Encoding $true))`,
    "$global:RigExecDone = $false",
    "$global:LASTEXITCODE = 0",
    `try { & ${q(runFile)} } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`,
    "if ($global:RigExecDone) { exit 0 }",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
}


const bytes = (text: string, bom: boolean): Uint8Array => new TextEncoder().encode((bom ? "\uFEFF" : "") + text);

type ShellName = "pwsh" | "cmd" | "bash";

const fileExists = async (runtime: RuntimePorts, path: string): Promise<boolean> => await runtime.fs.stat(path) !== null;

const systemFile = async (runtime: RuntimePorts, parts: string[]): Promise<string | null> => {
  const root = runtime.environment.get("SystemRoot");
  if (root === undefined) return null;
  const path = runtime.resolvePath(root, ...parts);
  return await fileExists(runtime, path) ? path : null;
};

const pathValue = (env: Record<string, string>): string => Object.entries(env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? "";

// The full path of the executable a shell launch starts, or null when the shell is not installed. PATH is the one the
// child receives (env), so the file checked here is the file the child would start.
const shellExecutable = async (runtime: RuntimePorts, env: Record<string, string>, shell: ShellName): Promise<string | null> => {
  const windows = runtime.platform === "windows";
  if (shell === "cmd") return windows ? await systemFile(runtime, WINDOWS_CMD_FILE) : null;
  if (shell === "bash" && windows) return await fileExists(runtime, WINDOWS_BASH) ? WINDOWS_BASH : null;
  const name = windows ? `${shell}.exe` : shell;
  const found = await findOnPath(pathValue(env), windows ? WINDOWS_PATH_SEPARATOR : POSIX_PATH_SEPARATOR, (directory) => runtime.resolvePath(directory, name), (path) => fileExists(runtime, path));
  if (found === null && windows && shell === "pwsh") return await systemFile(runtime, WINDOWS_POWERSHELL_FILE);
  return found;
};

export async function buildShellLaunch(runtime: RuntimePorts, shell: "pwsh" | "cmd" | "bash", text: string, runDir: string): Promise<ApiResult<Launch>> {
  if (shell === "cmd" && /[\r\n]/.test(text)) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).execShell.singleLine());
  const env = await freshEnvironment(runtime);
  const executable = await shellExecutable(runtime, env, shell);
  if (executable === null) return apiFail(EXEC_UNAVAILABLE, messagesFor(runtime.language).execShell.notFound(shell));
  if (shell === "pwsh") {
    const user = runtime.resolvePath(runDir, "command.user.ps1");
    const wrapper = runtime.resolvePath(runDir, "command.ps1");
    const rewritten = runtime.resolvePath(runDir, "command.run.ps1");
    return apiOk({ argv: [executable, "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper], env,
      files: [{ path: user, bytes: bytes(text, true) }, { path: wrapper, bytes: bytes(psWrapper(user, rewritten), true) }], verbatimArguments: false });
  }
  if (shell === "bash") {
    const script = runtime.resolvePath(runDir, "command.sh");
    env.CHERE_INVOKING = "1";
    return apiOk({ argv: [executable, "-l", script.replaceAll("\\", "/")], env,
      files: [{ path: script, bytes: bytes(`set -eo pipefail\n${text}`, false) }], verbatimArguments: false });
  }
  env[CMD_LINE_VAR] = `"${text}"`;
  return apiOk({ argv: [executable, "/d", "/v:on", "/s", "/c",`"chcp 65001>nul 2>nul & cmd /s /c !${CMD_LINE_VAR}!"`], env, files: [], verbatimArguments: true });
}
