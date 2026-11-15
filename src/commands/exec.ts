import type { ApiResult, JsonValue } from "../output.js";
import type { RuntimePorts } from "../ports.js";

import { listExecs, startExec, startRigExec, statusExec, stopExec } from "../exec-core.js";
import { messagesFor } from "../messages.js";
import { apiFail, ERROR_CODE_USAGE } from "../output.js";

export const runExecCommand = async (runtime: RuntimePorts, name: string, args: readonly string[]): Promise<ApiResult<JsonValue>> => {
	const usage = (): ApiResult<never> => apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).exec.usage());
	if (name === "list") return args.length === 0 ? listExecs(runtime) : usage();
	if (name === "start") {
		if (args[0] === "rig") return args[1] === "--" ? startRigExec(runtime, args.slice(2)) : usage();
		const [shell, flag, cwd] = args;
		if (args.length !== 3 || (shell !== "pwsh" && shell !== "cmd" && shell !== "bash") || flag !== "--cwd" || cwd === "") return usage();
		return startExec(runtime, shell, cwd, await runtime.stdin.read());
	}
	if (name === "stop") return args.length === 1 ? stopExec(runtime, args[0]) : usage();
	if (name === "status") {
		if (args.length === 1) return statusExec(runtime, args[0], 0);
		// `--wait` follows `--from`; its value is digits only and must be a safe integer, so it is exact in milliseconds.
		const [id, fromFlag, from, waitFlag, wait] = args;
		if (fromFlag !== "--from" || !/^\d+$/.test(from)) return usage();
		if (args.length === 3) return statusExec(runtime, id, Number(from));
		if (args.length !== 5 || waitFlag !== "--wait" || !/^\d+$/.test(wait) || !Number.isSafeInteger(Number(wait))) return usage();
		return statusExec(runtime, id, Number(from), Number(wait));
	}
	return usage();
};
