/**
 * Pure sanitization logic for the eos-guard extension.
 *
 * A llama.cpp/LM Studio server terminates generation whenever the model
 * emits a chat-template special token — including when the model merely
 * quotes one as literal text. The token is consumed as EOS, the stream
 * ends with finish_reason "stop", and the token itself is stripped, so
 * pi records an apparently empty or cut-off turn.
 *
 * Defense: break the exact byte sequence of every special-token spelling
 * in the LLM context by swapping ASCII delimiters for lookalike Unicode
 * (guillemets). The text stays human-readable and semantically intact,
 * but the model can no longer reproduce the server-recognized string by
 * copying it. Sanitization is idempotent.
 */

/** A single special-token spelling pattern and nothing more. */
export type TokenPattern = RegExp;

/** Delimiters swapped inside matched spans to break the exact string. */
const DEFUSE_MAP: Record<string, string> = {
	"<": "‹", // U+2039
	">": "›", // U+203A
	"[": "⟦", // U+27E6
	"]": "⟧", // U+27E7
};

/** Defuse every delimiter inside the matched token spelling. */
function defuseMatch(match: string): string {
	return match.replace(/[<>\[\]]/g, (ch) => DEFUSE_MAP[ch]);
}

/**
 * Replace every special-token spelling in `text` with its defused
 * lookalike. Returns the sanitized text and the number of replacements.
 */
export function defuseSpecialTokens(
	text: string,
	patterns: readonly TokenPattern[],
): { text: string; count: number } {
	let count = 0;
	let result = text;
	for (const pattern of patterns) {
		result = result.replace(pattern, (match) => {
			count++;
			return defuseMatch(match);
		});
	}
	return { text: result, count };
}

/** Content part shapes the walker understands (subset, defensively typed). */
type ContentPart = {
	type?: string;
	text?: unknown;
	thinking?: unknown;
	arguments?: unknown;
};

type ContextMessage = {
	role?: string;
	content?: unknown;
};

/**
 * Sanitize one context message in place: text parts, thinking parts, and
 * string values inside tool-call arguments. Returns the number of
 * replacements.
 */
export function sanitizeMessage(message: ContextMessage, patterns: readonly TokenPattern[]): number {
	let count = 0;
	const content = message.content;

	if (typeof content === "string") {
		const { text, count: n } = defuseSpecialTokens(content, patterns);
		if (n > 0) {
			message.content = text;
			count += n;
		}
		return count;
	}

	if (!Array.isArray(content)) return count;

	for (const part of content as ContentPart[]) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "text" && typeof part.text === "string") {
			const { text, count: n } = defuseSpecialTokens(part.text, patterns);
			if (n > 0) {
				part.text = text;
				count += n;
			}
		} else if (part.type === "thinking" && typeof part.thinking === "string") {
			const { text, count: n } = defuseSpecialTokens(part.thinking, patterns);
			if (n > 0) {
				part.thinking = text;
				count += n;
			}
		} else if (part.type === "toolCall" && part.arguments && typeof part.arguments === "object") {
			count += defuseStringsDeep(part.arguments, patterns);
		}
	}
	return count;
}

/** Recursively sanitize string values inside an object/array in place. */
function defuseStringsDeep(node: unknown, patterns: readonly TokenPattern[]): number {
	if (Array.isArray(node)) {
		let count = 0;
		for (let i = 0; i < node.length; i++) {
			const value = node[i];
			if (typeof value === "string") {
				const { text, count: n } = defuseSpecialTokens(value, patterns);
				if (n > 0) {
					node[i] = text;
					count += n;
				}
			} else if (value && typeof value === "object") {
				count += defuseStringsDeep(value, patterns);
			}
		}
		return count;
	}
	if (node && typeof node === "object") {
		let count = 0;
		for (const [key, value] of Object.entries(node)) {
			if (typeof value === "string") {
				const { text, count: n } = defuseSpecialTokens(value, patterns);
				if (n > 0) {
					(node as Record<string, unknown>)[key] = text;
					count += n;
				}
			} else if (value && typeof value === "object") {
				count += defuseStringsDeep(value, patterns);
			}
		}
		return count;
	}
	return 0;
}

/**
 * Sanitize a full LLM context message list in place. Returns the number of
 * replacements across all messages.
 */
export function sanitizeMessages(
	messages: ContextMessage[],
	patterns: readonly TokenPattern[],
): number {
	let count = 0;
	for (const message of messages) {
		count += sanitizeMessage(message, patterns);
	}
	return count;
}
