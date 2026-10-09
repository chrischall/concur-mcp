import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { GET_EXPENSE } from '../src/graphql/expenses.js';
import {
  APPEND_RECEIPT,
  ATTACH_RECEIPT,
  DELETE_RECEIPT,
  DETACH_RECEIPT,
  GET_RECEIPT,
  LIST_AVAILABLE_RECEIPTS,
} from '../src/graphql/receipts.js';
import { DiskReceiptOutput, InlineReceiptOutput, MAX_INLINE_BYTES, type ReceiptOutput } from '../src/receipt-files.js';
import { makeReceiptTools, registerReceiptTools } from '../src/tools/receipts.js';
import { SUB, fieldError, gqlPartial, textOf, toolHarness, untrustedPayload, type SentRequest } from './helpers.js';

const RID = '0123456789ABCDEF0123';
const EID = '0123456789abcdef0123456789abcdef';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const PDF = new TextEncoder().encode('%PDF-1.4\n%fake\n');
const IMAGE_URL = 'https://www-us2.api.concursolutions.com/receipts/IMG1?sig=abc';

let harness: TestHarness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'concur-receipt-tools-'));
  dirs.push(d);
  return d;
};

const isMutation = (s: SentRequest) => /^\s*mutation\b/.test(s.query);
const isUpload = (s: SentRequest) => s.url.endsWith('/spend-graphql/upload');
const writes = (sent: SentRequest[]) => sent.filter((s) => isMutation(s) || isUpload(s));

interface Preview {
  status: string;
  confirmToken: string;
  preview: Record<string, unknown> & { action: string };
}

async function setup(script: unknown[], opts: { output?: ReceiptOutput; root?: string } = {}) {
  const root = opts.root ?? tmp();
  const t = await toolHarness(
    makeReceiptTools({ output: opts.output ?? new InlineReceiptOutput(), roots: () => [root], baseDir: root }),
    script,
  );
  harness = t.harness;
  return { ...t, root };
}

/** Both phases: preview (no writes), then the same args + token. */
async function confirmed(name: string, args: Record<string, unknown>, script: unknown[], root?: string) {
  const t = await setup(script, { root });
  const first = parseToolResult<Preview>(await t.harness.callTool(name, args));
  expect(first.status).toBe('confirmation-required');
  expect(writes(t.sent)).toEqual([]);
  const phase1 = t.sent.length;
  const result = await t.harness.callTool(name, { ...args, confirmToken: first.confirmToken });
  return { preview: first, result, text: textOf(result), sent: t.sent.slice(phase1), jwt: t.jwt };
}

// ── fixtures ──────────────────────────────────────────────────────────────

const receipt = (imageId: string, over: Record<string, unknown> = {}) => ({
  imageId,
  receiptId: `R-${imageId}`,
  fileType: 'PNG',
  imageDate: '2026-10-02',
  fileName: 'lunch.png',
  imageOrigin: 'UPLOAD',
  imageUrl: IMAGE_URL,
  thumbUrl: 'https://www-us2.api.concursolutions.com/thumb/IMG1',
  receiptDigitizationStatus: 'COMPLETE',
  complianceCountryCode: null,
  complianceType: null,
  meta: { canDeleteReceipt: true, canAppendReceipt: false, canDownloadReceipt: true, isEbunshoReceipt: false },
  ...over,
});

const available = (...receipts: unknown[]) => ({ employee: { userId: SUB, availableReceipts: receipts } });

const expenseData = (receiptImageId: string | null = null) => ({
  entryExceptions: { entryExceptions: [], itemizationsExceptions: [] },
  employee: {
    userId: SUB,
    expenseReport: {
      reportId: RID,
      reportDetails: { id: RID, name: 'October travel', currencyCode: 'USD', policy: { id: 'POL1', expenseListDetailFormId: 'F1' } },
      entry: {
        id: EID,
        transactionDate: '2026-10-02',
        expenseType: { id: 'DUESX', name: 'Dues' },
        vendor: { description: 'Acme' },
        transactionAmount: { value: 12.5, currencyCode: 'USD' },
        receiptImageId,
      },
    },
  },
  existingExpenseForm: { expenseTypeId: 'DUESX', mainForm: { isFormEditable: true, fields: [] } },
});

const entryImage = (field: string, receiptImageId: string | null) => ({
  employee: { expenseReport: { entry: { [field]: { id: EID, receiptImageId } } } },
});

const accepted = (imageId = 'NEWIMG') =>
  new Response(JSON.stringify({ imageId, id: `ID-${imageId}` }), { status: 202, headers: { 'content-type': 'application/json' } });

/** The live failure: the post-write re-read answered only errors[] (a legacy-backed field). */
const failedReRead = () =>
  new Response(JSON.stringify({ data: null, errors: [fieldError(['employee'], 'corr-reread')] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function expectUnverifiedSuccess(result: unknown, text: string) {
  expect((result as { isError?: boolean }).isError).toBeFalsy();
  const out = untrustedPayload(text);
  expect(out.verified).toBeUndefined();
  expect(out.verificationError).toMatch(/The change was made, but re-reading it failed: .*correlationId=corr-reread/);
  return out;
}

const bytes = (b: Uint8Array, type = 'image/png') => new Response(b, { status: 200, headers: { 'content-type': type } });

// ── annotations ───────────────────────────────────────────────────────────

describe('receipt tools', () => {
  it('register with truthful annotations; every Concur write is confirm-gated', async () => {
    const t = await setup([]);
    const { tools } = await t.harness.client.listTools();
    const by = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(by).sort()).toEqual(
      [
        'concur_append_receipt',
        'concur_attach_receipt',
        'concur_delete_receipt',
        'concur_detach_receipt',
        'concur_get_receipt',
        'concur_list_available_receipts',
        'concur_upload_receipt',
      ].sort(),
    );
    expect(by.concur_list_available_receipts!.annotations?.readOnlyHint).toBe(true);
    expect(by.concur_get_receipt!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    const gated = {
      concur_upload_receipt: true, // append: true cannot be undone
      concur_attach_receipt: false,
      concur_append_receipt: true, // no tool removes a single appended page
      concur_detach_receipt: false,
      concur_delete_receipt: true,
    };
    for (const [name, destructive] of Object.entries(gated)) {
      const tool = by[name]!;
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(destructive);
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain('confirmToken');
      expect(tool.description).toMatch(/confirmToken/);
    }
    expect(by.concur_get_receipt!.inputSchema.properties).not.toHaveProperty('confirmToken');
  });
});

// ── list ──────────────────────────────────────────────────────────────────

describe('concur_list_available_receipts', () => {
  it('compact: no signed URLs, true permissions by name, untrusted-framed', async () => {
    const t = await setup([available(receipt('IMG1'), receipt('IMG2', { meta: null }))]);
    const text = textOf(await t.harness.callTool('concur_list_available_receipts', {}));
    expect(t.sent[0]!.query).toBe(LIST_AVAILABLE_RECEIPTS);
    expect(t.sent[0]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER' });
    const out = untrustedPayload(text) as { count: number; receipts: Array<Record<string, unknown>> };
    expect(out.count).toBe(2);
    expect(out.receipts[0]).toEqual({
      imageId: 'IMG1',
      receiptId: 'R-IMG1',
      fileName: 'lunch.png',
      fileType: 'PNG',
      date: '2026-10-02',
      origin: 'UPLOAD',
      status: 'COMPLETE',
      allowed: ['canDeleteReceipt', 'canDownloadReceipt'],
    });
    expect(text).not.toContain('sig=abc');
    expect(out.receipts[1]).not.toHaveProperty('allowed');
  });

  it('full keeps the URLs; raw is the GraphQL data', async () => {
    const t = await setup([available(receipt('IMG1')), available(receipt('IMG1'))]);
    const full = textOf(await t.harness.callTool('concur_list_available_receipts', { view: 'full' }));
    expect(full).toContain('sig=abc');
    const raw = textOf(await t.harness.callTool('concur_list_available_receipts', { view: 'raw' }));
    expect(raw).toContain('availableReceipts');
  });

  it('a failed receipt store is the mapped Concur error, not an empty list', async () => {
    const t = await setup([gqlPartial({ employee: { availableReceipts: null } }, fieldError(['employee', 'availableReceipts'], 'corr-r'))]);
    const err = await t.harness.callTool('concur_list_available_receipts', {});
    expect(err.isError).toBe(true);
    expect(textOf(err)).toMatch(/correlationId=corr-r/);
  });

  it('an empty store is a zero count; a missing employee is an error', async () => {
    const t = await setup([{ employee: { availableReceipts: null } }, { employee: null }]);
    const out = untrustedPayload(textOf(await t.harness.callTool('concur_list_available_receipts', {})));
    expect(out).toEqual({ count: 0, receipts: [] });
    const err = await t.harness.callTool('concur_list_available_receipts', {});
    expect(err.isError).toBe(true);
    expect(textOf(err)).toMatch(/no employee record/);
  });
});

// ── get ───────────────────────────────────────────────────────────────────

describe('concur_get_receipt', () => {
  const lineItem = (r: unknown) => ({ employee: { userId: SUB, lineItemImage: r } });

  it('locally saves the image (never overwriting) and returns the path', async () => {
    const dir = tmp();
    const output = new DiskReceiptOutput({ CONCUR_OUTPUT_DIR: dir });
    const t = await setup([lineItem(receipt('IMG1')), bytes(PNG), lineItem(receipt('IMG1')), bytes(PNG)], { output });
    const first = untrustedPayload(textOf(await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1', reportId: RID })));
    expect(t.sent[0]!.query).toBe(GET_RECEIPT);
    expect(t.sent[0]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', imageId: 'IMG1', reportId: RID });
    expect(t.sent[1]!.url).toBe(IMAGE_URL);
    expect(first).toMatchObject({ mimeType: 'image/png', bytes: PNG.byteLength, inline: false, savedTo: join(dir, 'receipt-IMG1.png') });
    expect(new Uint8Array(readFileSync(join(dir, 'receipt-IMG1.png')))).toEqual(PNG);
    expect(JSON.stringify(first.receipt)).not.toContain('sig=abc');
    const second = untrustedPayload(textOf(await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1' })));
    expect(second.savedTo).toBe(join(dir, 'receipt-IMG1-2.png'));
    expect(t.sent[2]!.variables).not.toHaveProperty('reportId');
  });

  it('inline: true returns an image block and writes nothing', async () => {
    const dir = tmp();
    const output = new DiskReceiptOutput({ CONCUR_OUTPUT_DIR: dir });
    const t = await setup([lineItem(receipt('IMG1')), bytes(PNG, 'application/octet-stream')], { output });
    const result = await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1', inline: true });
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') });
    expect(untrustedPayload(textOf(result))).toMatchObject({ inline: true, mimeType: 'image/png' });
    expect(untrustedPayload(textOf(result))).not.toHaveProperty('savedTo');
  });

  it('hosted (inline output) is always inline; a PDF comes back as an embedded resource', async () => {
    const t = await setup([lineItem(receipt('IMG1', { fileType: 'PDF' })), bytes(PDF, 'application/pdf')]);
    const result = await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1' });
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({
      type: 'resource',
      resource: { uri: 'concur-receipt:IMG1', mimeType: 'application/pdf', blob: Buffer.from(PDF).toString('base64') },
    });
  });

  it('falls back to the response content type when the bytes are not sniffable', async () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2]);
    const t = await setup([lineItem(receipt('IMG1')), bytes(tiff, 'image/tiff')]);
    const result = await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1' });
    expect((result.content as Array<{ type: string }>)[1]!.type).toBe('resource');
    expect(untrustedPayload(textOf(result)).mimeType).toBe('image/tiff');
  });

  it('over the inline cap: hosted says so; local saves instead', async () => {
    const big = new Uint8Array(MAX_INLINE_BYTES + 1);
    big.set(PNG);
    const hosted = await setup([lineItem(receipt('IMG1')), bytes(big)]);
    const out = untrustedPayload(textOf(await hosted.harness.callTool('concur_get_receipt', { imageId: 'IMG1' })));
    expect(out).toMatchObject({ inline: false });
    expect(out.notice).toMatch(/inline limit/);
    expect(out).not.toHaveProperty('savedTo');
    await harness?.close();

    const dir = tmp();
    const local = await setup([lineItem(receipt('IMG1')), bytes(big)], { output: new DiskReceiptOutput({ CONCUR_OUTPUT_DIR: dir }) });
    const saved = untrustedPayload(textOf(await local.harness.callTool('concur_get_receipt', { imageId: 'IMG1', inline: true })));
    expect(saved.savedTo).toBe(join(dir, 'receipt-IMG1.png'));
    expect(saved.notice).toMatch(/saved instead/);
  });

  it('unsniffable bytes with no content type are application/octet-stream', async () => {
    const res = new Response(new Uint8Array([7, 7, 7]), { status: 200 });
    res.headers.delete('content-type');
    const t = await setup([lineItem(receipt('IMG1')), res]);
    const result = await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1' });
    expect(untrustedPayload(textOf(result)).mimeType).toBe('application/octet-stream');
  });

  it('full / raw views', async () => {
    const t = await setup([lineItem(receipt('IMG1')), bytes(PNG), lineItem(receipt('IMG1')), bytes(PNG)]);
    const full = untrustedPayload(textOf(await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1', view: 'full' })));
    expect((full.receipt as Record<string, unknown>).imageUrl).toBe(IMAGE_URL);
    const raw = untrustedPayload(textOf(await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1', view: 'raw' })));
    expect(raw.receipt).toHaveProperty('employee');
  });

  it('an unknown id or a receipt with no image URL is an actionable error, with no download', async () => {
    const t = await setup([lineItem(null), lineItem(receipt('IMG1', { imageUrl: null }))]);
    const missing = await t.harness.callTool('concur_get_receipt', { imageId: 'NOPE' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/no receipt image NOPE/);
    const noUrl = await t.harness.callTool('concur_get_receipt', { imageId: 'IMG1' });
    expect(textOf(noUrl)).toMatch(/no downloadable image/);
    expect(t.sent).toHaveLength(2);
  });

  it('refuses a malformed image id before any request', async () => {
    const t = await setup([]);
    const result = await t.harness.callTool('concur_get_receipt', { imageId: '../../etc' });
    expect(result.isError).toBe(true);
    expect(t.sent).toHaveLength(0);
  });
});

// ── upload ────────────────────────────────────────────────────────────────

describe('concur_upload_receipt', () => {
  const withFile = (name = 'lunch.png', data: Uint8Array = PNG) => {
    const root = tmp();
    writeFileSync(join(root, name), data);
    return root;
  };
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  it('previews the file (size, type, SHA-256), uploads on confirm, then re-reads the receipt store', async () => {
    const root = withFile();
    const { preview, sent, text, jwt } = await confirmed(
      'concur_upload_receipt',
      { path: 'lunch.png' },
      [accepted('NEWIMG'), available(receipt('NEWIMG'))],
      root,
    );
    expect(preview.preview.action).toBe('Upload lunch.png to your Concur available receipts');
    expect(JSON.stringify(preview.preview)).toContain(sha(PNG));
    expect(sent.map((s) => s.url)).toEqual([
      'https://www-us2.api.concursolutions.com/spend-graphql/upload',
      'https://www-us2.api.concursolutions.com/spend-graphql/graphql',
    ]);
    const part = (sent[0]!.init.body as FormData).get('file') as File;
    expect(part.name).toBe('lunch.png');
    expect(part.type).toBe('image/png');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG);
    expect(sent[1]!.query).toBe(LIST_AVAILABLE_RECEIPTS);
    const out = untrustedPayload(text);
    expect(out).toMatchObject({
      uploaded: true,
      imageId: 'NEWIMG',
      response: { imageId: 'NEWIMG', id: 'ID-NEWIMG' },
      verified: { inAvailableReceipts: true },
    });
    expect(text).not.toContain(jwt);
  });

  it('an upload whose store re-read fails is still a success with the imageId', async () => {
    const root = withFile();
    const { result, text } = await confirmed('concur_upload_receipt', { path: 'lunch.png' }, [accepted('NEWIMG'), failedReRead()], root);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ uploaded: true, imageId: 'NEWIMG' });
  });

  it('an upload + attach whose expense re-read fails is still a success', async () => {
    const root = withFile();
    const { result, text } = await confirmed(
      'concur_upload_receipt',
      { path: 'lunch.png', reportId: RID, expenseId: EID },
      [expenseData(), expenseData(), accepted('NEWIMG'), entryImage('attachImage', 'NEWIMG'), failedReRead()],
      root,
    );
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({
      uploaded: true,
      attached: true,
      imageId: 'NEWIMG',
      response: { upload: { imageId: 'NEWIMG' }, attachImage: { id: EID, receiptImageId: 'NEWIMG' } },
    });
  });

  it('says so when the upload is not in the store yet', async () => {
    const root = withFile();
    const { text } = await confirmed('concur_upload_receipt', { path: 'lunch.png' }, [accepted('NEWIMG'), available()], root);
    expect(untrustedPayload(text)).toMatchObject({
      uploaded: true,
      verified: { inAvailableReceipts: false, observed: expect.stringMatching(/processing/) },
    });
  });

  it('with reportId + expenseId: previews the expense, uploads, attaches, and re-reads the expense', async () => {
    const root = withFile('r.pdf', PDF);
    const { preview, sent, text } = await confirmed(
      'concur_upload_receipt',
      { path: join(root, 'r.pdf'), reportId: RID, expenseId: EID },
      [expenseData(), expenseData(), accepted('NEWIMG'), entryImage('attachImage', 'NEWIMG'), expenseData('NEWIMG')],
      root,
    );
    expect(preview.preview.action).toBe(`Upload r.pdf to Concur and attach it to expense ${EID}`);
    expect(JSON.stringify(preview.preview)).toContain('Acme');
    expect(sent.map((s) => s.query)).toEqual([GET_EXPENSE, '', ATTACH_RECEIPT, GET_EXPENSE]);
    expect(((sent[1]!.init.body as FormData).get('file') as File).type).toBe('application/pdf');
    expect(sent[2]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', reportId: RID, expenseId: EID, imageId: 'NEWIMG' });
    expect(untrustedPayload(text)).toMatchObject({
      uploaded: true,
      attached: true,
      imageId: 'NEWIMG',
      verified: { receiptImageId: 'NEWIMG' },
    });
  });

  it('refuses to attach over an existing receipt unless append: true (then AppendImage)', async () => {
    const root = withFile();
    const t = await setup([expenseData('OLD')], { root });
    const refused = await t.harness.callTool('concur_upload_receipt', { path: 'lunch.png', reportId: RID, expenseId: EID });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/already has a receipt.*append: true/s);
    expect(writes(t.sent)).toEqual([]);
    await harness?.close();

    const { sent, preview } = await confirmed(
      'concur_upload_receipt',
      { path: 'lunch.png', reportId: RID, expenseId: EID, append: true },
      [expenseData('OLD'), expenseData('OLD'), accepted('NEWIMG'), entryImage('appendImage', 'OLD'), expenseData('OLD')],
      root,
    );
    expect(preview.preview.action).toMatch(/append it to expense/);
    expect(sent[2]!.query).toBe(APPEND_RECEIPT);
  });

  it('append: true on an expense with no receipt simply attaches', async () => {
    const root = withFile();
    const { sent } = await confirmed(
      'concur_upload_receipt',
      { path: 'lunch.png', reportId: RID, expenseId: EID, append: true },
      [expenseData(), expenseData(), accepted('NEWIMG'), entryImage('attachImage', 'NEWIMG'), expenseData('NEWIMG')],
      root,
    );
    expect(sent[2]!.query).toBe(ATTACH_RECEIPT);
  });

  it('reports an attach the expense does not show yet', async () => {
    const root = withFile();
    const { text } = await confirmed(
      'concur_upload_receipt',
      { path: 'lunch.png', reportId: RID, expenseId: EID },
      [expenseData(), expenseData(), accepted('NEWIMG'), entryImage('attachImage', 'NEWIMG'), expenseData()],
      root,
    );
    const out = untrustedPayload(text);
    expect(out).toMatchObject({ uploaded: true, attached: true, imageId: 'NEWIMG' });
    expect((out.verified as Record<string, unknown>).receiptImageId).toBeUndefined();
    expect((out.verified as { observed: string }).observed).toMatch(/shows no receipt yet/);
  });

  it('the default registrar confines uploads to the env roots', async () => {
    const t = await toolHarness(registerReceiptTools, []);
    harness = t.harness;
    const result = await t.harness.callTool('concur_upload_receipt', { path: '/etc/hosts.png' });
    expect(result.isError).toBe(true);
    expect(writes(t.sent)).toEqual([]);
  });

  it('when attaching fails after the upload, it is still a success naming the uploaded image so it is not re-uploaded', async () => {
    const root = withFile();
    const { result, text } = await confirmed(
      'concur_upload_receipt',
      { path: 'lunch.png', reportId: RID, expenseId: EID },
      [expenseData(), expenseData(), accepted('NEWIMG'), { employee: { expenseReport: { entry: { attachImage: null } } } }],
      root,
    );
    expect(result.isError).toBeFalsy();
    const out = untrustedPayload(text);
    expect(out).toMatchObject({ uploaded: true, imageId: 'NEWIMG', attached: false, response: { imageId: 'NEWIMG' } });
    expect(out.attachError).toMatch(/did not confirm the attachImage change/);
    expect(out.next).toMatch(/concur_attach_receipt \(imageId NEWIMG\) — do not upload it again/);
  });

  it('needs both reportId and expenseId, or neither', async () => {
    const root = withFile();
    const t = await setup([], { root });
    const result = await t.harness.callTool('concur_upload_receipt', { path: 'lunch.png', expenseId: EID });
    expect(textOf(result)).toMatch(/both `reportId` and `expenseId`/);
    expect(t.sent).toHaveLength(0);
  });

  it.each([
    ['outside the upload roots', () => ({ path: '/etc/hosts', root: withFile() }), /outside|allowed/i],
    ['a disallowed extension', () => ({ path: 'notes.txt', root: withFile('notes.txt', new TextEncoder().encode('hi')) }), /extension|type/i],
    ['a renamed file whose bytes do not match', () => ({ path: 'fake.png', root: withFile('fake.png', new TextEncoder().encode('secret')) }), /does not look like/i],
    [
      'a hidden path segment',
      () => {
        const root = tmp();
        mkdirSync(join(root, '.ssh'));
        writeFileSync(join(root, '.ssh', 'k.png'), PNG);
        return { path: '.ssh/k.png', root };
      },
      /hidden|dot/i,
    ],
  ])('refuses %s before any upload', async (_label, make, pattern) => {
    const { path, root } = make();
    const t = await setup([], { root });
    const result = await t.harness.callTool('concur_upload_receipt', { path });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(pattern);
    expect(writes(t.sent)).toEqual([]);
  });

  it('a file changed after the preview invalidates the token (the SHA-256 is bound)', async () => {
    const root = withFile();
    const t = await setup([accepted()], { root });
    const first = parseToolResult<Preview>(await t.harness.callTool('concur_upload_receipt', { path: 'lunch.png' }));
    writeFileSync(join(root, 'lunch.png'), new Uint8Array([...PNG, 9]));
    const second = await t.harness.callTool('concur_upload_receipt', { path: 'lunch.png', confirmToken: first.confirmToken });
    expect(writes(t.sent)).toEqual([]);
    expect(textOf(second)).not.toMatch(/"uploaded":true/);
  });
});

// ── attach / append / detach ──────────────────────────────────────────────

describe('concur_attach_receipt / concur_append_receipt', () => {
  it('attach: previews the expense, attaches, and reports the observed receipt', async () => {
    const { preview, sent, text } = await confirmed(
      'concur_attach_receipt',
      { reportId: RID, expenseId: EID, imageId: 'IMG1' },
      [expenseData(), expenseData(), entryImage('attachImage', 'IMG1'), expenseData('IMG1')],
    );
    expect(preview.preview.action).toBe(`Attach receipt image IMG1 to expense ${EID}`);
    expect(sent.map((s) => s.query)).toEqual([GET_EXPENSE, ATTACH_RECEIPT, GET_EXPENSE]);
    expect(untrustedPayload(text)).toMatchObject({
      attached: true,
      reportId: RID,
      expenseId: EID,
      imageId: 'IMG1',
      response: { id: EID, receiptImageId: 'IMG1' },
      verified: { receiptImageId: 'IMG1', observed: 'the expense now shows receipt image IMG1' },
    });
  });

  it('an attach whose re-read fails is still a success', async () => {
    const { result, text } = await confirmed(
      'concur_attach_receipt',
      { reportId: RID, expenseId: EID, imageId: 'IMG1' },
      [expenseData(), expenseData(), entryImage('attachImage', 'IMG1'), failedReRead()],
    );
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ attached: true, expenseId: EID, imageId: 'IMG1' });
  });

  it('an append whose re-read fails is still a success', async () => {
    const { result, text } = await confirmed(
      'concur_append_receipt',
      { reportId: RID, expenseId: EID, imageId: 'IMG2' },
      [expenseData('IMG1'), expenseData('IMG1'), entryImage('appendImage', 'IMG1'), failedReRead()],
    );
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ attached: true, imageId: 'IMG2' });
  });

  it('attach onto an expense that already has a receipt is refused', async () => {
    const t = await setup([expenseData('OLD')]);
    const result = await t.harness.callTool('concur_attach_receipt', { reportId: RID, expenseId: EID, imageId: 'IMG1' });
    expect(textOf(result)).toMatch(/already has a receipt/);
    expect(writes(t.sent)).toEqual([]);
  });

  it('attach reports when the expense still shows no receipt', async () => {
    const { text } = await confirmed(
      'concur_attach_receipt',
      { reportId: RID, expenseId: EID, imageId: 'IMG1' },
      [expenseData(), expenseData(), entryImage('attachImage', null), expenseData()],
    );
    expect(untrustedPayload(text)).toMatchObject({
      attached: true,
      verified: { observed: 'Concur accepted the change but the expense shows no receipt — re-read it with concur_get_expense' },
    });
  });

  it('append: needs an existing receipt, then AppendImage', async () => {
    const t = await setup([expenseData()]);
    const refused = await t.harness.callTool('concur_append_receipt', { reportId: RID, expenseId: EID, imageId: 'IMG2' });
    expect(textOf(refused)).toMatch(/no receipt to append/);
    await harness?.close();

    const { sent, preview } = await confirmed(
      'concur_append_receipt',
      { reportId: RID, expenseId: EID, imageId: 'IMG2' },
      [expenseData('IMG1'), expenseData('IMG1'), entryImage('appendImage', 'IMG1'), expenseData('IMG1')],
    );
    expect(preview.preview.action).toBe(`Append receipt image IMG2 onto the receipt of expense ${EID}`);
    expect(sent[1]!.query).toBe(APPEND_RECEIPT);
  });

  it('an unconfirmed mutation answer is an error', async () => {
    const { result, text } = await confirmed(
      'concur_attach_receipt',
      { reportId: RID, expenseId: EID, imageId: 'IMG1' },
      [expenseData(), expenseData(), { employee: { expenseReport: { entry: null } } }],
    );
    expect(result.isError).toBe(true);
    expect(text).toMatch(/did not confirm/);
  });
});

describe('concur_detach_receipt', () => {
  it('detaches and reports whether the image went back to the store', async () => {
    const { preview, sent, text } = await confirmed(
      'concur_detach_receipt',
      { reportId: RID, expenseId: EID },
      [expenseData('IMG1'), expenseData('IMG1'), entryImage('detachImage', null), expenseData(), available(receipt('IMG1'))],
    );
    expect(preview.preview.action).toBe(`Detach receipt image IMG1 from expense ${EID}`);
    expect(sent.map((s) => s.query)).toEqual([GET_EXPENSE, DETACH_RECEIPT, GET_EXPENSE, LIST_AVAILABLE_RECEIPTS]);
    expect(sent[1]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', reportId: RID, expenseId: EID });
    expect(untrustedPayload(text)).toMatchObject({
      detached: true,
      detachedImageId: 'IMG1',
      response: { id: EID, receiptImageId: null },
      verified: {
        inAvailableReceipts: true,
        observed: 'the expense has no receipt now and the image is back in your available receipts',
      },
    });
  });

  it('a detach whose re-read fails is still a success', async () => {
    const { result, text } = await confirmed(
      'concur_detach_receipt',
      { reportId: RID, expenseId: EID },
      [expenseData('IMG1'), expenseData('IMG1'), entryImage('detachImage', null), failedReRead()],
    );
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ detached: true, detachedImageId: 'IMG1' });
  });

  it('reports an image that did not return, and an expense that still shows it', async () => {
    const gone = await confirmed(
      'concur_detach_receipt',
      { reportId: RID, expenseId: EID },
      [expenseData('IMG1'), expenseData('IMG1'), entryImage('detachImage', null), expenseData(), available()],
    );
    expect((untrustedPayload(gone.text).verified as { observed: string }).observed).toMatch(/not in your available receipts/);
    await harness?.close();
    const stuck = await confirmed(
      'concur_detach_receipt',
      { reportId: RID, expenseId: EID },
      [expenseData('IMG1'), expenseData('IMG1'), entryImage('detachImage', 'IMG1'), expenseData('IMG1'), available()],
    );
    expect(untrustedPayload(stuck.text)).toMatchObject({
      detached: true,
      verified: { receiptImageId: 'IMG1', observed: expect.stringMatching(/still shows receipt image IMG1/) },
    });
  });

  it('an expense with no receipt is refused', async () => {
    const t = await setup([expenseData()]);
    const result = await t.harness.callTool('concur_detach_receipt', { reportId: RID, expenseId: EID });
    expect(textOf(result)).toMatch(/no receipt to detach/);
  });
});

// ── delete ────────────────────────────────────────────────────────────────

describe('concur_delete_receipt', () => {
  it('previews the receipt, deletes, and confirms it left the store', async () => {
    const { preview, sent, text } = await confirmed(
      'concur_delete_receipt',
      { imageId: 'IMG1' },
      [available(receipt('IMG1')), available(receipt('IMG1')), { deleteReceipt: true }, available()],
    );
    expect(preview.preview.action).toBe('Permanently delete receipt image IMG1');
    expect(JSON.stringify(preview.preview)).toContain('lunch.png');
    expect(sent.map((s) => s.query)).toEqual([LIST_AVAILABLE_RECEIPTS, DELETE_RECEIPT, LIST_AVAILABLE_RECEIPTS]);
    expect(sent[1]!.variables).toEqual({ imageId: 'IMG1' });
    expect(untrustedPayload(text)).toEqual({
      deleted: true,
      imageId: 'IMG1',
      response: { deleteReceipt: true },
      verified: { gone: true, observed: 'the receipt is no longer in your available receipts', availableRemaining: 0 },
    });
  });

  it('a delete whose re-read fails is still a success', async () => {
    const { result, text } = await confirmed(
      'concur_delete_receipt',
      { imageId: 'IMG1' },
      [available(receipt('IMG1')), available(receipt('IMG1')), { deleteReceipt: true }, failedReRead()],
    );
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ deleted: true, imageId: 'IMG1' });
  });

  it('reports a receipt that is still there', async () => {
    const { text } = await confirmed(
      'concur_delete_receipt',
      { imageId: 'IMG1' },
      [available(receipt('IMG1')), available(receipt('IMG1')), { deleteReceipt: 'OK' }, available(receipt('IMG1'))],
    );
    expect(untrustedPayload(text)).toMatchObject({ deleted: true, verified: { gone: false } });
  });

  it('refuses a receipt not in the store, or one Concur forbids deleting', async () => {
    const t = await setup([available(), available(receipt('IMG1', { meta: { canDeleteReceipt: false } }))]);
    expect(textOf(await t.harness.callTool('concur_delete_receipt', { imageId: 'IMG1' }))).toMatch(/not in your available receipts/);
    expect(textOf(await t.harness.callTool('concur_delete_receipt', { imageId: 'IMG1' }))).toMatch(/does not allow/);
    expect(writes(t.sent)).toEqual([]);
  });

  it('a false / missing deleteReceipt is an error', async () => {
    const { result } = await confirmed(
      'concur_delete_receipt',
      { imageId: 'IMG1' },
      [available(receipt('IMG1')), available(receipt('IMG1')), { deleteReceipt: false }],
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/did not confirm/);
  });
});
