import assert from "node:assert/strict";
import { test } from "node:test";
import { requiredEnv } from "./required-env.ts";

test("a missing or blank variable fails with its name and the hint, a set one is returned as is", () => {
	for (const env of [{}, { REGISTRY_MEASUREMENT_DATASET: "" }, { REGISTRY_MEASUREMENT_DATASET: "  " }]) {
		assert.throws(() => requiredEnv("REGISTRY_MEASUREMENT_DATASET", "path of the measurement dataset JSON", env), /REGISTRY_MEASUREMENT_DATASET is not set: path of the measurement dataset JSON/);
	}
	assert.equal(requiredEnv("REGISTRY_MEASUREMENT_DATASET", "hint", { REGISTRY_MEASUREMENT_DATASET: "x.json" }), "x.json");
});
