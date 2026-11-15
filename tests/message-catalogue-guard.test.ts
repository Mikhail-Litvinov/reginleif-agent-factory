import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ts from "typescript-api";

// Every text that can reach a person or an API client (`{"error":{"code","message"}}`, a `reason` or `message` field)
// comes from the message catalogues, never from an English literal in code. Detection is static and needs no list of
// files. A sink is: a call of `err`, `fail` or `apiFail`; an object property named `error`, `message` or `reason`; a
// call into a catalogue (`messages.x(...)`, `m.x(...)`, `messagesFor(...).x(...)`). Inside a sink every literal leaf is
// followed through templates, `+`, `||`, `??`, `?:`, and identifiers declared with an initializer or assigned in the
// same file. A leaf is English text when its static part holds a word of 3 or more letters and it either contains a
// space or belongs to a template/concatenation. A single token without spaces ("refused", "not-found", "start-failed")
// is a machine code, not text. An operating-system or child-process error text (`errorText(...)`, an error's `.message`)
// that reaches a sink directly is a finding too: it must be the parameter of a catalogue message, so an argument of a
// catalogue call is never a finding. The operating-system text is `errorText(...)` or `.message` of a bare `error` value
// (a caught or callback error); an ApiError read from a field (`launch.error.message`) already holds a catalogue text. What it does not cover: text built in another file and passed in as a variable of
// another file, and `throw new Error(...)` (such errors must be caught and replaced before output; see the second test).
const CATALOGUES = new Set(["messages.ts", "messages-ru.ts"]);
const SINK_FUNCTIONS = new Set(["err", "fail", "apiFail"]);
const SINK_PROPERTIES = new Set(["error", "message", "reason"]);
// `m` is the session error builder: its methods take the text itself, so every literal leaf of its arguments counts. The
// catalogues (`messages`, `startMessages`, `messagesFor(...)`) are the source of text: their arguments are mostly data (a
// command, a path, a code), so only an inline plain string literal passed to them counts. A call of any other function
// is not descended: its arguments are not the text that comes out.
const TEXT_TAKING_ROOTS = new Set(["m"]);
const CATALOGUE_ROOTS = new Set(["messages", "startMessages", "messagesFor"]);
const OS_TEXT_CALL = "errorText";
const OS_TEXT_PROPERTY = "message";
const OS_TEXT_BINDING = "error";
const MIN_WORD_LETTERS = 3;
const MAX_RESOLVE_DEPTH = 6;
const WORD = new RegExp(`[A-Za-z]{${MIN_WORD_LETTERS},}`);

const sourceFiles = async (directory: string, relative: string, found: string[]): Promise<string[]> => {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) await sourceFiles(join(directory, entry.name), name, found);
		else if (name.endsWith(".ts") && !CATALOGUES.has(entry.name)) found.push(name);
	}
	return found;
};

const rootOf = (expression: ts.Expression): string | null => {
	let current = expression;
	for (;;) {
		if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
		else if (ts.isCallExpression(current)) {
			if (ts.isIdentifier(current.expression) && current.expression.text === "messagesFor") return "messagesFor";
			current = current.expression;
		} else if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression;
		else return ts.isIdentifier(current) ? current.text : null;
	}
};

const isEnglish = (text: string, composed: boolean): boolean => WORD.test(text) && (composed || /\s/.test(text.trim()));

// `errorText(error)` or `error.message`: the operating-system or child-process text itself, not yet inside a message.
const isOsText = (node: ts.Node): boolean =>
	(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === OS_TEXT_CALL) ||
	(ts.isPropertyAccessExpression(node) && node.name.text === OS_TEXT_PROPERTY && ts.isIdentifier(node.expression) && node.expression.text === OS_TEXT_BINDING);

const findings = (file: string, source: string): string[] => {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const declared = new Map<string, ts.Expression[]>();
	const remember = (name: string, value: ts.Expression): void => { declared.set(name, [...(declared.get(name) ?? []), value]); };
	const collect = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) remember(node.name.text, node.initializer);
		else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) remember(node.left.text, node.right);
		ts.forEachChild(node, collect);
	};
	collect(tree);
	const out: string[] = [];
	const at = (node: ts.Node, text: string): string => `${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${JSON.stringify(text.slice(0, 70))}`;
	// `wrapped` is true below a catalogue call: there the operating-system text is the parameter of a message.
	const leaves = (node: ts.Node, composed: boolean, depth: number, seen: Set<ts.Node>, wrapped: boolean): void => {
		if (seen.has(node)) return;
		seen.add(node);
		if (!wrapped && isOsText(node)) { out.push(at(node, node.getText(tree))); return; }
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			if (isEnglish(node.text, composed)) out.push(at(node, node.text));
		} else if (ts.isTemplateExpression(node)) {
			const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
			if (isEnglish(text, true)) out.push(at(node, text));
			for (const span of node.templateSpans) leaves(span.expression, false, depth, seen, wrapped);
		} else if (ts.isIdentifier(node)) {
			if (depth < MAX_RESOLVE_DEPTH) for (const initializer of declared.get(node.text) ?? []) leaves(initializer, composed, depth + 1, seen, wrapped);
		} else if (ts.isCallExpression(node)) {
			const root = ts.isPropertyAccessExpression(node.expression) ? rootOf(node.expression) : null;
			if (root !== null && TEXT_TAKING_ROOTS.has(root)) for (const argument of node.arguments) leaves(argument, composed, depth, seen, true);
			else if (root !== null && CATALOGUE_ROOTS.has(root)) for (const argument of node.arguments) if (ts.isStringLiteral(argument)) leaves(argument, composed, depth, seen, true);
		} else if (ts.isBinaryExpression(node)) {
			const operator = node.operatorToken.kind;
			const through = operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken;
			if (through) { const joined = operator === ts.SyntaxKind.PlusToken || composed; leaves(node.left, joined, depth, seen, wrapped); leaves(node.right, joined, depth, seen, wrapped); }
		} else if (ts.isConditionalExpression(node)) {
			leaves(node.whenTrue, composed, depth, seen, wrapped);
			leaves(node.whenFalse, composed, depth, seen, wrapped);
		} else if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) {
			leaves(node.expression, composed, depth, seen, wrapped);
		} else if (ts.isPropertyAccessExpression(node) || ts.isArrayLiteralExpression(node)) {
			if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) leaves(element, composed, depth, seen, wrapped);
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (ts.isIdentifier(callee) && SINK_FUNCTIONS.has(callee.text)) for (const argument of node.arguments) leaves(argument, false, 0, new Set(), false);
			else if (ts.isPropertyAccessExpression(callee)) {
				const root = rootOf(callee);
				if (root !== null && (TEXT_TAKING_ROOTS.has(root) || CATALOGUE_ROOTS.has(root))) leaves(node, false, 0, new Set(), false);
			}
		} else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && SINK_PROPERTIES.has(node.name.text)) leaves(node.initializer, false, 0, new Set(), false);
		else if (ts.isShorthandPropertyAssignment(node) && SINK_PROPERTIES.has(node.name.text)) leaves(node.name, false, 0, new Set(), false);
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return [...new Set(out)];
};

test("no English text reaches a user or an API client from a literal outside the message catalogues", async () => {
	const found: string[] = [];
	for (const name of await sourceFiles("src", "", [])) found.push(...findings(name, await readFile(join("src", name), "utf8")));
	expect(found).toEqual([]);
});

test("the guard detects the cited cases", () => {
	const sample = [
		"const reason = spawned.ok ? \"Missing process ID\" : spawned.error;",
		"const a = apiFail(EXEC_LAUNCH, m.launch(reason));",
		"const b = apiFail(EXEC_LAUNCH, messagesFor(r.language).exec.launch(\"Process identity unavailable\"));",
		"const c = apiFail(EXEC_INVALID, \"Invalid exec record\");",
		"const d = err(\"The process broker did not answer\");",
		"const e = err(`CreateFileW ${path} failed: ${code}`);",
		"const f = { ok: false, error: \"Invalid settings merge request\" };",
		"const g = err(\"refused\");",
		"const h = err(`${description}: ${errorText(error)}`);",
		"const i = apiFail(CODE, messages.x(errorText(error)));",
		"const j = err(errorText(error));",
		"const k = apiFail(CODE, messagesFor(r.language).failure.readFailed(path, errorText(error)));",
		"const l = { kind: \"failed\", error: error.message };",
		"const n = apiFail(CODE, messages.x(error.message));",
		"let detail = \"\";",
		"detail = errorText(error);",
		"const o = err(detail);",
		"const p = { kind: \"exit\", reason: launch.error.message };",
	].join("\n");
	expect(findings("sample.ts", sample).map((line) => line.split(" ").slice(1).join(" "))).toEqual([
		"\"Missing process ID\"",
		"\"Process identity unavailable\"",
		"\"Invalid exec record\"",
		"\"The process broker did not answer\"",
		"\"CreateFileW   failed:  \"",
		"\"Invalid settings merge request\"",
		"\"errorText(error)\"",
		"\"errorText(error)\"",
		"\"error.message\"",
		"\"errorText(error)\"",
	]);
});
