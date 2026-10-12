// Text extraction for documents (FR-5.2, D64, D65): PDF text layers with pdf.js, Word with mammoth, Excel and
// CSV with exceljs (tables as Markdown tables), PowerPoint and zip archives with jszip, Markdown, text and code
// as they are, and scanned pages or images through the OCR provider when the caller allows it.
import { createRequire } from 'node:module';
import path from 'node:path';
import type { OcrProvider } from '@brain/models';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';

export interface Extraction {
  text: string;
  /** How the text was obtained; `none` when the file type is not readable here. */
  method: 'text' | 'ocr' | 'none';
  pages?: number;
  sheets?: number;
  slides?: number;
  entries?: number;
  /** Why nothing was extracted (`method: none`). */
  reason?: string;
}

export interface ExtractOptions {
  /** Reads scans and images; absent when the installation or the document forbids model calls. */
  ocr?: OcrProvider | undefined;
  /** Why OCR is unavailable, for the page. */
  ocrUnavailable?: string;
  maxChars?: number;
  maxZipEntries?: number;
}

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'text/xml', 'text/html', 'application/x-yaml', 'text/yaml', 'application/sql', 'text/x-sql']);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.sql', '.ddl', '.xml', '.html', '.htm', '.ts', '.tsx', '.js', '.mjs', '.py', '.go', '.java', '.kt', '.cs', '.rb', '.php', '.sh', '.toml', '.ini', '.env.example', '.csv', '.tsv', '.wsdl', '.graphql', '.proto', '.c', '.h', '.cpp', '.rs', '.swift', '.css', '.scss', '.vue', '.svelte', '.properties', '.gradle', '.tf', '.dockerfile']);
const DEFAULT_MAX_CHARS = 2_000_000;
const DEFAULT_MAX_ENTRIES = 400;

const require = createRequire(import.meta.url);
const STANDARD_FONTS = `${path.dirname(require.resolve('pdfjs-dist/package.json'))}/standard_fonts/`;

export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'zip' | 'text' | 'image' | 'other';

const BY_TYPE: Record<string, FileKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
};
const BY_EXTENSION: Record<string, FileKind> = { '.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx', '.csv': 'csv', '.tsv': 'csv', '.zip': 'zip' };
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-unknown']);

/** The kind of file: a specific media type decides; a generic one leaves it to the file name. */
export function classify(mediaType: string, name: string): FileKind {
  const ext = path.extname(name).toLowerCase();
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (BY_TYPE[type]) return BY_TYPE[type];
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/') || TEXT_TYPES.has(type)) return ext === '.csv' || ext === '.tsv' ? 'csv' : 'text';
  if (!GENERIC_TYPES.has(type)) return 'other';
  if (BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'other';
}

function cap(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]` : text;
}

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return JSON.stringify(value);
};
const escapeCell = (value: unknown): string => cellText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

/** Rows as a Markdown table: the first row is the header. */
export function markdownTable(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0 || rows.length === 0) return '';
  const pad = (row: string[]): string[] => [...row, ...Array<string>(width - row.length).fill('')];
  const [header, ...body] = rows.map(pad);
  return [`| ${header!.join(' | ')} |`, `| ${header!.map(() => '---').join(' | ')} |`, ...body.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl: STANDARD_FONTS, verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n').trim());
    }
  } finally {
    await task.destroy();
  }
  return { text: pages.map((page, i) => (page ? `## Page ${i + 1}\n\n${page}` : '')).filter(Boolean).join('\n\n'), pages: doc.numPages };
}

async function xlsxText(bytes: Uint8Array): Promise<{ text: string; sheets: number }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes).buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map((value) => escapeCell(typeof value === 'object' && value !== null && 'result' in value ? (value as { result: unknown }).result : typeof value === 'object' && value !== null && 'richText' in value ? (value).richText.map((run) => run.text).join('') : value)));
    });
    if (rows.length > 0) parts.push(`## ${sheet.name}\n\n${markdownTable(rows)}`);
  });
  return { text: parts.join('\n\n'), sheets: workbook.worksheets.length };
}

function csvText(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8');
  const delimiter = text.split('\n')[0]?.includes('\t') ? '\t' : text.split('\n')[0]?.includes(';') && !text.split('\n')[0]?.includes(',') ? ';' : ',';
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split(delimiter).map((cell) => cell.replace(/^"|"$/g, '')));
  return markdownTable(rows);
}

const stripXml = (xml: string): string =>
  xml
    .replace(/<a:p>/g, '\n')
    .replace(/<\/a:p>/g, '')
    .replace(/<a:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

async function pptxText(bytes: Uint8Array): Promise<{ text: string; slides: number }> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/slide(\d+)/.exec(a)?.[1] ?? 0) - Number(/slide(\d+)/.exec(b)?.[1] ?? 0));
  const parts: string[] = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name)!.async('string');
    const notesName = name.replace('slides/slide', 'notesSlides/notesSlide');
    const notes = zip.file(notesName) ? stripXml(await zip.file(notesName)!.async('string')) : '';
    parts.push(`## Slide ${i + 1}\n\n${stripXml(xml)}${notes ? `\n\nNotes: ${notes}` : ''}`);
  }
  return { text: parts.join('\n\n'), slides: slides.length };
}

async function zipText(bytes: Uint8Array, maxEntries: number, maxChars: number): Promise<{ text: string; entries: number }> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => !zip.files[name]!.dir && !name.includes('node_modules/') && !name.includes('/.git/') && !path.basename(name).startsWith('.'))
    .sort();
  const parts: string[] = [];
  let used = 0;
  let entries = 0;
  for (const name of names) {
    if (entries >= maxEntries || used >= maxChars) break;
    if (classify('', name) !== 'text') continue;
    const content = await zip.file(name)!.async('string');
    if (content.includes(String.fromCharCode(0))) continue;
    const piece = `## ${name}\n\n${content.trim()}`;
    parts.push(piece);
    used += piece.length;
    entries++;
  }
  return { text: parts.join('\n\n'), entries };
}

/** The text of a file, or why it has none. Never throws for an unreadable file: the reason is in the result. */
export async function extractText(bytes: Uint8Array, mediaType: string, name: string, options: ExtractOptions = {}): Promise<Extraction> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const kind = classify(mediaType, name);
  const viaOcr = async (why: string): Promise<Extraction> => {
    if (!options.ocr) return { text: '', method: 'none', reason: options.ocrUnavailable ?? `${why}; no OCR provider is available` };
    const type = kind === 'pdf' ? 'application/pdf' : mediaType.split(';')[0]!.trim();
    if (!options.ocr.accepts(type)) return { text: '', method: 'none', reason: `${why}; the OCR provider does not read ${type}` };
    return { text: cap(await options.ocr.readText(bytes, type), maxChars), method: 'ocr' };
  };
  try {
    switch (kind) {
      case 'text':
        return { text: cap(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''), maxChars), method: 'text' };
      case 'csv':
        return { text: cap(csvText(bytes), maxChars), method: 'text' };
      case 'pdf': {
        const { text, pages } = await pdfText(bytes);
        // A scanned PDF has no text layer or a few stray characters; anything more is taken as real text.
        if (text.replace(/## Page \d+/g, '').trim().length >= 10) return { text: cap(text, maxChars), method: 'text', pages };
        const ocr = await viaOcr('the PDF has no text layer');
        return { ...ocr, pages };
      }
      case 'docx': {
        const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
        return { text: cap(result.value.trim(), maxChars), method: 'text' };
      }
      case 'xlsx': {
        const { text, sheets } = await xlsxText(bytes);
        return { text: cap(text, maxChars), method: 'text', sheets };
      }
      case 'pptx': {
        const { text, slides } = await pptxText(bytes);
        return { text: cap(text, maxChars), method: 'text', slides };
      }
      case 'zip': {
        const { text, entries } = await zipText(bytes, options.maxZipEntries ?? DEFAULT_MAX_ENTRIES, maxChars);
        return { text: cap(text, maxChars), method: entries > 0 ? 'text' : 'none', entries, ...(entries === 0 ? { reason: 'the archive holds no text files' } : {}) };
      }
      case 'image':
        return viaOcr('an image');
      case 'other':
        return { text: '', method: 'none', reason: `no reader for ${mediaType || 'this file type'}` };
    }
  } catch (error) {
    return { text: '', method: 'none', reason: `could not read the file: ${error instanceof Error ? error.message : String(error)}` };
  }
}
