/**
 * End-result tests for the provider-health-check extension.
 *
 * Drives the real buildModelsUrl function with the actual baseUrls from pi's
 * model catalog and asserts the URL that the health check fetches. Expected
 * values are pinned to live-verified endpoints:
 *
 *   Mistral    https://api.mistral.ai/v1/models                  -> 401 (Ready)
 *   OpenRouter https://openrouter.ai/api/v1/models               -> 200 (Ready)
 *   Google     https://generativelanguage.googleapis.com/v1beta/models -> 403 (Ready)
 *   LM Studio  http://host:1234/v1/models                        -> 200 (Ready)
 *
 * pi's baseUrls are NOT uniform: some include the version segment, others
 * don't. Both overwrite-path ("/v1/models") and append-path ("/models") rules
 * produced 404s for one provider or the other; the rule under test is:
 * base ends in a version segment -> append /models, else append /v1/models.
 *
 * Run:
 *
 *   node --test extensions/tests/provider-health-check.test.mjs
 *   (Node >= 23.6 runs the .ts extension natively via type stripping)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildModelsUrl } from "../provider-health-check.ts";

test("Mistral (base without version segment) gains /v1/models", () => {
	// Arrange
	const baseUrl = "https://api.mistral.ai";

	// Act
	const url = buildModelsUrl(baseUrl);

	// Assert
	assert.equal(url.toString(), "https://api.mistral.ai/v1/models");
});

test("OpenRouter (base ending in /api) gains /v1/models", () => {
	// Arrange
	const baseUrl = "https://openrouter.ai/api";

	// Act
	const url = buildModelsUrl(baseUrl);

	// Assert
	assert.equal(url.toString(), "https://openrouter.ai/api/v1/models");
});

test("Google (base ending in /v1beta) only gains /models", () => {
	// Arrange
	const baseUrl = "https://generativelanguage.googleapis.com/v1beta";

	// Act
	const url = buildModelsUrl(baseUrl);

	// Assert
	assert.equal(
		url.toString(),
		"https://generativelanguage.googleapis.com/v1beta/models",
	);
});

test("LM Studio (base ending in /v1) only gains /models", () => {
	// Arrange
	const baseUrl = "http://192.168.0.40:1234/v1";

	// Act
	const url = buildModelsUrl(baseUrl);

	// Assert
	assert.equal(url.toString(), "http://192.168.0.40:1234/v1/models");
});

test("base URL with trailing slash is normalized before appending", () => {
	// Arrange
	const baseUrl = "http://127.0.0.1:1234/v1/";

	// Act
	const url = buildModelsUrl(baseUrl);

	// Assert
	assert.equal(url.toString(), "http://127.0.0.1:1234/v1/models");
});
