// Offline contract checks. No production credentials or external network calls.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS loader isolates TypeScript modules for offline fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const root = path.resolve(__dirname, '..');
const loaded = new Map();
function load(relative) {
  const filename = path.join(root, relative);
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const mod = new Module(filename, module);
  mod.filename=filename;mod.paths=module.paths;loaded.set(filename,mod);
  mod.require=(name)=>name==='server-only'?{}:name.startsWith('@/')?load(name.slice(2)+'.ts'):require(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
  return mod.exports;
}
const envelope=(items,totalCount=items.length)=>({response:{header:{resultCode:'00'},body:{items:{item:items},totalCount}}});
const cityStations={
  '31':[{nodename:'동탄',nodeid:'NATTEST01'},{nodename:'광명',nodeid:'NATTEST02'}],
  '26':[{nodename:'울산',nodeid:'NATTEST03'}],
  '11':[{nodename:'수서',nodeid:'NATTEST04'},{nodename:'서울',nodeid:'NATTEST05'}],
  '21':[{nodename:'부산',nodeid:'NATTEST06'}],
};
const fixture={trainno:1,traingradename:'KTX',depplandtime:'20260926060000',arrplandtime:'20260926080000',adultcharge:40800};
let calls=[];let behavior='success';
global.fetch=async url=>{
  const parsed=new URL(url);calls.push({path:parsed.pathname,params:Object.fromEntries(parsed.searchParams)});
  await new Promise(resolve=>setTimeout(resolve,30));
  if(parsed.pathname.endsWith('GetCtyAcctoTrainSttnList')) return Response.json(envelope(cityStations[parsed.searchParams.get('cityCode')]));
  if(behavior==='auth') return Response.json({response:{header:{resultCode:'30'}}});
  if(behavior==='limit') return new Response('',{status:429});
  if(behavior==='schema') return Response.json({unexpected:true});
  if(behavior==='timeout') throw new DOMException('fixture timeout','TimeoutError');
  if(behavior==='network') throw new TypeError('fixture network error');
  if(behavior==='empty') return Response.json(envelope([]));
  return Response.json(envelope([fixture]));
};
async function main(){
  process.env.DATA_GO_KR_SERVICE_KEY='fixture-only-not-a-real-key';
  const stations=load('app/api/trains/stations/route.ts');
  const [a,b]=await Promise.all([stations.GET(new Request('http://test/stations')),stations.GET(new Request('http://test/stations'))]);
  assert.equal(a.status,200);assert.equal(b.status,200);
  assert.equal(calls.length,4,'parallel duplicate station loads merge by city');
  const stationData=await a.json();assert.equal(stationData.stations.length,6);
  const provider=load('lib/rail/tago-provider.ts').createTagoRailProvider('fixture-only-not-a-real-key');
  const condition={departure:'동탄',arrival:'울산(통도사)',departureId:'NATTEST01',arrivalId:'NATTEST03',date:'2026-09-26',departAfter:'00:00',passengers:1};
  const rows=await provider.searchTrains(condition);
  assert.equal(rows[0].depart,'06:00');assert.equal(rows[0].arrive,'08:00');assert.equal(rows[0].fareKrw,40800);assert.equal(rows[0].availability,'unknown');
  const params=calls.at(-1).params;assert.equal(params.depPlaceId,'NATTEST01');assert.equal(params.arrPlaceId,'NATTEST03');assert.equal(params.depPlandTime,'20260926');
  assert.equal((await provider.searchTrains({...condition,departAfter:'07:00'})).length,0);
  await assert.rejects(provider.searchTrains({...condition,departureId:'NATWRONG'}),{code:'STATION_NOT_FOUND'});
  for(const [kind,code] of [['auth','AUTH'],['limit','RATE_LIMIT'],['schema','SCHEMA'],['timeout','TIMEOUT'],['network','UPSTREAM']]){
    behavior=kind;const before=calls.length;
    await assert.rejects(provider.searchTrains(condition),{code});
    assert.equal(calls.length-before,kind==='network'?2:1,`${kind} retry count`);
  }
  behavior='empty';assert.equal((await provider.searchTrains(condition)).length,0);behavior='success';
  const route=load('app/api/trains/search/route.ts');
  const make=(extra={})=>new NextRequest('http://test/search?'+new URLSearchParams({...condition,passengers:'1',...extra}));
  const start=performance.now(), before=calls.length;
  const replies=await Promise.all([route.GET(make()),route.GET(make())]);
  assert.equal(replies[0].status,200);assert.equal(calls.length-before,1,'identical in-flight search merged');
  const missMs=performance.now()-start;
  const cacheStart=performance.now();const hit=await route.GET(make());const hitMs=performance.now()-cacheStart;
  assert.match(hit.headers.get('server-timing'),/HIT/);assert.equal(calls.length-before,1);
  assert.equal((await route.GET(make({arrival:'동탄'}))).status,400);
  assert.equal((await route.GET(make({date:'2026-02-30'}))).status,400);
  behavior='auth';const bad=await route.GET(make({departAfter:'01:00'}));assert.equal(bad.status,503);
  behavior='success';assert.equal((await route.GET(make({departAfter:'01:00'}))).status,200,'errors not cached');
  delete process.env.DATA_GO_KR_SERVICE_KEY;
  assert.equal((await route.GET(make())).status,503,'no silent demo fallback');
  assert.equal((await stations.GET(new Request('http://test/stations'))).status,503);
  console.log(JSON.stringify({result:'PASS',stationRequests:4,concurrentSearchRequests:1,cachedSearchRequests:0,fixtureMissMs:Math.round(missMs),fixtureHitMs:Math.round(hitMs),realApiTest:'NOT RUN — fresh secret required'}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
