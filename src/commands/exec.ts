import type { ApiResult, JsonValue } from "../output.js";
import type { RuntimePorts } from "../ports.js";

import { listExecs, startExec, statusExec, stopExec } from "../exec-core.js";
import { messagesFor } from "../messages.js";
import { apiFail, ERROR_CODE_USAGE } from "../output.js";

export const runExecCommand = async (runtime: RuntimePorts, name: string, args: readonly string[]): Promise<ApiResult<JsonValue>> => {
	const usage = (): ApiResult<never> => apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).exec.usage());
	if (name === "list") return args.length === 0 ? listExecs(runtime) : usage();
	if (name === "start") {
		const [shell, flag, cwd] = args;
		if (args.length !== 3 || (shell !== "pwsh" && shell !== "cmd" && shell !== "bash") || flag !== "--cwd" || cwd === "") return usage();
		return startExec(runtime, shell, cwd, await runtime.stdin.read());
	}
	if (name === "stop") return args.length === 1 ? stopExec(runtime, args[0]) : usage();
	if (name === "status") {
		if (args.length === 1) return statusExec(runtime, args[0], 0);
		if (args.length !== 3 || args[1] !== "--from" || !/^\d+$/.test(args[2])) return usage();
		return statusExec(runtime, args[0], Number(args[2]));
	}
	return usage();
};
