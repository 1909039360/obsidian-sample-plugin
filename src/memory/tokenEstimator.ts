/**
 * Lightweight token estimator.
 * Uses character-length approximation (≈ 3 chars per token for Chinese/mixed text).
 * Swap the body of estimateTokens() to use a real tokenizer when needed.
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 3);
}
