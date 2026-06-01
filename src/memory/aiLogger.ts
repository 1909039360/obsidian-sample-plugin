import { App, normalizePath } from "obsidian";

export interface AILogEntry {
	source: string;
	request: Record<string, unknown>;
	response?: Record<string, unknown>;
	error?: string;
}

function joinVaultPath(...parts: string[]): string {
	return normalizePath(parts.filter((part) => part && part !== "/").join("/"));
}

async function ensureDirectory(app: App, dirPath: string): Promise<void> {
	const normalized = normalizePath(dirPath);
	const segments = normalized.split("/").filter(Boolean);
	let currentPath = "";

	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		if (!(await app.vault.adapter.exists(currentPath))) {
			await app.vault.adapter.mkdir(currentPath);
		}
	}
}

function serializeSection(label: string, value: unknown): string {
	return [label, JSON.stringify(value, null, 2)].join("\n");
}

export async function appendAILog(app: App, entry: AILogEntry): Promise<void> {
	const now = new Date();
	const datePart = now.toISOString().slice(0, 10);
	const timestamp = now.toISOString();
	const logsDir = "memory/logs";
	const filePath = joinVaultPath(logsDir, `${datePart}.log`);
	const content = [
		`[${timestamp}] ${entry.source}`,
		serializeSection("REQUEST", entry.request),
		entry.response ? serializeSection("RESPONSE", entry.response) : "",
		entry.error ? `ERROR\n${entry.error}` : "",
		"",
	].filter(Boolean).join("\n");

	await ensureDirectory(app, logsDir);
	if (await app.vault.adapter.exists(filePath)) {
		const existing = await app.vault.adapter.read(filePath);
		await app.vault.adapter.write(filePath, `${existing}${content}`);
		return;
	}

	await app.vault.adapter.write(filePath, `${content}`);
}