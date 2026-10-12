import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { FakeOcrProvider } from '@brain/models';
import { classify, extractText, markdownTable } from './extract.ts';

// A one-page PDF with a text layer, written by hand (no library makes PDFs here).
const PDF = Buffer.from(
  `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 60 >> stream
BT /F1 18 Tf 20 100 Td (Hello warehouse migration plan) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>`,
  'latin1',
);
// A PNG header only: enough to be an image for the classifier, never decoded here.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('extractText', () => {
  it('classifies by media type and by extension', () => {
    expect(classify('application/pdf', 'x.bin')).toBe('pdf');
    expect(classify('application/octet-stream', 'schema.ddl')).toBe('text');
    expect(classify('', 'deck.pptx')).toBe('pptx');
    expect(classify('image/png', 'scan.png')).toBe('image');
    expect(classify('application/octet-stream', 'thing.bin')).toBe('other');
  });

  it('reads text and Markdown as they are', async () => {
    const result = await extractText(Buffer.from('﻿# Scope\n\nThe warehouse.'), 'text/markdown', 'scope.md');
    expect(result).toMatchObject({ method: 'text', text: '# Scope\n\nThe warehouse.' });
  });

  it('turns CSV into a Markdown table', async () => {
    const result = await extractText(Buffer.from('name,qty\nbolt,12\nnut,"7"\n'), 'text/csv', 'parts.csv');
    expect(result.text).toBe('| name | qty |\n| --- | --- |\n| bolt | 12 |\n| nut | 7 |');
    expect(markdownTable([['a'], ['b', 'c']])).toBe('| a |  |\n| --- | --- |\n| b | c |');
  });

  it("reads a PDF's text layer", async () => {
    const result = await extractText(PDF, 'application/pdf', 'plan.pdf');
    expect(result.method).toBe('text');
    expect(result.pages).toBe(1);
    expect(result.text).toContain('Hello warehouse migration plan');
  });

  it('reads text files inside a zip archive and skips the rest', async () => {
    const zip = new JSZip();
    zip.file('README.md', '# Code archive');
    zip.file('src/main.ts', 'export const x = 1;');
    zip.file('bin/blob.bin', Buffer.from([0, 1, 2, 3]));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const result = await extractText(bytes, 'application/zip', 'code.zip');
    expect(result).toMatchObject({ method: 'text', entries: 2 });
    expect(result.text).toContain('## README.md');
    expect(result.text).toContain('export const x = 1;');
    expect(result.text).not.toContain('blob.bin');
  });

  it('sends images to the OCR provider when one is allowed, and says why when not', async () => {
    const ocr = new FakeOcrProvider(() => 'Invoice 4711 total 980 TRY');
    const read = await extractText(PNG, 'image/png', 'scan.png', { ocr });
    expect(read).toMatchObject({ method: 'ocr', text: 'Invoice 4711 total 980 TRY' });
    expect(ocr.calls).toEqual([{ mediaType: 'image/png', bytes: PNG.byteLength }]);
    const refused = await extractText(PNG, 'image/png', 'scan.png', { ocrUnavailable: 'confidential documents are never sent to a model' });
    expect(refused).toMatchObject({ method: 'none', text: '', reason: 'confidential documents are never sent to a model' });
  });

  it('never throws for a broken file', async () => {
    const result = await extractText(Buffer.from('not a zip'), 'application/zip', 'broken.zip');
    expect(result.method).toBe('none');
    expect(result.reason).toMatch(/could not read/);
  });
});
