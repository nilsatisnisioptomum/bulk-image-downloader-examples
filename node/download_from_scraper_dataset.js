// Dataset product images -> an authenticated ZIP download. Node 20+, no packages.
// Preview: node node/download_from_scraper_dataset.js DATASET_ID
// Run: add --run --max-charge-usd 0.10 (starts a billable Apify run).
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.apify.com/v2';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const ACTIVE = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);

export function parseArgs(args) {
  const result = { datasetId: args[0], urlField: 'images', fileNameField: 'sku', maxFiles: 100, output: 'files.zip', run: false };
  if (!result.datasetId || !/^[A-Za-z0-9_-]+$/.test(result.datasetId)) throw new Error('Provide the scraper Dataset ID, not a run ID or URL.');
  const names = { '--url-field': 'urlField', '--name-field': 'fileNameField', '--max-files': 'maxFiles', '--output': 'output', '--max-charge-usd': 'maxChargeUsd' };
  for (let i = 1; i < args.length; i++) {
    const option = args[i];
    if (option === '--run') { result.run = true; continue; }
    if (!names[option] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${option}`);
    result[names[option]] = args[++i];
  }
  result.maxFiles = Number(result.maxFiles);
  if (!Number.isSafeInteger(result.maxFiles) || result.maxFiles < 1) throw new Error('--max-files must be a positive integer.');
  if (result.maxChargeUsd !== undefined) result.maxChargeUsd = Number(result.maxChargeUsd);
  if (result.run && !(Number.isFinite(result.maxChargeUsd) && result.maxChargeUsd > 0)) throw new Error('--run requires --max-charge-usd with a positive USD amount.');
  return result;
}

export function actorInput(options) {
  return { datasetId: options.datasetId, urlField: options.urlField, fileNameField: options.fileNameField, onlyImages: true, createZip: true, maxFiles: options.maxFiles };
}

export async function downloadDataset(options, { token, fetchImpl = fetch, now = Date.now, sleepImpl = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  if (!options.run) return { preview: true, input: actorInput(options), output: options.output };
  if (!(Number.isFinite(options.maxChargeUsd) && options.maxChargeUsd > 0)) throw new Error('A positive --max-charge-usd is required.');
  if (!token) throw new Error('Set APIFY_TOKEN in your environment. Never put it in the command or a URL.');
  // Reserve the destination before starting a paid run. Never overwrite an existing ZIP.
  const file = await open(options.output, 'wx');
  let completed = false;
  let run;
  const headers = { Authorization: `Bearer ${token}` };
  async function request(path, init = {}) {
    const response = await fetchImpl(API + path, { ...init, headers: { ...headers, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(75_000) });
    if (!response.ok) throw new Error(`Apify returned HTTP ${response.status}. Check your token, account balance and Actor input in Console.`);
    return response;
  }
  async function json(path, init) { return (await (await request(path, init)).json()).data; }
  try {
    const params = new URLSearchParams({ waitForFinish: '60', timeout: '300', maxTotalChargeUsd: String(options.maxChargeUsd) });
    // Do not retry this POST: a lost response could otherwise create a second paid run.
    run = await json(`/actors/chris_elder~bulk-file-downloader/runs?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(actorInput(options)) });
    if (!run?.id) throw new Error('Apify did not return a run ID. Check Console before retrying.');
    const deadline = now() + 360_000;
    let polls = 0;
    while (!TERMINAL.has(run?.status)) {
      if (!run?.id || !ACTIVE.has(run.status)) throw new Error('Apify returned an unexpected run response. Check Console before retrying.');
      if (now() >= deadline) throw new Error('Stopped waiting. Check the existing run in Console before starting another.');
      // GET waitForFinish is a documented long poll, but also back off if a proxy
      // returns immediately. Never replace this with another billable start.
      await sleepImpl(Math.min(1000 * 2 ** Math.min(polls++, 4), 10_000, deadline - now()));
      if (now() >= deadline) throw new Error('Stopped waiting. Check the existing run in Console before starting another.');
      run = await json(`/actor-runs/${encodeURIComponent(run.id)}?waitForFinish=60`);
    }
    if (run.status !== 'SUCCEEDED') throw new Error(`Run ${run.status}. Review the run log and input in Apify Console before retrying.`);
    if (!run.defaultKeyValueStoreId) throw new Error('The completed run did not return a Key-Value store. Check its output in Console.');
    const response = await request(`/key-value-stores/${encodeURIComponent(run.defaultKeyValueStoreId)}/records/OUTPUT.zip`);
    if (!response.body) throw new Error('The ZIP response was empty. Check the run output in Console.');
    let bytes = 0;
    let signature = Buffer.alloc(0);
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 512 * 1024 * 1024) throw new Error('ZIP exceeded this example’s 512 MiB download limit. Download it from Console.');
      if (signature.length < 4) signature = Buffer.concat([signature, Buffer.from(chunk)]).subarray(0, 4);
      await file.writeFile(chunk);
    }
    if (signature.toString('hex') === '504b0506') throw new Error('The ZIP contains no files. Check urlField, onlyImages and the dataset’s URLs.');
    if (signature.toString('hex') !== '504b0304') throw new Error('The response was not a ZIP. Check whether any images downloaded successfully.');
    completed = true;
    return { runId: run.id, status: run.status, output: options.output, bytes, consoleUrl: `https://console.apify.com/actors/runs/${encodeURIComponent(run.id)}` };
  } catch (error) {
    if (run?.id) error.message += ` Run: https://console.apify.com/actors/runs/${encodeURIComponent(run.id)}`;
    throw error;
  } finally {
    await file.close();
    if (!completed) await unlink(options.output);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await downloadDataset(parseArgs(process.argv.slice(2)), { token: process.env.APIFY_TOKEN });
    if (result.preview) console.log('Preview only; no API calls or charges. To run, add --run --max-charge-usd AMOUNT.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
