import { Notice, TFile, normalizePath, requestUrl } from 'obsidian';
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

/**
 * Manually construct a multipart/form-data body as ArrayBuffer.
 * Needed because requestUrl does not accept FormData directly.
 */
function buildMultipartBody(
fields: Record<string, string>,
file: { fieldName: string; fileName: string; contentType: string; data: ArrayBuffer }
): { contentType: string; body: ArrayBuffer } {
const boundary = '----OcrBoundary' + Math.random().toString(36).substring(2, 14);
const enc = new TextEncoder();
const CRLF = '\r\n';
const parts: Uint8Array[] = [];

for (const [name, value] of Object.entries(fields)) {
parts.push(enc.encode(
`--${boundary}${CRLF}` +
`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
`${value}${CRLF}`
));
}

parts.push(enc.encode(
`--${boundary}${CRLF}` +
`Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"${CRLF}` +
`Content-Type: ${file.contentType}${CRLF}${CRLF}`
));
parts.push(new Uint8Array(file.data));
parts.push(enc.encode(CRLF));
parts.push(enc.encode(`--${boundary}--${CRLF}`));

const totalLen = parts.reduce((s, p) => s + p.byteLength, 0);
const combined = new Uint8Array(totalLen);
let offset = 0;
for (const part of parts) {
combined.set(part, offset);
offset += part.byteLength;
}

return {
contentType: `multipart/form-data; boundary=${boundary}`,
body: combined.buffer,
};
}

async function submitPdfJob(buffer: ArrayBuffer, fileName: string, token: string): Promise<string> {
const { contentType, body } = buildMultipartBody(
{
model: PADDLE_OCR_MODEL,
optionalPayload: JSON.stringify({
useDocOrientationClassify: false,
useDocUnwarping: false,
useChartRecognition: false,
}),
},
{ fieldName: 'file', fileName, contentType: 'application/pdf', data: buffer }
);

const response = await requestUrl({
url: PADDLE_OCR_JOB_URL,
method: 'POST',
headers: {
'Authorization': `bearer ${token}`,
'Content-Type': contentType,
},
body,
throw: false,
});

if (response.status !== 200) {
throw new Error(`提交任务失败 (${response.status}): ${response.text}`);
}

const data = response.json as JobSubmitResponse;
return data.data.jobId;
}

async function pollJobStatus(
jobId: string,
token: string,
onProgress: (msg: string) => void
): Promise<string> {
const headers = { 'Authorization': `bearer ${token}` };

while (true) {
const response = await requestUrl({
url: `${PADDLE_OCR_JOB_URL}/${jobId}`,
headers,
throw: false,
});

if (response.status !== 200) {
throw new Error(`查询任务状态失败 (${response.status})`);
}

const data = response.json as JobStatusResponse;
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

async function downloadBinary(url: string): Promise<ArrayBuffer | null> {
try {
const resp = await requestUrl({ url, throw: false });
if (resp.status !== 200) return null;
return resp.arrayBuffer;
} catch {
return null;
}
}

interface HeadingEntry {
lineIndex: number;
level: number;
text: string;
}

interface HeadingCorrection {
index: number;
level: number;
}

const MAX_HEADINGS_FOR_AI = 300;

/**
 * Use AI to fix heading hierarchy in a converted markdown document.
 * Silently skips if API key is missing or no headings found.
 */
async function fixHeadingLevels(
plugin: MyPlugin,
mdContent: string,
mdPath: string
): Promise<void> {
const settings = plugin.settings;
if (!settings.dashScopeApiKey) return;

const lines = mdContent.split('\n');
const headings: HeadingEntry[] = [];

for (let i = 0; i < lines.length; i++) {
const m = lines[i]?.match(/^(#{1,6})\s+(.+)$/);
if (m?.[1] && m?.[2]) {
headings.push({ lineIndex: i, level: m[1].length, text: m[2].trim() });
}
}

if (headings.length === 0 || headings.length > MAX_HEADINGS_FOR_AI) return;

const headingList = headings.map((h, i) => `${i + 1}. ${h.text}`).join('\n');

const systemPrompt = '你是一个专业的文档结构分析助手。分析给出的标题列表，根据语义层次关系，输出修正后的标题级别。只返回合法的 JSON 数组，不要有任何其他文字。';
const userPrompt = `以下标题来自一份由 OCR 转换的 PDF 文档，当前所有标题可能都是同一级别（例如全部是二级标题），请根据标题内容的语义和层次关系，为每个标题分配正确的级别（1 为最高级，6 为最低级）。

标题列表：
${headingList}

请返回 JSON 数组，格式如下（不要多余文字）：
[{"index": 1, "level": 1}, {"index": 2, "level": 2}, ...]`;

try {
const response = await requestUrl({
url: settings.aiBaseUrl?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${settings.dashScopeApiKey}`,
},
body: JSON.stringify({
model: settings.aiModel?.trim() || 'deepseek-v4-flash',
messages: [
{ role: 'system', content: systemPrompt },
{ role: 'user', content: userPrompt },
],
stream: false,
}),
throw: false,
});

if (response.status !== 200) return;

const aiText: string = response.json?.choices?.[0]?.message?.content ?? '';
const jsonMatch = aiText.match(/\[[\s\S]*\]/);
if (!jsonMatch) return;

const corrections: HeadingCorrection[] = JSON.parse(jsonMatch[0]) as HeadingCorrection[];

for (const c of corrections) {
const idx = c.index - 1;
const heading = headings[idx];
if (idx < 0 || !heading) continue;
const newLevel = Math.max(1, Math.min(6, Math.round(c.level)));
lines[heading.lineIndex] = '#'.repeat(newLevel) + ' ' + heading.text;
}

await plugin.app.vault.adapter.write(mdPath, lines.join('\n'));
} catch (err) {
console.warn('[PDF→MD] fixHeadingLevels failed, skipping:', err);
}
}

interface SaveResult {
pages: number;
mdPath: string;
content: string;
}

async function downloadAndSaveResults(
plugin: MyPlugin,
file: TFile,
jsonlUrl: string
): Promise<SaveResult> {
const jsonlResponse = await requestUrl({ url: jsonlUrl, throw: false });
if (jsonlResponse.status !== 200) {
throw new Error(`下载 OCR 结果失败 (${jsonlResponse.status})`);
}

const lines = jsonlResponse.text.trim().split('\n').filter(l => l.trim());
const dirPath = file.parent?.path && file.parent.path !== '/' ? file.parent.path : '';
const baseName = file.basename;

const allResults: LayoutParsingResult[] = [];
for (const line of lines) {
const parsed = JSON.parse(line) as { result: { layoutParsingResults: LayoutParsingResult[] } };
for (const res of parsed.result.layoutParsingResults) {
allResults.push(res);
}
}
const totalPages = allResults.length;

// Collect and download all images, then merge all markdown into one file
const mdParts: string[] = [];
let imgCounter = 0;

for (const res of allResults) {
const images = res.markdown.images ?? {};
for (const [imgRelPath, imgUrl] of Object.entries(images)) {
const imgVaultPath = joinVaultPath(dirPath, imgRelPath);
const imgParentDir = imgVaultPath.includes('/')
? imgVaultPath.substring(0, imgVaultPath.lastIndexOf('/'))
: '';
if (imgParentDir) await ensureDir(plugin, imgParentDir);
const imgBytes = await downloadBinary(imgUrl);
if (imgBytes) {
await plugin.app.vault.adapter.writeBinary(imgVaultPath, imgBytes);
}
}

const outputImages = res.outputImages ?? {};
if (Object.keys(outputImages).length > 0) {
const outputImgDir = joinVaultPath(dirPath, `${baseName}_output_images`);
await ensureDir(plugin, outputImgDir);
for (const [imgName, imgUrl] of Object.entries(outputImages)) {
const imgVaultPath = joinVaultPath(outputImgDir, `${imgName}_${imgCounter}.jpg`);
const imgBytes = await downloadBinary(imgUrl);
if (imgBytes) {
await plugin.app.vault.adapter.writeBinary(imgVaultPath, imgBytes);
}
}
}

mdParts.push(res.markdown.text);
imgCounter++;
}

// Always write a single merged markdown file
const mdPath = joinVaultPath(dirPath, `${baseName}.md`);
const mergedContent = mdParts.join('\n\n');
if (await plugin.app.vault.adapter.exists(mdPath)) {
await plugin.app.vault.adapter.write(mdPath, mergedContent);
} else {
await plugin.app.vault.create(mdPath, mergedContent);
}

return { pages: totalPages, mdPath, content: mergedContent };
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
const { pages, mdPath, content } = await downloadAndSaveResults(plugin, file, jsonlUrl);

notice.setMessage(`🔧 正在用 AI 修复标题层级...`);
await fixHeadingLevels(plugin, content, mdPath);

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
