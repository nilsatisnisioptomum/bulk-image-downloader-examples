import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm, open, stat, symlink, lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, actorInput, downloadDataset } from '../node/download_from_scraper_dataset.js';

globalThis.fetch = () => { throw new Error('Unexpected network access in offline recovery tests'); };
// Complete one-member ZIP authored locally with Python zipfile, not a signature-only stub.
const zip = Buffer.from('UEsDBBQAAAAAAAAAIVwQWZaGGwAAABsAAAARAAAAaW1hZ2UtZml4dHVyZS50eHRTeW50aGV0aWMgbG9jYWwgWklQIGZpeHR1cmVQSwECFAMUAAAAAAAAACFcEFmWhhsAAAAbAAAAEQAAAAAAAAAAAAAAgAEAAAAAaW1hZ2UtZml4dHVyZS50eHRQSwUGAAAAAAEAAQA/AAAASgAAAAAA', 'base64');
const run = { id: 'run123', actId: 'actor123', userId: 'user123', status: 'SUCCEEDED', defaultKeyValueStoreId: 'store123' };
const input = actorInput(parseArgs(['dataset123']));
const data = value => Response.json({ data: value });
async function setup(t, paid = false) {
  const dir = await mkdtemp(join(tmpdir(), 'bulk-recovery-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { ...parseArgs(paid ? ['dataset123', '--run', '--max-charge-usd', '0.10'] : ['--resume-run', 'run123']), output: join(dir, 'images.zip') };
}
function transport(overrides = {}) {
  const calls = [];
  const routes = {
    '/v2/users/me': () => data({ id: 'user123' }),
    '/v2/actor-runs/run123': () => data(run),
    '/v2/actors/chris_elder~bulk-file-downloader': () => data({ id: 'actor123' }),
    '/v2/key-value-stores/store123/records/INPUT': () => Response.json(input),
    '/v2/key-value-stores/store123/records/OUTPUT.zip': () => new Response(zip),
    ...overrides,
  };
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.method || 'GET', 'GET', 'Resume must NEVER start, restart or modify a run');
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.apify.com');
    assert.equal(parsed.search, '');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(Object.hasOwn(routes, parsed.pathname), `Unexpected endpoint: ${parsed.pathname}`);
    return routes[parsed.pathname]();
  } };
}
const execute = (options, fake, extra = {}) => downloadDataset(options, { token: 'synthetic-token', fetchImpl: fake.fetchImpl, ...extra });

test('standalone resume rejects mixed, duplicate, inherited and malformed arguments', () => {
  assert.deepEqual(parseArgs(['--resume-run', 'run123', '--output', 'recovered.zip']), { resumeRun: 'run123', output: 'recovered.zip', run: false });
  assert.equal(parseArgs(['--resume-run', '-run_123']).resumeRun, '-run_123');
  assert.equal(parseArgs(['-dataset_123']).datasetId, '-dataset_123');
  for (const args of [
    ['--resume-run'], ['--resume-run', '../run'], ['--resume-run', 'https://example.com/run'],
    ['--resume-run', '--run'], ['--resume-run', '--output'], ['--resume-run', '--max-charge-usd'],
    ['--run'], ['--output', 'images.zip'], ['--max-charge-usd', '0.10'],
    ['--resume-run', 'run123', '--run'], ['--resume-run', 'run123', '--max-charge-usd', '0.10'],
    ['--resume-run', 'run123', '--url-field', 'images'], ['--resume-run', 'run123', '--name-field', 'sku'],
    ['--resume-run', 'run123', '--max-files', '20'], ['--resume-run', 'run123', 'dataset123'],
    ['dataset123', '--resume-run', 'run123'], ['--resume-run', 'run123', '--output'],
    ['--resume-run', 'run123', '--output', 'a.zip', '--output', 'b.zip'],
    ['dataset123', '--run', '--run', '--max-charge-usd', '0.10'],
    ['--resume-run', 'run123', 'constructor', 'value'], ['dataset123', '__proto__', 'value'],
    ['dataset123', '--max-files', '5001'],
  ]) assert.throws(() => parseArgs(args));
});

test('resume fetches only five authenticated fixed-origin GETs and saves exact ZIP bytes', async t => {
  const options = await setup(t);
  const fake = transport();
  const result = await execute(options, fake);
  assert.equal(result.resumed, true);
  assert.equal(result.runId, 'run123');
  assert.deepEqual(await readFile(options.output), zip);
  assert.equal(fake.calls.length, 5);
  assert.equal(fake.calls.filter(call => call.init.method === 'POST').length, 0);
  assert.equal(fake.calls[3].url, 'https://api.apify.com/v2/key-value-stores/store123/records/INPUT');
  assert.ok(!JSON.stringify(result).includes('synthetic-token'));
  if (process.platform !== 'win32') assert.equal((await stat(options.output)).mode & 0o077, 0);
});

test('resume has no tokenless fallback or paid API path', async t => {
  const options = await setup(t);
  const fake = transport();
  await assert.rejects(downloadDataset(options, { fetchImpl: fake.fetchImpl }), /APIFY_TOKEN/);
  assert.equal(fake.calls.length, 0);
  await assert.rejects(access(options.output));
  await assert.rejects(execute({ ...options, run: true, maxChargeUsd: 0.10 }, fake), /separate mode/);
  for (const resumeRun of ['--run', '--output', '--max-charge-usd']) {
    await assert.rejects(execute({ ...options, resumeRun }, fake), /requires a run ID/);
  }
  for (const datasetId of ['--run', '--output', '--max-charge-usd']) {
    await assert.rejects(execute({ ...parseArgs(['dataset123', '--run', '--max-charge-usd', '0.10']), output: options.output, datasetId }, fake), /Dataset ID/);
  }
  assert.equal(fake.calls.length, 0);
});

test('existing outputs and live or dangling symlinks cause zero resume API requests', async t => {
  for (const kind of ['file', 'symlink', 'dangling']) {
    const options = await setup(t);
    const target = options.output + '.target';
    if (kind === 'file') await writeFile(options.output, 'preserve original');
    else {
      if (kind === 'symlink') await writeFile(target, 'preserve target');
      await symlink(target, options.output);
    }
    const fake = transport();
    await assert.rejects(execute(options, fake), { code: 'EEXIST' });
    assert.equal(fake.calls.length, 0);
    if (kind === 'file') assert.equal(await readFile(options.output, 'utf8'), 'preserve original');
    else assert.equal((await lstat(options.output)).isSymbolicLink(), true);
    if (kind === 'symlink') assert.equal(await readFile(target, 'utf8'), 'preserve target');
  }
});

test('every active or unsuccessful run rejects without polling, fetching ZIP or POST', async t => {
  for (const status of ['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING', 'FAILED', 'TIMED-OUT', 'ABORTED', 'UNKNOWN']) {
    const options = await setup(t);
    const fake = transport({ '/v2/actor-runs/run123': () => data({ ...run, status }) });
    await assert.rejects(execute(options, fake), /not SUCCEEDED/);
    assert.equal(fake.calls.length, 2);
    await assert.rejects(access(options.output));
  }
});

test('shared or organization runs with another userId are deliberately unsupported', async t => {
  const options = await setup(t);
  const fake = transport({ '/v2/actor-runs/run123': () => data({ ...run, userId: 'organization123' }) });
  await assert.rejects(execute(options, fake), /does not belong/);
  assert.equal(fake.calls.length, 2);
  await assert.rejects(access(options.output));
});

test('wrong Actor, unverifiable Actor or metamorphed runs never fetch stored input or ZIP', async t => {
  for (const actor of [null, {}, { id: 'anotherActor' }, { id: '../actor' }]) {
    const options = await setup(t);
    const fake = transport({ '/v2/actors/chris_elder~bulk-file-downloader': () => data(actor) });
    await assert.rejects(execute(options, fake), /not a run/);
    assert.equal(fake.calls.length, 3);
    await assert.rejects(access(options.output));
  }
  for (const metamorphs of [[{ actorId: 'anotherActor' }], 'malformed']) {
    const options = await setup(t);
    const fake = transport({ '/v2/actor-runs/run123': () => data({ ...run, metamorphs }) });
    await assert.rejects(execute(options, fake), /Metamorphed/);
    assert.equal(fake.calls.length, 2);
  }
});

test('malformed run IDs and store IDs are rejected before constructing storage paths', async t => {
  for (const value of [null, {}, { ...run, id: 'otherRun' }, { ...run, id: '../run' }, { ...run, actId: '../actor' }, { ...run, defaultKeyValueStoreId: '../store?token=secret' }, { ...run, defaultKeyValueStoreId: '' }]) {
    const options = await setup(t);
    const fake = transport({ '/v2/actor-runs/run123': () => data(value) });
    await assert.rejects(execute(options, fake), /unexpected run/);
    assert.equal(fake.calls.length, 2);
    await assert.rejects(access(options.output));
  }
});

test('account lookup must return a valid token-account ID', async t => {
  for (const value of [null, {}, { id: '../account' }]) {
    const options = await setup(t);
    const fake = transport({ '/v2/users/me': () => data(value) });
    await assert.rejects(execute(options, fake), /verify.*account/);
    assert.equal(fake.calls.length, 1);
    await assert.rejects(access(options.output));
  }
});

test('stored INPUT must be the explicit dataset ZIP shape, not other modes or a custom zipKey', async t => {
  for (const value of [null, [], { data: input }, { ...input, createZip: false }, { ...input, onlyImages: false },
    { ...input, datasetId: '../dataset' }, { ...input, urlField: '' }, { ...input, fileNameField: null },
    { ...input, maxFiles: 0 }, { ...input, maxFiles: 1.5 }, { ...input, maxFiles: 5001 },
    { ...input, urls: ['https://example.com/private?signature=synthetic-secret'] },
    { ...input, csvUrl: 'https://example.com/private?signature=synthetic-secret' },
    { ...input, pageUrls: ['https://example.com/private?signature=synthetic-secret'] },
    { ...input, zipKey: 'custom.zip' },
  ]) {
    const options = await setup(t);
    const fake = transport({ '/v2/key-value-stores/store123/records/INPUT': () => Response.json(value) });
    await assert.rejects(execute(options, fake), error => /Stored INPUT/.test(error.message) && !error.message.includes('synthetic-secret'));
    assert.equal(fake.calls.length, 4);
    await assert.rejects(access(options.output));
  }
});

test('default explicit zipKey and empty unused sources can recover without changing input', async t => {
  for (const metamorphs of [null, []]) {
    const options = await setup(t);
    const fake = transport({
      '/v2/actor-runs/run123': () => data({ ...run, metamorphs }),
      '/v2/key-value-stores/store123/records/INPUT': () => Response.json({ ...input, zipKey: 'OUTPUT.zip', urls: [], pageUrls: [], csvUrl: '' }),
    });
    await execute(options, fake);
    assert.deepEqual(await readFile(options.output), zip);
  }
});

test('expired or inaccessible run, INPUT or ZIP fails without retry or another start', async t => {
  for (const [path, index] of [['/v2/actor-runs/run123', 2], ['/v2/key-value-stores/store123/records/INPUT', 4], ['/v2/key-value-stores/store123/records/OUTPUT.zip', 5]]) {
    const options = await setup(t);
    const fake = transport({ [path]: () => new Response('synthetic-private-error', { status: 404 }) });
    await assert.rejects(execute(options, fake), error => /HTTP 404/.test(error.message) && !error.message.includes('synthetic-private-error'));
    assert.equal(fake.calls.length, index);
    await assert.rejects(access(options.output));
  }
});

test('malformed, oversized and invalid UTF-8 JSON never echo response secrets', async t => {
  for (const body of ['{"synthetic-secret": BROKEN}', ' '.repeat(256 * 1024 + 1), Buffer.from([0xff, 0xfe])]) {
    const options = await setup(t);
    const fake = transport({ '/v2/users/me': () => new Response(body) });
    await assert.rejects(execute(options, fake), error => /JSON/.test(error.message) && !error.message.includes('synthetic-secret'));
    assert.equal(fake.calls.length, 1);
    await assert.rejects(access(options.output));
  }
});

test('oversized JSON streams are canceled on their bounded parse failure', async t => {
  const options = await setup(t);
  let canceled = false;
  const fake = transport({ '/v2/users/me': () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
    cancel() { canceled = true; },
  })) });
  await assert.rejects(execute(options, fake), /256 KiB/);
  assert.equal(canceled, true);
  await assert.rejects(access(options.output));
});

test('network and redirected responses cannot trigger a new run or follow another origin', async t => {
  for (const result of [() => { throw new Error('synthetic transport failure'); }, () => new Response('', { status: 302, headers: { Location: 'https://example.com/elsewhere' } })]) {
    const options = await setup(t);
    const fake = transport({ '/v2/users/me': result });
    await assert.rejects(execute(options, fake), /transport failure|HTTP 302/);
    assert.equal(fake.calls.length, 1);
    await assert.rejects(access(options.output));
  }
});

test('local write and close failures remove only this invocation’s partial output', async t => {
  for (const phase of ['write', 'close']) {
    const options = await setup(t);
    const fake = transport();
    let failed = false;
    const openFile = async (...args) => {
      const file = await open(...args);
      return { stat: () => file.stat(), writeFile: async chunk => {
        if (phase === 'write') throw new Error('synthetic disk write failure');
        return file.writeFile(chunk);
      }, close: async () => {
        await file.close();
        if (phase === 'close' && !failed) { failed = true; throw new Error('synthetic disk close failure'); }
      } };
    };
    await assert.rejects(execute(options, fake, { openFile }), /synthetic disk/);
    await assert.rejects(access(options.output));
  }
});

test('successful download cannot claim a replaced or deleted destination as saved', async t => {
  for (const replacement of ['file', 'symlink', 'deleted']) {
    const options = await setup(t);
    const target = options.output + '.target';
    await writeFile(target, 'preserve target');
    const fake = transport({ '/v2/key-value-stores/store123/records/OUTPUT.zip': async () => {
      await unlink(options.output);
      if (replacement === 'file') await writeFile(options.output, 'user replacement');
      if (replacement === 'symlink') await symlink(target, options.output);
      return new Response(zip);
    } });
    await assert.rejects(execute(options, fake), /Output file changed/);
    if (replacement === 'file') assert.equal(await readFile(options.output, 'utf8'), 'user replacement');
    if (replacement === 'symlink') assert.equal((await lstat(options.output)).isSymbolicLink(), true);
    if (replacement === 'deleted') await assert.rejects(access(options.output));
    assert.equal(await readFile(target, 'utf8'), 'preserve target');
  }
});

test('API failure cleanup preserves a replacement instead of blindly unlinking it', async t => {
  const options = await setup(t);
  const fake = transport({ '/v2/users/me': async () => {
    await unlink(options.output);
    await writeFile(options.output, 'user replacement');
    throw new Error('synthetic network failure');
  } });
  await assert.rejects(execute(options, fake), /synthetic network/);
  assert.equal(await readFile(options.output, 'utf8'), 'user replacement');
});

test('paid-run mode shares exclusive0600, close-failure and replacement protections', async t => {
  for (const phase of ['mode', 'close', 'replaced']) {
    const options = await setup(t, true);
    let calls = 0;
    const fetchImpl = async () => {
      if (++calls === 1) return data(run);
      if (phase === 'replaced') { await unlink(options.output); await writeFile(options.output, 'user replacement'); }
      return new Response(zip);
    };
    const openFile = async (...args) => {
      assert.equal(args[1], 'wx');
      assert.equal(args[2], 0o600);
      const file = await open(...args);
      let failed = false;
      return { stat: () => file.stat(), writeFile: chunk => file.writeFile(chunk), close: async () => {
        await file.close();
        if (phase === 'close' && !failed) { failed = true; throw new Error('synthetic close failure'); }
      } };
    };
    const promise = downloadDataset(options, { token: 'synthetic-token', fetchImpl, openFile });
    if (phase === 'mode') assert.equal((await promise).resumed, false);
    else await assert.rejects(promise, /close failure|Output file changed/);
    if (phase === 'close') await assert.rejects(access(options.output));
    if (phase === 'replaced') assert.equal(await readFile(options.output, 'utf8'), 'user replacement');
  }
});

test('timeout DOMExceptions retain actionable run context without a read-only message error', async t => {
  for (const paid of [false, true]) {
    const options = await setup(t, paid);
    const fake = transport({ '/v2/key-value-stores/store123/records/INPUT': () => { throw new DOMException('Synthetic timeout', 'TimeoutError'); } });
    let calls = 0;
    const fetchImpl = paid ? async () => {
      if (++calls === 1) return data(run);
      throw new DOMException('Synthetic timeout', 'TimeoutError');
    } : fake.fetchImpl;
    await assert.rejects(downloadDataset(options, { token: 'synthetic-token', fetchImpl }), error =>
      /Synthetic timeout/.test(error.message) && /console.apify.com\/actors\/runs\/run123/.test(error.message) && !(error instanceof TypeError));
    await assert.rejects(access(options.output));
  }
});
