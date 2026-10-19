import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, downloadDataset } from '../node/download_from_scraper_dataset.js';

const zip = Buffer.from('504b03041400000000000000000000000000000000000000000000000000', 'hex');
const run = { id: 'run123', status: 'SUCCEEDED', defaultKeyValueStoreId: 'store123' };
const response = data => Response.json({ data });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bulk-downloader-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { ...parseArgs(['dataset123', '--run', '--max-charge-usd', '0.10']), output: join(dir, 'images.zip') };
}

test('preview needs no token, creates no file and makes no requests', async t => {
  const options = await setup(t);
  options.run = false;
  const result = await downloadDataset(options, { fetchImpl: () => { throw new Error('network forbidden'); } });
  assert.equal(result.preview, true);
  assert.equal(result.input.maxFiles, 100);
  await assert.rejects(access(options.output));
});

test('CLI previews without dependencies or an API token', () => {
  const stdout = execFileSync(process.execPath, ['node/download_from_scraper_dataset.js', 'dataset123'], { cwd: new URL('..', import.meta.url), env: { ...process.env, APIFY_TOKEN: '' }, encoding: 'utf8' });
  assert.match(stdout, /Preview only; no API calls or charges/);
  assert.match(stdout, /"datasetId": "dataset123"/);
});

test('billable runs require an explicit positive cap and valid inputs', () => {
  for (const args of [[], ['https://example.com'], ['id', '--run'], ['id', '--run', '--max-charge-usd', '0'], ['id', '--run', '--max-charge-usd', 'Infinity'], ['id', '--max-files', '0'], ['id', '--max-files', '1.5'], ['id', '--output']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(['id', '--url-field', 'media.images', '--name-field', 'product.sku']).urlField, 'media.images');
});

test('successful runs include a charge cap and download authenticated ZIP bytes', async t => {
  const options = await setup(t);
  const calls = [];
  const result = await downloadDataset(options, { token: 'test-token-not-real', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? response(run) : new Response(zip);
  } });
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(await readFile(options.output), zip);
  assert.equal(new URL(calls[0].url).searchParams.get('maxTotalChargeUsd'), '0.1');
  assert.equal(new URL(calls[0].url).searchParams.get('timeout'), '300');
  assert.equal(JSON.parse(calls[0].init.body).createZip, true);
  assert.equal(JSON.parse(calls[0].init.body).onlyImages, true);
  assert.match(calls[1].url, /key-value-stores\/store123\/records\/OUTPUT.zip$/);
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, 'Bearer test-token-not-real');
    assert.equal(call.init.redirect, 'error');
    assert.ok(!call.url.includes('token'));
  }
});

test('a running job is polled rather than starting another paid run', async t => {
  const options = await setup(t);
  const methods = [];
  const delays = [];
  await downloadDataset(options, { token: 'fake', sleepImpl: async ms => { delays.push(ms); }, fetchImpl: async (url, init) => {
    methods.push(init.method || 'GET');
    if (methods.length === 1) return response({ ...run, status: 'RUNNING' });
    if (methods.length === 2) { assert.match(url, /actor-runs\/run123\?waitForFinish=60$/); return response(run); }
    return new Response(zip);
  } });
  assert.deepEqual(methods, ['POST', 'GET', 'GET']);
  assert.deepEqual(delays, [1000]);
});

test('immediately returning polls back off and stop at the deadline', async t => {
  const options = await setup(t);
  let elapsed = 0;
  const delays = [];
  const methods = [];
  await assert.rejects(downloadDataset(options, { token: 'fake', now: () => elapsed, sleepImpl: async ms => { delays.push(ms); elapsed += ms; }, fetchImpl: async (url, init) => {
    methods.push(init.method || 'GET');
    return response({ ...run, status: 'RUNNING' });
  } }), /Stopped waiting/);
  assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 10000]);
  assert.ok(delays.every(ms => ms > 0 && ms <= 10_000));
  assert.equal(elapsed, 360_000);
  assert.ok(methods.length <= 40);
  assert.equal(methods.filter(method => method === 'POST').length, 1);
  await assert.rejects(access(options.output));
});

test('failed or timed-out runs do not fetch a ZIP or leave an output file', async t => {
  for (const status of ['FAILED', 'TIMED-OUT', 'ABORTED']) {
    const options = await setup(t);
    let calls = 0;
    await assert.rejects(downloadDataset(options, { token: 'fake', fetchImpl: async () => { calls++; return response({ ...run, status }); } }), new RegExp(status));
    assert.equal(calls, 1);
    await assert.rejects(access(options.output));
  }
});

test('existing output is preserved before any billable request', async t => {
  const options = await setup(t);
  await writeFile(options.output, 'keep this');
  let called = false;
  await assert.rejects(downloadDataset(options, { token: 'fake', fetchImpl: async () => { called = true; } }), { code: 'EEXIST' });
  assert.equal(called, false);
  assert.equal(await readFile(options.output, 'utf8'), 'keep this');
});

test('API failures and ambiguous network errors are not retried', async t => {
  for (const failure of [new Response('Unauthorized', { status: 401 }), new Error('connection lost')]) {
    const options = await setup(t);
    let calls = 0;
    await assert.rejects(downloadDataset(options, { token: 'fake', fetchImpl: async () => {
      calls++;
      if (failure instanceof Error) throw failure;
      return failure;
    } }));
    assert.equal(calls, 1);
    await assert.rejects(access(options.output));
  }
});

test('invalid and empty ZIPs are rejected and removed', async t => {
  for (const payload of [Buffer.from('{"error":"missing"}'), Buffer.from('504b0506000000000000000000000000000000000000', 'hex')]) {
    const options = await setup(t);
    let calls = 0;
    await assert.rejects(downloadDataset(options, { token: 'fake', fetchImpl: async () => ++calls === 1 ? response(run) : new Response(payload) }), /ZIP/);
    await assert.rejects(access(options.output));
  }
});

test('stream interruptions remove partial downloads', async t => {
  const options = await setup(t);
  let calls = 0;
  let pulls = 0;
  await assert.rejects(downloadDataset(options, { token: 'fake', fetchImpl: async () => {
    if (++calls === 1) return response(run);
    return new Response(new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(zip);
      else controller.error(new Error('interrupted'));
    } }));
  } }), /interrupted/);
  await assert.rejects(access(options.output));
});
