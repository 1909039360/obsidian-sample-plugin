import { App, normalizePath } from "obsidian";
import { BUILTIN_PROMPTS } from "../promptSuggest";
import type { MyPluginSettings, NamedPrompt } from "../settings";

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

function toMarkdownCodeBlock(content: string): string {
	const fence = content.includes("```") ? "````" : "```";
	return `${fence}markdown\n${content}\n${fence}`;
}

function formatNamedPrompt(prompt: NamedPrompt, activeId: string): string {
	const activeSuffix = prompt.id === activeId ? " (active)" : "";
	return [`### ${prompt.name || "Untitled prompt"}${activeSuffix}`, "", toMarkdownCodeBlock(prompt.content || ""), ""].join("\n");
}

function formatNamedPromptSection(title: string, prompts: NamedPrompt[], activeId: string, extraBlocks: string[] = []): string {
	const sections = [`## ${title}`, "", ...extraBlocks];

	if (prompts.length === 0) {
		sections.push("### None", "", toMarkdownCodeBlock(""), "");
		return sections.join("\n");
	}

	sections.push(...prompts.map((prompt) => formatNamedPrompt(prompt, activeId)));
	return sections.join("\n");
}

function formatPromptListSection(title: string, prompts: string[]): string {
	const body = prompts.map((prompt) => `- ${prompt}`).join("\n");
	return [`### ${title}`, "", toMarkdownCodeBlock(body), ""].join("\n");
}

function buildPromptMemoryMarkdown(settings: MyPluginSettings): string {
	return [
		"# Prompt Memory",
		"",
		formatNamedPromptSection("System Prompt", settings.savedSystemPrompts ?? [], settings.activeSystemPromptId, [
			"### Legacy template",
			"",
			toMarkdownCodeBlock(settings.systemPromptTemplate || ""),
			"",
		]),
		formatNamedPromptSection("Soul Prompt", settings.savedSoulPrompts ?? [], settings.activeSoulPromptId),
		"## Popup prompts",
		"",
		formatPromptListSection("Custom prompts", settings.customPrompts ?? []),
		formatPromptListSection("Built-in prompts", BUILTIN_PROMPTS),
	].join("\n");
}

export function getPromptMemorySyncKey(settings: MyPluginSettings): string {
	return JSON.stringify({
		systemPromptTemplate: settings.systemPromptTemplate || "",
		savedSystemPrompts: settings.savedSystemPrompts ?? [],
		activeSystemPromptId: settings.activeSystemPromptId || "",
		savedSoulPrompts: settings.savedSoulPrompts ?? [],
		activeSoulPromptId: settings.activeSoulPromptId || "",
		customPrompts: settings.customPrompts ?? [],
	});
}

export async function syncPromptMemoryFile(app: App, settings: MyPluginSettings): Promise<void> {
	const memoryDirectory = "memory";
	const filePath = joinVaultPath(memoryDirectory, "prompt.md");
	const content = buildPromptMemoryMarkdown(settings);

	await ensureDirectory(app, memoryDirectory);
	await app.vault.adapter.write(filePath, content);
}