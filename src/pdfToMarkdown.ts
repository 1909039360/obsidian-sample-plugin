import { Notice, TFile, normalizePath } from 'obsidian';
import type MyPlugin from './main';

const PADDLE_OCR_JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const PADDLE_OCR_MODEL = "PaddleOCR-VL-1.5";

interface JobSubmitResponse {
	data: { jobId: string };
}

interface JobStatusResponse {
	data: {
		state: 'pending' | 'running' | 'done' | 'failed';
		extractProgress?: {
			totalPages: number;
			extractedPages: number;
			startTime: string;
			endTime: string;
		};
		resultUrl?: {
			jsonUrl: string;
		};
		errorMsg?: string;
	};
}

interface LayoutParsingResult {
	markdown: {
		text: string;
		images: Record<string, string>;
	};
	outputImages: Record<string, string>;
}

function joinVaultPath(...parts: string[]): string {
	return normalizePath(parts.filter(p => p && p !== '/').join('/'));
}

async function submitPdfJob(buffer: ArrayBuffer, fileName: string, token: string): Promise<string> {
	const formData = new FormData();
	const blob = new Blob([buffer], { type: 'application/pdf' });
	formData.append('file', blob, fileName);
	formData.append('model', PADDLE_OCR_MODEL);
	formData.append('optionalPayload', JSON.stringify({
		useDocOrientationClassify: false,
		useDocUnwarping: false,
		useChartRecognition: false,
	}));

	const response = await window.fetch(PADDLE_OCR_JOB_URL, {
		method: 'POST',
		headers: { 'Authorization': `bearer ${token}` },
		body: formData,
	});

	if (!response.ok) {
		const errText = await response.text().catch(() => '');
		throw new Error(`提交任务失败 (${response.status}): ${errText}`);
	}

	const data: JobSubmitResponse = await response.json() as JobSubmitResponse;
	return data.data.jobId;
}

async function pollJobStatus(
	jobId: string,
	token: string,
	onProgress: (msg: string) => void
): Promise<string> {
	const headers = { 'Authorization': `bearer ${token}` };

	while (true) {
		const response = await window.fetch(`${PADDLE_OCR_JOB_URL}/${jobId}`, { headers });
		if (!response.ok) {
			throw new Error(`查询任务状态失败 (${response.status})`);
		}

		const data: JobStatusResponse = await response.json() as JobStatusResponse;
		const { state } = data.data;

		if (state === 'pending') {
			onProgress('任务排队中...');
		} else if (state === 'running') {
			const prog = data.data.extractProgress;
			if (prog) {
				onProgress(`处理中: ${prog.extractedPages}/${prog.totalPages} 页`);
			} else {
				onProgress('处理中...');
			}
		} else if (state === 'done') {
			return data.data.resultUrl!.jsonUrl;
		} else if (state === 'failed') {
			throw new Error(`OCR 任务失败: ${data.data.errorMsg ?? '未知错误'}`);
		}

		await new Promise<void>(resolve => window.setTimeout(resolve, 5000));
	}
}

async function ensureDir(plugin: MyPlugin, dirPath: string): Promise<void> {
	if (!dirPath) return;
	if (!(await plugin.app.vault.adapter.exists(dirPath))) {
		await plugin.app.vault.adapter.mkdir(dirPath);
	}
}

async function downloadImage(url: string): Promise<ArrayBuffer | null> {
	try {
		const resp = await window.fetch(url);
		if (!resp.ok) return null;
		return await resp.arrayBuffer();
	} catch {
		return null;
	}
}

async function downloadAndSaveResults(
	plugin: MyPlugin,
	file: TFile,
	jsonlUrl: string
): Promise<number> {
	const jsonlResponse = await window.fetch(jsonlUrl);
	if (!jsonlResponse.ok) {
		throw new Error(`下载 OCR 结果失败 (${jsonlResponse.status})`);
	}

	const text = await jsonlResponse.text();
	const lines = text.trim().split('\n').filter(l => l.trim());

	const dirPath = file.parent?.path && file.parent.path !== '/' ? file.parent.path : '';
	const baseName = file.basename;

	// Count total result pages to decide naming
	let totalPages = 0;
	const allResults: LayoutParsingResult[] = [];
	for (const line of lines) {
		const parsed = JSON.parse(line) as { result: { layoutParsingResults: LayoutParsingResult[] } };
		for (const res of parsed.result.layoutParsingResults) {
			allResults.push(res);
			totalPages++;
		}
	}

	let pageNum = 0;
	for (const res of allResults) {
		const isSinglePage = totalPages === 1;
		const mdPath = isSinglePage
			? joinVaultPath(dirPath, `${baseName}.md`)
			: joinVaultPath(dirPath, `${baseName}_${pageNum}.md`);

		// Handle inline images (referenced in markdown text)
		const images = res.markdown.images ?? {};
		for (const [imgRelPath, imgUrl] of Object.entries(images)) {
			// imgRelPath is like "images/figure_0.png" — save relative to same dir as md
			const imgVaultPath = joinVaultPath(dirPath, imgRelPath);
			const imgParentDir = imgVaultPath.includes('/')
				? imgVaultPath.substring(0, imgVaultPath.lastIndexOf('/'))
				: '';
			if (imgParentDir) await ensureDir(plugin, imgParentDir);

			const imgBytes = await downloadImage(imgUrl);
			if (imgBytes) {
				await plugin.app.vault.adapter.writeBinary(imgVaultPath, imgBytes);
			}
		}

		// Handle output images (additional analysis images)
		const outputImages = res.outputImages ?? {};
		if (Object.keys(outputImages).length > 0) {
			const outputImgDir = joinVaultPath(dirPath, `${baseName}_output_images`);
			await ensureDir(plugin, outputImgDir);
			for (const [imgName, imgUrl] of Object.entries(outputImages)) {
				const imgVaultPath = joinVaultPath(outputImgDir, `${imgName}_${pageNum}.jpg`);
				const imgBytes = await downloadImage(imgUrl);
				if (imgBytes) {
					await plugin.app.vault.adapter.writeBinary(imgVaultPath, imgBytes);
				}
			}
		}

		// Save markdown file
		const mdContent = res.markdown.text;
		if (await plugin.app.vault.adapter.exists(mdPath)) {
			await plugin.app.vault.adapter.write(mdPath, mdContent);
		} else {
			await plugin.app.vault.create(mdPath, mdContent);
		}

		pageNum++;
	}

	return totalPages;
}

export async function convertPdfToMarkdown(plugin: MyPlugin, file: TFile): Promise<void> {
	const token = plugin.settings.paddleOcrToken?.trim();
	if (!token) {
		new Notice('⚠️ 请先在设置中配置 PaddleOCR API Token', 5000);
		return;
	}

	const notice = new Notice(`📄 正在提交 ${file.name}...`, 0);
	try {
		const buffer = await plugin.app.vault.readBinary(file);

		const jobId = await submitPdfJob(buffer, file.name, token);
		notice.setMessage(`⏳ 已提交 (${jobId.substring(0, 8)}...)，等待 OCR 处理...`);

		const jsonlUrl = await pollJobStatus(jobId, token, (msg) => {
			notice.setMessage(`⏳ ${file.name}: ${msg}`);
		});

		notice.setMessage(`📥 正在下载并保存结果...`);
		const pages = await downloadAndSaveResults(plugin, file, jsonlUrl);

		notice.hide();
		new Notice(`✅ ${file.name} 已转换完成，共 ${pages} 页`, 6000);
	} catch (error) {
		notice.hide();
		const msg = error instanceof Error ? error.message : String(error);
		new Notice(`❌ PDF 转换失败: ${msg}`, 8000);
		console.error('[PDF→MD] conversion failed:', error);
	}
}

export function registerPdfFileMenu(plugin: MyPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, abstractFile) => {
			if (!(abstractFile instanceof TFile)) return;
			if (abstractFile.extension.toLowerCase() !== 'pdf') return;

			menu.addItem(item => {
				item
					.setTitle('转 Markdown 格式 (OCR)')
					.setIcon('file-text')
					.onClick(() => {
						void convertPdfToMarkdown(plugin, abstractFile);
					});
			});
		})
	);
}
