import type { Platform } from "../src/feature.js";

import { describe, expect, test } from "bun:test";

import { launchPath, LAUNCH_TOKEN } from "../src/launch-safety.js";

// Characters placed between "x" and "y". Control characters are written as escapes.
const CONTROL = ["\t", "\n", "\r", "\x03", "\x15"];
// cmd.exe syntax on the outer line that `start` runs. `!` counts because delayed expansion is a per-machine setting.
const CMD_SYNTAX = ["&", "|", "<", ">", "^", "%", "\"", "!"];

const accepted = (platform: Platform, value: string): string | null => {
	const result = launchPath(platform, value);
	return result.ok ? result.value : null;
};

describe("launch path rules per platform", () => {
	test("windows refuses cmd.exe syntax and control characters", () => {
		for (const character of [...CONTROL, ...CMD_SYNTAX]) expect(accepted("windows", `x${character}y`)).toBeNull();
	});
	test("windows escapes the wt.exe subcommand delimiter as \\;", () => {
		expect(accepted("windows", "x;y")).toBe("x\\;y");
	});
	test("windows passes characters that no parser of the path reads as syntax", () => {
		for (const character of ["(", ")", "'", "#", "$", "@", "~", "+", "=", ",", "[", "]", " "]) expect(accepted("windows", `x${character}y`)).toBe(`x${character}y`);
	});
	test("windows doubles the backslash run before a semicolon, so wt.exe reads the backslashes literally", () => {
		expect(accepted("windows", "x\\y")).toBe("x\\y");
		expect(accepted("windows", "x\\;y")).toBe("x\\\\;y");
		expect(accepted("windows", "x\\\\;y")).toBe("x\\\\\\;y");
		expect(accepted("windows", "x;")).toBe("x\\;");
		expect(accepted("windows", "x\\")).toBe("x\\");
	});
	test("darwin refuses control characters, because the typed shell line would act on them", () => {
		for (const character of CONTROL) expect(accepted("darwin", `x${character}y`)).toBeNull();
	});
	test("darwin passes every other character, single-quoted by the shell quoting", () => {
		for (const character of [...CMD_SYNTAX, ";", "(", ")", "'", "#", "$", "@", "~", "+", "=", ",", "[", "]", " "]) expect(accepted("darwin", `x${character}y`)).toBe(`x${character}y`);
	});
	test("linux refuses the characters tmux reads: ; ends a command, # starts a format", () => {
		expect(accepted("linux", "x;y")).toBeNull();
		expect(accepted("linux", "x#y")).toBeNull();
	});
	test("linux passes every other character, because the directory travels as an exact argument", () => {
		for (const character of [...CONTROL, ...CMD_SYNTAX, "(", ")", "'", "$", "@", "~", "+", "=", ",", "[", "]", " "]) expect(accepted("linux", `x${character}y`)).toBe(`x${character}y`);
	});
	test("identifiers pass only letters, digits, underscore, dot, dash and at-sign", () => {
		for (const value of ["12", "plan", "telegram-hub@market", "a_b.c-d"]) expect(LAUNCH_TOKEN.test(value)).toBe(true);
		for (const character of [...CONTROL, ...CMD_SYNTAX, ";", "(", ")", "'", "#", "$", "~", "+", "=", ",", "[", "]", "\\", "/", "*", "?", ":", " "]) expect(LAUNCH_TOKEN.test(`x${character}y`)).toBe(false);
	});
});
