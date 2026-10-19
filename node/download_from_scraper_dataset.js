// Dataset product images -> an authenticated ZIP download. Node 20+, no packages.
// Preview: node node/download_from_scraper_dataset.js DATASET_ID
// Run: add --run --max-charge-usd 0.10 (starts a billable Apify run).
// Recover: node node/download_from_scraper_dataset.js --resume-run EXISTING_RUN_ID
import { open, unlink, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.apify.com/v2';
const ACTOR = 'chris_elder~bulk-file-downloader';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const ACTIVE = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);
const validId = value => typeof value === 'string' && !value.startsWith('--') && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validField = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;

function validateOptions(options) {
  if (typeof options.output !== 'string' || !options.output.trim()) throw new Error('Provide a nonempty --output path.');
  if (options.resumeRun !== undefined) {
    if (!validId(options.resumeRun)) throw new Error('--resume-run requires a run ID, not a URL.');
    if (options.run || ['datasetId', 'urlField', 'fileNameField', 'maxFiles', 'maxChargeUsd'].some(key => options[key] !== undefined)) {
      throw new Error('Resume is a separate mode: use only --resume-run RUN_ID and optional --output.');
    }
    return;
  }
  if (!validId(options.datasetId)) throw new Error('Provide the scraper Dataset ID, not a run ID or URL.');
  if (!validField(options.urlField) || !validField(options.fileNameField)) throw new Error('URL and filename fields must be nonempty field names.');
  if (!Number.isSafeInteger(options.maxFiles) || (options.maxFiles < 1 || options.maxFiles > 5000)) throw new Error('--max-files must be an integer from 1 to 5000.');
  if (options.run && !(Number.isFinite(options.maxChargeUsd) && options.maxChargeUsd > 0)) throw new Error('--run requires --max-charge-usd with a positive USD amount.');
}

export function parseArgs(args) {
  const resume = args[0] === '--resume-run';
  const result = resume
    ? { resumeRun: args[1], output: 'files.zip', run: false }
    : { datasetId: args[0], urlField: 'images', fileNameField: 'sku', maxFiles: 100, output: 'files.zip', run: false };
  if (resume && !validId(result.resumeRun)) throw new Error('--resume-run requires a run ID, not a URL.');
  const names = resume ? { '--output': 'output' } : { '--url-field': 'urlField', '--name-field': 'fileNameField', '--max-files': 'maxFiles', '--output': 'output', '--max-charge-usd': 'maxChargeUsd' };
  const seen = new Set();
  for (let i = resume ? 2 : 1; i < args.length; i++) {
    const option = args[i];
    if (seen.has(option)) throw new Error('Do not repeat command options.');
    seen.add(option);
    if (!resume && option === '--run') { result.run = true; continue; }
    if (!Object.hasOwn(names, option) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or incomplete option. Resume accepts only --resume-run RUN_ID and optional --output.');
    result[names[option]] = args[++i];
  }
  if (!resume) result.maxFiles = Number(result.maxFiles);
  if (result.maxChargeUsd !== undefined) result.maxChargeUsd = Number(result.maxChargeUsd);
  validateOptions(result);
  return result;
}

export function actorInput(options) {
  return { datasetId: options.datasetId, urlField: options.urlField, fileNameField: options.fileNameField, onlyImages: true, createZip: true, maxFiles: options.maxFiles };
}

function validateStoredInput(input) {
  // Recover this recipe's dataset workflow only; do not guess another input mode.
  if (!input || Array.isArray(input) || !validId(input.datasetId) || !validField(input.urlField) || !validField(input.fileNameField)
      || input.onlyImages !== true || input.createZip !== true || !Number.isSafeInteger(input.maxFiles) || (input.maxFiles < 1 || input.maxFiles > 5000)
      || (input.zipKey !== undefined && input.zipKey !== 'OUTPUT.zip')
      || [input.urls, input.pageUrls, input.csvUrl].some(value => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0))) {
    throw new Error('Stored INPUT does not match this recipe’s dataset-to-ZIP workflow. Inspect the existing run in Console; no new run was started.');
  }
}

export async function downloadDataset(options, { token, fetchImpl = fetch, now = Date.now, sleepImpl = ms => new Promise(done => setTimeout(done, ms)), openFile = open } = {}) {
  validateOptions(options);
  if (!options.run && !options.resumeRun) return { preview: true, input: actorInput(options), output: options.output };
  if (!token) throw new Error('Set APIFY_TOKEN in your environment. Never put it in the command or a URL.');
  // Reserve before any API call. Refuse existing files and symlinks; owner-only mode.
  const outputPath = resolve(options.output);
  const file = await openFile(outputPath, 'wx', 0o600);
  let identity;
  let closed = false;
  let completed = false;
  let run;
  const headers = { Authorization: `Bearer ${token}` };
  async function request(path, init = {}) {
    if (options.resumeRun && init.method && init.method !== 'GET') throw new Error('Resume cannot start or modify an Actor run.');
    const response = await fetchImpl(API + path, { ...init, headers: { ...headers, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(75_000) });
    if (!response.ok) throw new Error(`Apify returned HTTP ${response.status}. Inspect the existing run, token and access in Console before retrying.`);
    return response;
  }
  async function readJson(response) {
    if (!response.body) throw new Error('Apify returned an empty JSON response. Inspect Console before retrying.');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 256 * 1024) throw new Error('Apify JSON exceeded this example’s 256 KiB metadata limit. Inspect Console.');
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error('Apify returned invalid JSON. Inspect Console before retrying.'); }
  }
  async function json(path, init) { return (await readJson(await request(path, init)))?.data; }
  const sameFile = current => identity && current.dev === identity.dev && current.ino === identity.ino;
  try {
    identity = await file.stat();
    if (options.resumeRun) {
      // Fixed-origin GETs only. Shared/public runs are not proof of account ownership.
      const user = await json('/users/me');
      if (!validId(user?.id)) throw new Error('Could not verify the token’s account. No new run was started.');
      run = await json(`/actor-runs/${options.resumeRun}`);
      if (run?.id !== options.resumeRun || !validId(run?.actId) || !validId(run?.defaultKeyValueStoreId)) throw new Error('Apify returned an unexpected run response. Inspect Console; no new run was started.');
      if (run.userId !== user.id) throw new Error('This run does not belong to the token’s account. No new run was started.');
      if (run.status !== 'SUCCEEDED') throw new Error('Existing run is not SUCCEEDED. Wait for completion or inspect its log in Console; resume never starts another run.');
      if (run.metamorphs != null && (!Array.isArray(run.metamorphs) || run.metamorphs.length)) throw new Error('Metamorphed runs are not supported by this recovery example. Inspect Console.');
      const actor = await json(`/actors/${ACTOR}`);
      if (!validId(actor?.id) || actor.id !== run.actId) throw new Error('This is not a run of chris_elder/bulk-file-downloader. No new run was started.');
      validateStoredInput(await readJson(await request(`/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`)));
    } else {
      const params = new URLSearchParams({ waitForFinish: '60', timeout: '300', maxTotalChargeUsd: String(options.maxChargeUsd) });
      // Do not retry this POST: a lost response could create a second paid run.
      run = await json(`/actors/${ACTOR}/runs?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(actorInput(options)) });
      if (!validId(run?.id)) throw new Error('Apify did not return a valid run ID. Check Console before retrying.');
      const runId = run.id;
      const deadline = now() + 360_000;
      let polls = 0;
      while (!TERMINAL.has(run?.status)) {
        if (run?.id !== runId || !ACTIVE.has(run.status)) throw new Error('Apify returned an unexpected run response. Check Console before retrying.');
        if (now() >= deadline) throw new Error('Stopped waiting. Check the existing run in Console before starting another.');
        await sleepImpl(Math.min(1000 * 2 ** Math.min(polls++, 4), 10_000, deadline - now()));
        if (now() >= deadline) throw new Error('Stopped waiting. Check the existing run in Console before starting another.');
        run = await json(`/actor-runs/${runId}?waitForFinish=60`);
      }
      if (run?.id !== runId) throw new Error('Apify returned a different run ID. Inspect Console before retrying.');
      if (run.status !== 'SUCCEEDED') throw new Error(`Run ${run.status}. Review the run log and input in Apify Console before retrying.`);
      if (!validId(run.defaultKeyValueStoreId)) throw new Error('The completed run did not return a valid Key-Value store. Check its output in Console.');
    }
    const response = await request(`/key-value-stores/${run.defaultKeyValueStoreId}/records/OUTPUT.zip`);
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
    await file.close();
    closed = true;
    let current;
    try { current = await lstat(outputPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!current || !sameFile(current)) throw new Error('Output file changed during download. Inspect the existing run in Console before retrying.');
    completed = true;
    return { runId: run.id, status: run.status, output: options.output, bytes, resumed: Boolean(options.resumeRun), consoleUrl: `https://console.apify.com/actors/runs/${run.id}` };
  } catch (cause) {
    // Abort/timeout DOMExceptions have a read-only message; do not mutate them.
    const error = new Error(cause instanceof Error ? cause.message : 'Download failed. Inspect Console before retrying.', { cause });
    if (validId(run?.id)) error.message += ` Run: https://console.apify.com/actors/runs/${run.id}`;
    throw error;
  } finally {
    try { if (!closed) await file.close(); }
    finally {
      if (!completed && identity) {
        let current;
        try { current = await lstat(outputPath); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current && sameFile(current)) await unlink(outputPath);
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await downloadDataset(parseArgs(process.argv.slice(2)), { token: process.env.APIFY_TOKEN });
    if (result.preview) console.log('Preview only; no API calls or charges. To run, add --run --max-charge-usd AMOUNT.');
    else if (result.resumed) console.log('Recovered the existing run’s ZIP; no Actor was started or restarted. Storage/data-transfer usage may still apply.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
