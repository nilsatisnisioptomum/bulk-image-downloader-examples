import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, symlink, unlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, downloadDataset } from '../node/download_from_scraper_dataset.js';

const CLI = fileURLToPath(new URL('../node/download_from_scraper_dataset.js', import.meta.url));
const SECRET = 'synthetic-signed-query-not-a-real-key';
const shared = `https://images.example.test/photo.svg?signature=${SECRET}&x=1%2C2&x=3#detail`;
const input = {
  urls: [{url:shared,fileName:'0007'}, {url:shared,fileName:'gift-set'}, {url:'https://images.example.test/other.svg?x=%2B',fileName:'0010'}],
  maxFiles:3, createZip:true, onlyImages:true, dedupe:false,
};
// A real three-member, stored ZIP made from synthetic SVGs, not an Actor result.
const zip = Buffer.from('UEsDBBQAAAAAAAAAIVAe1szFRQAAAEUAAAAIAAAAMDAwNy5zdmc8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPjAwMDcuc3ZnPC90aXRsZT48L3N2Zz5QSwMEFAAAAAAAAAAhUH/EBGBJAAAASQAAAAwAAABnaWZ0LXNldC5zdmc8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPmdpZnQtc2V0LnN2ZzwvdGl0bGU+PC9zdmc+UEsDBBQAAAAAAAAAIVATZpXqRQAAAEUAAAAIAAAAMDAxMC5zdmc8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPjAwMTAuc3ZnPC90aXRsZT48L3N2Zz5QSwECFAMUAAAAAAAAACFQHtbMxUUAAABFAAAACAAAAAAAAAAAAAAAgAEAAAAAMDAwNy5zdmdQSwECFAMUAAAAAAAAACFQf8QEYEkAAABJAAAADAAAAAAAAAAAAAAAgAFrAAAAZ2lmdC1zZXQuc3ZnUEsBAhQDFAAAAAAAAAAhUBNmlepFAAAARQAAAAgAAAAAAAAAAAAAAIAB3gAAADAwMTAuc3ZnUEsFBgAAAAADAAMApgAAAEkBAAAAAA==', 'base64');
const run = {id:'plannerRun123',status:'SUCCEEDED',defaultKeyValueStoreId:'plannerStore123'};
async function fixture(t, value=input) {
  const dir = await mkdtemp(join(tmpdir(), 'planner-json-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const path = join(dir,'private-input.json'), output = join(dir,'images.zip');
  await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return {dir,path,output};
}
function options(f, extra=[]) { return parseArgs(['--input-json',f.path,'--output',f.output,...extra]); }
async function absent(path) { await assert.rejects(access(path)); }

test('planner JSON preview exposes only aggregate settings, with no token, file creation or network', async t => {
  const f=await fixture(t);
  let calls=0;
  const result=await downloadDataset(options(f),{fetchImpl:()=>{calls++;throw new Error('network forbidden');}});
  assert.equal(calls,0);
  assert.deepEqual(result,{preview:true,mode:'planner-json',fileCount:3,maxFiles:3,createZip:true,onlyImages:true,dedupe:false});
  assert.doesNotMatch(JSON.stringify(result),new RegExp(SECRET+'|https:|0007|gift-set|private-input|images.zip'));
  await absent(f.output);
});

test('actual CLI aggregate preview has zero network attempts and prints no source URLs, names, paths or token', async t => {
  const f=await fixture(t);
  const guard=join(f.dir,'no-network.mjs');
  await writeFile(guard,`import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw new Error('TEST_NETWORK_FORBIDDEN')};globalThis.fetch=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;tls.connect=deny;syncBuiltinESMExports();`);
  const result=spawnSync(process.execPath,['--import',guard,CLI,'--input-json',f.path,'--output',f.output,'--max-charge-usd','0.10'],{encoding:'utf8',timeout:5000,env:{...process.env,APIFY_TOKEN:'synthetic-token-not-real'}});
  assert.equal(result.status,0,result.stderr); assert.equal(result.stderr,'');
  assert.match(result.stdout,/Preview only/); assert.match(result.stdout,/"fileCount": 3/);
  assert.doesNotMatch(result.stdout,/TEST_NETWORK_FORBIDDEN|signature|https:|0007|gift-set|private-input|synthetic-token|images.zip/);
  await absent(f.output);
});

test('standalone input mode rejects ambiguous flags before any run', () => {
  for(const args of [
    ['--input-json'], ['--input-json','--run'], ['--input-json','file','dataset'],
    ['dataset','--input-json','file'], ['--input-json','file','--resume-run','run123'],
    ['--input-json','file','--input-json','other'], ['--input-json','file','constructor','x'],
    ['--input-json','file','--max-files','3'], ['--input-json','file','--url-field','url'],
    ['--input-json','file','--name-field','sku'], ['--input-json','file','--run'],
    ['--input-json','file','--run','--max-charge-usd','0'],
    ['--input-json','file','--run','--max-charge-usd','Infinity'],
    ['--input-json','file','--run','--run','--max-charge-usd','1'],
  ]) assert.throws(()=>parseArgs(args),args.join(' '));
});

test('programmatic mixed modes and nonboolean consent fail before files or requests',async t=>{
  const f=await fixture(t);let calls=0;
  for(const extra of [{datasetId:'dataset123'},{resumeRun:'run123'},{maxFiles:3},{urlField:'url'},{fileNameField:'sku'},{run:'false'},{run:1},{run:true},{run:true,maxChargeUsd:Infinity},{unexpected:true}]) {
    await assert.rejects(downloadDataset({...options(f),...extra},{token:'fake',fetchImpl:()=>{calls++;throw new Error('forbidden');}}));
    await absent(f.output);
  }
  await assert.rejects(downloadDataset(Object.assign(Object.create({run:true,maxChargeUsd:1}),{inputJson:f.path,output:f.output}),{token:'fake',fetchImpl:()=>{calls++;}}));
  assert.equal(calls,0);
});

test('exact planner JSON is posted once without changing signed URLs, leading zero names or shared-image jobs', async t => {
  const f=await fixture(t),calls=[];
  const result=await downloadDataset(options(f,['--run','--max-charge-usd','0.10']),{token:'fake-token',fetchImpl:async(url,init)=>{
    calls.push({url,init});return calls.length===1?Response.json({data:run}):new Response(zip);
  }});
  assert.equal(result.status,'SUCCEEDED'); assert.equal(calls.length,2);
  assert.equal(calls.filter(c=>c.init.method==='POST').length,1);
  assert.deepEqual(JSON.parse(calls[0].init.body),input);
  assert.equal(new URL(calls[0].url).searchParams.get('maxTotalChargeUsd'),'0.1');
  assert.deepEqual(await readFile(f.output),zip);
  assert.equal((await lstat(f.output)).mode&0o777,0o600);
  for(const call of calls){assert.equal(call.init.redirect,'error');assert.equal(call.init.headers.Authorization,'Bearer fake-token');assert.doesNotMatch(call.url,/signature|fake-token/);}
});

test('unsupported JSON shapes fail closed with no requests/output and no source value in errors',async t=>{
  const mutations=[
    null,[],{}, {...input,extra:SECRET},{...input,datasetId:SECRET},{...input,pageUrls:[]},
    {...input,createZip:false},{...input,onlyImages:false},{...input,dedupe:true},
    {...input,maxFiles:2},{...input,maxFiles:'3'},{...input,urls:[]},
    {...input,urls:[{url:shared,fileName:'0007',key:SECRET}]},
    {...input,urls:[shared],maxFiles:1},
    {...input,urls:[{url:'file:///private/'+SECRET,fileName:'x'}],maxFiles:1},
    {...input,urls:[{url:'https://user:'+SECRET+'@example.test/x',fileName:'x'}],maxFiles:1},
    {...input,urls:[{url:'https://example.test/a b?'+SECRET,fileName:'x'}],maxFiles:1},
    {...input,urls:[{url:'https://example.test/%?'+SECRET,fileName:'x'}],maxFiles:1},
    {...input,urls:[{url:shared,fileName:'../'+SECRET}],maxFiles:1},
    {...input,urls:[{url:shared,fileName:'  '}],maxFiles:1},
    {...input,urls:[{url:shared,fileName:' mug'}],maxFiles:1},
    {...input,urls:[{url:shared,fileName:'mug '}],maxFiles:1},
    {...input,urls:[{url:shared,fileName:'mug  blue'}],maxFiles:1},
    {...input,urls:[{url:shared,fileName:'x'.repeat(81)}],maxFiles:1},
    {...input,urls:[{url:shared,fileName:'SAME'},{url:shared,fileName:'same'}],maxFiles:2},
  ];
  for(const [i,value] of mutations.entries())await t.test(`invalid-shape-${i}`,async st=>{
    const f=await fixture(st,value);let calls=0;
    await assert.rejects(downloadDataset(options(f,['--run','--max-charge-usd','0.10']),{token:'fake',fetchImpl:()=>{calls++;throw new Error('forbidden');}}),error=>{assert.doesNotMatch(error.message,new RegExp(SECRET+'|https:|file:|private-input'));return true;});
    assert.equal(calls,0);await absent(f.output);
  });
});

test('actual planner truncation and normalized Unicode filename stems remain accepted without rewriting',async t=>{
  // The planner trims/collapses first, then cuts to 80 code points. A long SKU
  // whose 80th code point is a space therefore legitimately exports that space.
  for(const fileName of ['café-東京-😀','a'.repeat(79)+' ']) {
    const f=await fixture(t,{...input,urls:[{url:shared,fileName}],maxFiles:1});let calls=0;
    await downloadDataset(options(f,['--run','--max-charge-usd','0.10']),{token:'fake',fetchImpl:async(url,init)=>{
      calls++;
      if(calls===1){assert.equal(JSON.parse(init.body).urls[0].fileName,fileName);return Response.json({data:run});}
      return new Response(zip);
    }});
    assert.equal(calls,2);
  }
});

test('bounded UTF-8 regular-file validation rejects invalid JSON, bytes, oversize, directories and symlinks',async t=>{
  for(const [name,value] of [['json','{"urls":"'+SECRET],['utf8',Buffer.from([0xc3,0x28])],['nul',JSON.stringify(input)+'\0'],['bytes',' '.repeat(2*1024*1024+1)]])await t.test(name,async st=>{
    const f=await fixture(st,value);let calls=0;
    await assert.rejects(downloadDataset(options(f),{fetchImpl:()=>{calls++;throw new Error('forbidden');}}),error=>{assert.doesNotMatch(error.message,new RegExp(SECRET+'|private-input'));return true;});
    assert.equal(calls,0);await absent(f.output);
  });
  await t.test('nonregular',async st=>{const f=await fixture(st);await assert.rejects(downloadDataset({...options(f),inputJson:f.dir}));await absent(f.output);});
  await t.test('symlink',async st=>{const f=await fixture(st),link=join(f.dir,'input-link.json');await symlink(f.path,link);await assert.rejects(downloadDataset({...options(f),inputJson:link}));await absent(f.output);assert.equal(await readFile(f.path,'utf8'),JSON.stringify(input));});
});

test('planner limit accepts 1000 exact jobs but rejects 1001 before API access',async t=>{
  for(const count of [1000,1001]){
    const value={...input,urls:Array.from({length:count},(_,i)=>({url:shared,fileName:`image-${i}`})),maxFiles:count};
    const f=await fixture(t,value);let calls=0;
    const pending=downloadDataset(options(f),{fetchImpl:()=>{calls++;throw new Error('forbidden');}});
    if(count===1000)assert.equal((await pending).fileCount,1000);else await assert.rejects(pending);
    assert.equal(calls,0);await absent(f.output);
  }
});

test('existing outputs and output symlinks are preserved with zero POSTs',async t=>{
  const f=await fixture(t),o=options(f,['--run','--max-charge-usd','0.10']);let calls=0;
  await writeFile(f.output,'keep');
  await assert.rejects(downloadDataset(o,{token:'fake',fetchImpl:()=>{calls++;}}),{code:'EEXIST'});
  assert.equal(await readFile(f.output,'utf8'),'keep');await unlink(f.output);
  await symlink(f.path,f.output);
  await assert.rejects(downloadDataset(o,{token:'fake',fetchImpl:()=>{calls++;}}),{code:'EEXIST'});
  assert.equal((await lstat(f.output)).isSymbolicLink(),true);assert.equal(calls,0);
});

test('ambiguous start failure never retries and removes only its partial output',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects(downloadDataset(options(f,['--run','--max-charge-usd','0.10']),{token:'fake',fetchImpl:()=>{calls++;throw new Error('synthetic transport failure');}}),/synthetic transport failure/);
  assert.equal(calls,1);await absent(f.output);
});
