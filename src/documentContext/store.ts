import type { DocumentContextItem } from "./types";

export class DocumentContextStore {
	private readonly selectedItems = new Map<string, DocumentContextItem>();
	private readonly listeners: Array<() => void> = [];
	private historyItems: DocumentContextItem[] = [];
	private lastConversationSnapshot: DocumentContextItem[];
	private readonly historyLimit: number;
	private focusMode: boolean;
	private fileUsage: Record<string, number>;
	private readonly onFileUsageChange?: (fileUsage: Record<string, number>) => void;

	constructor(
		historyLimit = 5,
		initialSnapshot: DocumentContextItem[] = [],
		focusMode = true,
		initialFileUsage: Record<string, number> = {},
		onFileUsageChange?: (fileUsage: Record<string, number>) => void
	) {
		this.historyLimit = historyLimit;
		this.lastConversationSnapshot = initialSnapshot;
		this.focusMode = focusMode;
		this.fileUsage = { ...initialFileUsage };
		this.onFileUsageChange = onFileUsageChange;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) {
				this.listeners.splice(index, 1);
			}
		};
	}

	private notify(): void {
		this.listeners.forEach((listener) => listener());
	}

	private addToHistory(item: DocumentContextItem): void {
		this.historyItems = this.historyItems.filter((context) => context.id !== item.id);
		this.historyItems.unshift(item);
		if (this.historyItems.length > this.historyLimit) {
			this.historyItems = this.historyItems.slice(0, this.historyLimit);
		}
	}

	private normalizeFocusedItems(items: DocumentContextItem[]): DocumentContextItem[] {
		if (!this.focusMode || items.length <= 1) {
			return items;
		}

		const sortedItems = [...items].sort((left, right) => left.selectedAt - right.selectedAt);
		const keptItem = sortedItems[sortedItems.length - 1];
		for (const item of sortedItems.slice(0, -1)) {
			this.addToHistory(item);
		}

		return keptItem ? [keptItem] : [];
	}

	private incrementFileUsage(items: DocumentContextItem[]): void {
		const filePaths = Array.from(new Set(items.map((item) => item.filePath).filter((filePath) => Boolean(filePath))));
		if (filePaths.length === 0) {
			return;
		}

		for (const filePath of filePaths) {
			this.fileUsage[filePath] = (this.fileUsage[filePath] ?? 0) + 1;
		}

		this.onFileUsageChange?.(this.getFileUsageSnapshot());
	}

	setFocusMode(enabled: boolean): void {
		if (this.focusMode === enabled) {
			return;
		}

		this.focusMode = enabled;
		if (enabled) {
			const focusedItems = this.normalizeFocusedItems(Array.from(this.selectedItems.values()));
			this.selectedItems.clear();
			for (const item of focusedItems) {
				this.selectedItems.set(item.id, item);
			}
		}

		this.notify();
	}

	isFocusMode(): boolean {
		return this.focusMode;
	}

	select(item: DocumentContextItem): void {
		for (const context of this.selectedItems.values()) {
			if ((this.focusMode || context.filePath === item.filePath) && context.id !== item.id) {
				this.addToHistory(context);
				this.selectedItems.delete(context.id);
			}
		}

		this.historyItems = this.historyItems.filter((context) => context.id !== item.id);
		this.selectedItems.set(item.id, item);
		this.incrementFileUsage([item]);
		this.notify();
	}

	toggle(item: DocumentContextItem): boolean {
		if (this.selectedItems.has(item.id)) {
			this.remove(item.id);
			return false;
		}

		this.select(item);
		return true;
	}

	setSelectedItems(items: DocumentContextItem[]): void {
		for (const context of this.selectedItems.values()) {
			this.addToHistory(context);
		}

		const nextItems = this.normalizeFocusedItems(items);
		this.selectedItems.clear();
		for (const item of nextItems) {
			this.historyItems = this.historyItems.filter((context) => context.id !== item.id);
			this.selectedItems.set(item.id, item);
		}

		this.incrementFileUsage(nextItems);
		this.notify();
	}

	remove(id: string): void {
		const item = this.selectedItems.get(id);
		if (!item) {
			return;
		}

		this.addToHistory(item);
		this.selectedItems.delete(id);
		this.notify();
	}

	clear(): void {
		for (const item of this.selectedItems.values()) {
			this.addToHistory(item);
		}
		this.selectedItems.clear();
		this.notify();
	}

	getSelectedItems(): DocumentContextItem[] {
		return Array.from(this.selectedItems.values()).sort((left, right) => left.selectedAt - right.selectedAt);
	}

	getHistory(): DocumentContextItem[] {
		return [...this.historyItems];
	}

	setLastConversationSnapshot(items: DocumentContextItem[]): void {
		this.lastConversationSnapshot = items.map((item) => ({ ...item }));
		this.notify();
	}

	getLastConversationSnapshot(): DocumentContextItem[] {
		return this.lastConversationSnapshot.map((item) => ({ ...item }));
	}

	getFileUsageCount(filePath: string): number {
		return this.fileUsage[filePath] ?? 0;
	}

	getFileUsageSnapshot(): Record<string, number> {
		return { ...this.fileUsage };
	}
}
