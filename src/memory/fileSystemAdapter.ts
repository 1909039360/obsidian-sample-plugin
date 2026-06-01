import { App } from 'obsidian';

const MEMORY_FILE_TEMPLATES: Record<string, string> = {
	'short-term/active-session.md': `# Short-term Memory — Active Session\n\n_No summary yet._\n`,
	'long-term/knowledge.md': `# Long-term Memory — Knowledge\n\n`,
	'long-term/events.md': `# Long-term Memory — Events\n\n`,
	'long-term/personality.md': `# Long-term Memory — Personality\n\n`,
	'profile/user-profile.md': `# User Profile\n\n## Communication style\n\n## Tech preferences\n\n## Work habits\n\n## Restrictions\n\n## Long-term goals\n\n_Last updated: —_\n`,
	'index.md': `# Memory Index\n\n_Last updated: —_\n`,
};

export class FileSystemAdapter {
	private app: App;
	private baseDir: string;

	constructor(app: App, baseDir: string) {
		this.app = app;
		this.baseDir = baseDir;
	}

	private resolvePath(relativePath: string): string {
		return `${this.baseDir}/${relativePath}`;
	}

	async ensureDirectories(): Promise<void> {
		const dirs = [
			this.baseDir,
			`${this.baseDir}/short-term`,
			`${this.baseDir}/short-term/archive`,
			`${this.baseDir}/long-term`,
			`${this.baseDir}/profile`,
		];
		for (const dir of dirs) {
			if (!(await this.app.vault.adapter.exists(dir))) {
				await this.app.vault.adapter.mkdir(dir);
			}
		}

		for (const [relativePath, template] of Object.entries(MEMORY_FILE_TEMPLATES)) {
			const fullPath = this.resolvePath(relativePath);
			if (!(await this.app.vault.adapter.exists(fullPath))) {
				await this.app.vault.adapter.write(fullPath, template);
			}
		}
	}

	async readFile(relativePath: string): Promise<string> {
		const fullPath = this.resolvePath(relativePath);
		if (!(await this.app.vault.adapter.exists(fullPath))) {
			return '';
		}
		return this.app.vault.adapter.read(fullPath);
	}

	async writeFile(relativePath: string, content: string): Promise<void> {
		const fullPath = this.resolvePath(relativePath);
		await this.app.vault.adapter.write(fullPath, content);
	}

	async appendFile(relativePath: string, content: string): Promise<void> {
		const existing = await this.readFile(relativePath);
		await this.writeFile(relativePath, existing + content);
	}

	async writeArchive(sessionId: string, content: string): Promise<void> {
		await this.writeFile(`short-term/archive/session-${sessionId}.md`, content);
	}

	async updateIndex(): Promise<void> {
		const ts = new Date().toISOString();
		await this.writeFile('index.md', `# Memory Index\n\n_Last updated: ${ts}_\n`);
	}
}
