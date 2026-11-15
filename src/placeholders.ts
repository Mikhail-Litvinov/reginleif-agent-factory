import type { JsonValue } from "./feature.js";
import type { Messages } from "./messages.js";
import type { Result } from "./result.js";

import { err, ok } from "./result.js";

const PLACEHOLDER_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const OPEN_PLACEHOLDER = "{{";

export type PlaceholderValues = Readonly<Record<string, string>>;

export const resolvePlaceholders = (
	text: string,
	values: PlaceholderValues,
	context: string,
	messages: Messages,
): Result<string> => {
	const resolved = text.replace(PLACEHOLDER_PATTERN, (placeholder, name: string) => values[name] ?? placeholder);
	if (!resolved.includes(OPEN_PLACEHOLDER)) return ok(resolved);
	const unresolved = [...new Set([...resolved.matchAll(PLACEHOLDER_PATTERN)].map((match) => `{{${match[1]}}}`))];
	return err(messages.failure.unresolvedPlaceholders(unresolved, context));
};

export const resolveJsonPlaceholders = (
	value: JsonValue,
	values: PlaceholderValues,
	context: string,
	messages: Messages,
): Result<JsonValue> => {
	if (typeof value === "string") return resolvePlaceholders(value, values, context, messages);
	if (Array.isArray(value)) {
		const resolved: JsonValue[] = [];
		for (const [index, entry] of value.entries()) {
			const result = resolveJsonPlaceholders(entry, values, `${context}[${index}]`, messages);
			if (!result.ok) return result;
			resolved.push(result.value);
		}
		return ok(resolved);
	}
	if (typeof value !== "object" || value === null) return ok(value);
	const resolved: { [key: string]: JsonValue } = {};
	for (const [key, entry] of Object.entries(value)) {
		const result = resolveJsonPlaceholders(entry, values, `${context}.${key}`, messages);
		if (!result.ok) return result;
		resolved[key] = result.value;
	}
	return ok(resolved);
};
