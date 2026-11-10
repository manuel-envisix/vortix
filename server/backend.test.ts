import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { Store } from './store';
import { eventSchema,reduceAgent, type AgentEvent } from './events';
import { CursorCloudAdapter,GitHubAdapter,apiJson,ProviderError,parseSse,matchesGitHub } from './providers';
import { GrokBotAdapter,ingestCursorHook,ingestOtlp } from './ingestion';
import { createApp,verifySignature } from './app';
import type { Config,Tenant } from './config';
import { issueViewerCookie,verifyViewerCookie } from './viewer-auth';
const tenant:Tenant={id:'alpha',viewToken:'alpha-view-token-000000000',ingestToken:'alpha-ingest-token-000000',repositories:['envisix/test'],githubSecret:'github-test-secret'};
const event=(patch:Partial<AgentEvent>={}):AgentEvent=>({event_id:'evt-1',provider:'grok_bot',agent_id:'bot-1',event_type:'agent.started',timestamp:'2026-11-10T12:00:00Z',source:'grok_report',confidence:'reported',repository:'envisix/test',...patch});
test('schema strips private fields and validates bounded identifiers',()=>{const e=eventSchema.parse({...event(),prompt:'SECRET',tool_output:'SECRET',environment:{key:'SECRET'}});assert.ok(!JSON.stringify(e).includes('SECRET'));assert.throws(()=>eventSchema.parse(event({agent_id:'x'.repeat(300)})));});
test('viewer sign-in survives restarts but rejects expiry, tampering, other ports and key rotation',()=>{
 const now=Date.now(),cookie=issueViewerCookie(tenant,4310,now);assert.equal(verifyViewerCookie(cookie,[{...tenant}],4310,now+1000)?.id,tenant.id);assert.equal(verifyViewerCookie(cookie,[tenant],4311,now+1000),undefined);assert.equal(verifyViewerCookie(cookie,[tenant],4310,now+9*3600000),undefined);assert.equal(verifyViewerCookie(cookie+'0',[tenant],4310,now+1000),undefined);assert.equal(verifyViewerCookie(cookie,[{...tenant,viewToken:'rotated-viewer-key-000000'}],4310,now+1000),undefined);
});
test('unconfigured hook bridge returns neutral protocol without leaking input',()=>{
 for(const name of ['preToolUse','subagentStart','beforeSubmitPrompt','postToolUse']){const result=spawnSync(process.execPath,['scripts/cursor-hook.mjs',name],{input:JSON.stringify({conversation_id:'test',prompt:'SECRET',tool_input:{secret:'SECRET'}}),encoding:'utf8',windowsHide:true,env:{...process.env,SYNVIX_INGEST_URL:'',SYNVIX_INGEST_TOKEN:''}});assert.equal(result.status,0);const output=JSON.parse(result.stdout);assert.ok(!result.stdout.includes('SECRET'));if(name==='preToolUse'||name==='subagentStart')assert.equal(output.permission,'allow');else if(name==='beforeSubmitPrompt')assert.equal(output.continue,true);else assert.deepEqual(output,{});}
});
test('persistent, idempotent, tenant-scoped events and snapshots survive restart',()=>{
 const folder=mkdtempSync(path.join(tmpdir(),'synvix-test-')),file=path.join(folder,'state.sqlite');let s=new Store(file);
 try {assert.equal(s.ingest('alpha',event()),true);assert.equal(s.ingest('alpha',event()),false);assert.equal(s.ingest('beta',event()),true);assert.equal(s.agents('alpha').length,1);assert.equal(s.events('alpha').length,1);const seq=s.lastSeq('alpha');assert.equal(s.events('alpha',seq).length,0);s.close();s=new Store(file);assert.equal(s.agents('alpha')[0].externalId,'bot-1');const snap=s.snapshot('alpha');assert.equal(snap.mode,'live');assert.equal(snap.agents[0].progressKnown,false);assert.equal(snap.agents[0].liveDelivery,undefined);assert.equal(snap.projects![0].name,'envisix/test');}finally{s.close();assert.ok(folder.startsWith(path.join(tmpdir(),'synvix-test-')));rmSync(folder,{recursive:true,force:true});}
});
test('out-of-order runs cannot overwrite newer execution; delivery does not block reconciliation',()=>{
 let a=reduceAgent(undefined,event({run_id:'r2',timestamp:'2026-11-10T12:02:00Z'}));
 assert.equal(reduceAgent(a,event({run_id:'r1',timestamp:'2026-11-10T12:01:00Z'})).runId,'r2');
 a=reduceAgent(a,event({event_type:'delivery.updated',timestamp:'2026-11-10T12:05:00Z'}));
 a=reduceAgent(a,event({event_type:'agent.completed',timestamp:'2026-11-10T12:03:00Z'}));assert.equal(a.status,'complete');
 a=reduceAgent(a,event({event_type:'tool.completed',activity:'coding',timestamp:'2026-11-10T12:06:00Z'}));assert.equal(a.activity,null);
});
test('Grok Bot reports stay reported; tools track providers, failures and latency',()=>{
 const s=new Store(':memory:');try{const adapter=new GrokBotAdapter(s,'alpha');adapter.report({...event(),confidence:'observed',source:'cursor_api'});s.ingest('alpha',event({event_id:'tool-start',event_type:'tool.started',tool_name:'history_lookup',tool_provider:'composio',call_id:'c1',timestamp:'2026-11-10T12:01:00Z'}));s.ingest('alpha',event({event_id:'tool-end',event_type:'tool.failed',call_id:'c1',timestamp:'2026-11-10T12:01:12Z'}));const a=s.agents('alpha')[0];assert.equal(a.confidence,'reported');assert.equal(a.tools.c1.provider,'composio');assert.equal(a.tools.c1.durationMs,12000);assert.equal(a.tools.c1.state,'failed');}finally{s.close();}
});
test('Cursor Cloud hooks keep subagent identity and omit raw prompt/output',()=>{
 const s=new Store(':memory:');try{s.cursor('alpha','cursor-alias:conversation','bc-parent');ingestCursorHook(s,'alpha',{event:'subagentStart',event_id:'spawn',conversation_id:'conversation',subagent_id:'child',timestamp:'2026-11-10T12:00:00Z',prompt:'SECRET'});const a=s.agents('alpha')[0];assert.equal(a.parentId,'cursor_cloud:bc-parent');assert.equal(a.externalId,'child');assert.equal(a.status,'unknown');assert.ok(!JSON.stringify(s.events('alpha')).includes('SECRET'));}finally{s.close();}
});
test('OTLP resolves child-before-parent batches and records metadata-only tools',()=>{
 const s=new Store(':memory:');const attr=(key:string,stringValue:string)=>({key,value:{stringValue}});
 try{ingestOtlp(s,'alpha',{resourceSpans:[{scopeSpans:[{spans:[{traceId:'trace',spanId:'child',parentSpanId:'root',name:'invoke_agent',startTimeUnixNano:'1794312060000000000',attributes:[attr('gen_ai.agent.id','child')]},{traceId:'trace',spanId:'root',name:'invoke_agent',startTimeUnixNano:'1794312000000000000',attributes:[attr('gen_ai.agent.id','parent')]},{traceId:'trace',spanId:'tool',parentSpanId:'child',name:'execute_tool',startTimeUnixNano:'1794312120000000000',endTimeUnixNano:'1794312121000000000',attributes:[attr('gen_ai.tool.name','read_file'),attr('tool.output','SECRET')]}]}]}]},'traces');assert.equal(s.agent('alpha','grok_bot:child')!.parentId,'grok_bot:parent');assert.equal(s.agent('alpha','grok_bot:child')!.tools.tool.state,'completed');assert.ok(!JSON.stringify(s.events('alpha')).includes('SECRET'));}finally{s.close();}
});
test('Cursor paginates discovery and reads actual run status rather than lifecycle',async()=>{
 const s=new Store(':memory:');const calls:string[]=[];const fetcher:typeof fetch=async(input,init)=>{const u=new URL(String(input));calls.push(u.pathname+u.search);assert.equal((init!.headers as any).Authorization,'Bearer api-test-key');
  let data:any;if(u.pathname==='/v1/agents')data=u.searchParams.has('cursor')?{items:[{id:'bc-b'}]}:{items:[{id:'bc-a'}],nextCursor:'page2'};
  else if(u.pathname.endsWith('/runs'))data={items:[]};
  else if(u.pathname.endsWith('/runs/r1'))data={id:'r1',status:u.pathname.includes('bc-a')?'RUNNING':'ERROR',updatedAt:'2026-11-10T12:00:00Z',git:{branches:[{repoUrl:'github.com/envisix/test',branch:'agent/feature',prUrl:'https://github.com/envisix/test/pull/2'}]}};
  else data={id:u.pathname.split('/').pop(),name:'Task summary',status:'ACTIVE',latestRunId:'r1',repos:[{url:'https://github.com/envisix/test'}],url:'https://cursor.com/agents/example'};
  return Response.json(data);
 };try{const a=new CursorCloudAdapter({...tenant,cursorKey:'api-test-key'},s,{maxAgents:100,maxStreams:0},fetcher);await a.poll();assert.equal(s.agents('alpha').length,2);assert.equal(s.agent('alpha','cursor_cloud:bc-b')!.status,'error');assert.equal(s.agent('alpha','cursor_cloud:bc-a')!.prUrl,'https://github.com/envisix/test/pull/2');assert.ok(calls.some(x=>x.includes('cursor=page2')));assert.equal(s.agent('alpha','cursor_cloud:bc-a')!.activity,null);assert.ok(!JSON.stringify(s.snapshot('alpha')).includes('api-test-key'));}finally{s.close();}
});
test('Cursor run streaming keeps tool failures and drops reasoning, arguments and output',async()=>{
 const s=new Store(':memory:');let adapter:CursorCloudAdapter|undefined;
 const stream=['event: thinking\ndata: {"text":"SECRET reasoning"}\n\n','id: t1\nevent: tool_call\ndata: {"callId":"call-1","name":"read_file","status":"running","args":{"secret":"SECRET"}}\n\n','id: t2\nevent: tool_call\ndata: {"callId":"call-1","name":"read_file","status":"completed","result":{"isError":true,"text":"SECRET"}}\n\n','id: t3\nevent: result\ndata: {"status":"FINISHED","text":"SECRET final reply"}\n\n','event: done\ndata: {}\n\n'].join('');
 const fetcher:typeof fetch=async(input)=>{const u=new URL(String(input));if(u.pathname.endsWith('/stream'))return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});if(u.pathname==='/v1/agents')return Response.json({items:[{id:'bc-stream'}]});if(u.pathname.endsWith('/runs'))return Response.json({items:[]});if(u.pathname.endsWith('/runs/r1'))return Response.json({id:'r1',status:'RUNNING',updatedAt:'2026-11-10T12:00:00Z'});return Response.json({id:'bc-stream',name:'A metadata summary',latestRunId:'r1',updatedAt:'2026-11-10T12:00:00Z'});};
 try{
  adapter=new CursorCloudAdapter({...tenant,cursorKey:'test-api-key'},s,{maxAgents:10,maxStreams:1},fetcher);
  const finished=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('stream did not finish')),3000);s.on('change',()=>{if(s.agent('alpha','cursor_cloud:bc-stream')?.status==='complete'){clearTimeout(timer);resolve();}});});
  await adapter.poll();await finished;
  const events=s.events('alpha');assert.ok(events.some(e=>e.event_type==='tool.failed'));assert.ok(!JSON.stringify(events).includes('SECRET'));assert.equal(s.agent('alpha','cursor_cloud:bc-stream')!.status,'complete');assert.equal(s.agent('alpha','cursor_cloud:bc-stream')!.tools['call-1'].state,'failed');assert.equal(s.cursor('alpha','cursor-stream:bc-stream:r1'),'t3');
 }finally{adapter?.stop();s.close();}
});
test('archived Cursor agents leave the live roster but retain history',async()=>{
 const s=new Store(':memory:');s.ingest('alpha',event({provider:'cursor_cloud',agent_id:'bc-archived',event_id:'old-history',source:'cursor_api',confidence:'observed'}));let empty=false;const requests:string[]=[];
 const fetcher:typeof fetch=async(input)=>{const u=new URL(String(input));requests.push(u.pathname+u.search);if(u.pathname==='/v1/agents'){assert.equal(u.searchParams.get('includeArchived'),'false');return Response.json({items:empty?[]:[{id:'bc-current',status:'IDLE'},{id:'bc-archived',status:'ARCHIVED'}]});}if(u.pathname.endsWith('/runs'))return Response.json({items:[]});if(u.pathname.endsWith('/runs/r1'))return Response.json({id:'r1',status:'FINISHED',updatedAt:'2026-11-10T12:00:00Z'});return Response.json({id:'bc-current',status:'IDLE',latestRunId:'r1'});};
 try{const adapter=new CursorCloudAdapter({...tenant,cursorKey:'test-key'},s,{maxAgents:100,maxStreams:0},fetcher);await adapter.poll();assert.deepEqual(s.snapshot('alpha').agents.map(a=>a.externalId),['bc-current']);assert.ok(!s.snapshot('alpha').events.some(e=>e.agentId==='cursor_cloud:bc-archived'));assert.ok(s.events('alpha').some(e=>e.agent_id==='bc-archived'));assert.ok(!requests.some(u=>u.includes('/bc-archived')));empty=true;await adapter.poll();assert.equal(s.snapshot('alpha').agents.length,0);assert.ok(s.agents('alpha').length>0);}finally{s.close();}
});
test('GitHub REST enrichment persists PR reviews and CI job/step results',async()=>{
 const s=new Store(':memory:');s.ingest('alpha',event({pr_url:'https://github.com/envisix/test/pull/2',branch:'feature'}));
 const fetcher:typeof fetch=async(input)=>{const u=new URL(String(input));let data:any={};
  if(u.pathname.endsWith('/pulls/2'))data={number:2,title:'A real metadata fixture',state:'open',html_url:'https://github.com/envisix/test/pull/2',head:{sha:'abcdef123456',ref:'feature'},updated_at:'2026-11-10T12:00:00Z'};
  else if(u.pathname.endsWith('/files'))data=[{filename:'src/app.ts'}];
  else if(u.pathname.endsWith('/reviews'))data=[{id:9,state:'APPROVED',submitted_at:'2026-11-10T12:00:00Z',body:'SECRET'}];
  else if(u.pathname.endsWith('/actions/runs'))data={workflow_runs:[{id:6,workflow_id:1,name:'CI',status:'completed',conclusion:'failure',head_branch:'feature',head_sha:'abcdef123456',updated_at:'2026-11-10T12:00:00Z'}]};
  else if(u.pathname.endsWith('/jobs'))data={jobs:[{name:'Unit tests',status:'completed',conclusion:'failure',steps:[{name:'Test suite',status:'completed',conclusion:'failure'}]}]};
  return Response.json(data);
 };
 try{await new GitHubAdapter({...tenant,githubToken:'test-gh-key'},s,fetcher).poll();const a=s.agents('alpha')[0];assert.equal(a.delivery!.pr!.reviews![0].state,'APPROVED');assert.equal(a.delivery!.pr!.files[0],'src/app.ts');assert.ok(a.delivery!.pipeline!.stages.some(stage=>stage.name==='Unit tests / Test suite'&&stage.state==='failed'));assert.ok(!JSON.stringify(s.events('alpha')).includes('SECRET'));}finally{s.close();}
});
test('provider rate limits preserve retry timing; SSE handles split records',async()=>{
 await assert.rejects(()=>apiJson('https://example.test',{},async()=>new Response('',{status:429,headers:{'Retry-After':'12'}})),e=>e instanceof ProviderError&&e.retryMs===12000);
 const encoder=new TextEncoder();const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(encoder.encode('id: x\nevent: tool_call\ndata: {"name":"read_'));c.enqueue(encoder.encode('file"}\n\n'));c.close();}});const records=[];for await(const record of parseSse(stream))records.push(record);assert.equal(records[0].data.name,'read_file');assert.equal(records[0].id,'x');
});
test('hook and stream observations of the same known run/tool are deduplicated',()=>{
 const s=new Store(':memory:');try{const first=event({provider:'cursor_cloud',source:'cursor_hook',confidence:'observed',event_type:'tool.started',call_id:'call-42',run_id:'run-42'});assert.equal(s.ingest('alpha',first),true);assert.equal(s.ingest('alpha',{...first,event_id:'stream-id',source:'cursor_stream'}),false);assert.equal(s.events('alpha').length,1);}finally{s.close();}
});
test('failed CI and unknown delivery remain distinct from task completion',()=>{
 const s=new Store(':memory:');try{s.ingest('alpha',event({pr_url:'https://github.com/envisix/test/pull/5',branch:'agent/feature'}));new GitHubAdapter(tenant,s).apply('envisix/test','workflow_run',{workflow_run:{id:9,name:'Unit tests',head_branch:'agent/feature',head_sha:'abcdef123456',status:'completed',conclusion:'failure'}},'ci-delivery');const a=s.snapshot('alpha').agents[0];assert.equal(a.status,'working');assert.equal(a.liveDelivery!.pipeline!.stages[0].state,'failed');assert.equal(a.progressKnown,false);}finally{s.close();}
});
test('updating telemetry preserves fleet insertion order and therefore stable world layout',()=>{
 const s=new Store(':memory:');try{s.ingest('alpha',event());s.ingest('alpha',event({agent_id:'bot-2',event_id:'second'}));const initial=s.snapshot('alpha').agents.map(a=>a.id);s.ingest('alpha',event({event_id:'update',event_type:'agent.waiting',timestamp:'2026-11-10T12:01:00Z'}));assert.deepEqual(s.snapshot('alpha').agents.map(a=>a.id),initial);}finally{s.close();}
});
test('inspector history returns latest events scoped to both provider and agent',()=>{
 const s=new Store(':memory:');try{for(let i=0;i<8;i++)s.ingest('alpha',event({event_id:'event-'+i}));s.ingest('alpha',event({event_id:'other-provider',provider:'cursor_cloud',source:'cursor_api'}));const latest=s.events('alpha',0,3,{agent:'bot-1',provider:'grok_bot',latest:true});assert.deepEqual(latest.map(e=>e.event_id),['event-5','event-6','event-7']);assert.ok(latest.every(e=>e.provider==='grok_bot'));}finally{s.close();}
});
test('resumed agents do not retain an obsolete waiting activity',()=>{
 let a=reduceAgent(undefined,event({event_type:'agent.waiting'}));a=reduceAgent(a,event({event_type:'agent.resumed',timestamp:'2026-11-10T12:01:00Z'}));assert.equal(a.status,'working');assert.equal(a.activity,null);
});
test('GitHub correlation requires repository plus verified PR, branch, or commit',()=>{
 const s=new Store(':memory:');try{s.ingest('alpha',event({branch:'agent/one',pr_url:'https://github.com/envisix/test/pull/3'}));const a=s.agents('alpha')[0];assert.equal(matchesGitHub(a,'other/repo',{branch:'agent/one'}),false);assert.equal(matchesGitHub(a,'envisix/test',{}),false);assert.equal(matchesGitHub(a,'envisix/test',{prUrl:a.prUrl}),true);const g=new GitHubAdapter(tenant,s);g.apply('envisix/test','pull_request',{pull_request:{number:3,title:'Verified PR',state:'open',head:{ref:'agent/one',sha:'abcdef123456'},html_url:a.prUrl}},'delivery1');g.apply('envisix/test','pull_request',{pull_request:{number:3,title:'Verified PR',state:'open',head:{ref:'agent/one',sha:'abcdef123456'},html_url:a.prUrl}},'delivery1');assert.equal(s.events('alpha').length,2);assert.equal(s.snapshot('alpha').agents[0].liveDelivery!.pr!.title,'Verified PR');}finally{s.close();}
});
test('HTTP and WebSocket auth, tenant isolation, recovery, MCP, and signed webhooks',async()=>{
 const s=new Store(':memory:'),beta={...tenant,id:'beta',viewToken:'beta-view-token-0000000000',ingestToken:'beta-ingest-token-0000000'};
 const config:Config={host:'127.0.0.1',port:0,db:':memory:',tenants:[tenant,beta],pollMs:30000,maxAgents:100,maxStreams:0,allowedOrigins:['http://allowed.test']};const app=createApp(config,s,{poll:false});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${(app.server.address() as any).port}`;let ws:WebSocket|undefined;
 try{
  assert.equal((await fetch(base+'/api/snapshot')).status,401);
  assert.equal((await fetch(base+'/api/snapshot',{headers:{Authorization:`Bearer ${tenant.viewToken}`,Origin:'http://evil.test'}})).status,403);
  const ingest=await fetch(base+'/api/grok/report',{method:'POST',headers:{Authorization:`Bearer ${tenant.ingestToken}`,'Content-Type':'application/json'},body:JSON.stringify(event())});assert.equal(ingest.status,202);
  const login=await fetch(base+'/api/session',{method:'POST',headers:{Authorization:`Bearer ${tenant.viewToken}`}});const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const browserLogin=await fetch(base+'/api/browser-login',{method:'POST',headers:{Authorization:`Bearer ${tenant.viewToken}`}}).then(r=>r.json());assert.ok(browserLogin.code);assert.ok(!JSON.stringify(browserLogin).includes(tenant.viewToken));
  const redeem=await fetch(base+'/api/browser-login?code='+browserLogin.code,{redirect:'manual'});assert.equal(redeem.status,303);assert.equal(redeem.headers.get('location'),'/?mode=live');const browserCookie=redeem.headers.get('set-cookie')!.split(';')[0];assert.equal((await fetch(base+'/api/snapshot',{headers:{Cookie:browserCookie}})).status,200);assert.equal((await fetch(base+'/api/browser-login?code='+browserLogin.code,{redirect:'manual'})).status,401);
  const betaSnapshot=await fetch(base+'/api/snapshot?tenant=alpha',{headers:{Authorization:`Bearer ${beta.viewToken}`}}).then(r=>r.json());assert.equal(betaSnapshot.agents.length,0);
  ws=new WebSocket(base.replace('http:','ws:')+'/api/ws',{headers:{Cookie:cookie,Origin:'http://allowed.test'}});const first=await once(ws,'message');assert.equal(JSON.parse(first[0].toString()).snapshot.agents.length,1);
  ws.send(JSON.stringify({type:'subscribe',after:0,tenant:'beta'}));const recovery=await once(ws,'message');assert.equal(JSON.parse(recovery[0].toString()).events[0].agent_id,'bot-1');
  const mcp=await fetch(base+'/api/mcp',{method:'POST',headers:{Authorization:`Bearer ${tenant.ingestToken}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(r=>r.json());assert.equal(mcp.result.tools[0].name,'report_activity');
  const mcpCall=await fetch(base+'/api/mcp',{method:'POST',headers:{Authorization:`Bearer ${tenant.ingestToken}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'report_activity',arguments:event({event_id:'mcp-event',agent_id:'mcp-bot'})}})}).then(r=>r.json());assert.equal(mcpCall.result.isError,undefined);assert.equal(s.agent('alpha','grok_bot:mcp-bot')!.confidence,'reported');
  const raw=Buffer.from(JSON.stringify({repository:{full_name:'envisix/test'},ref:'refs/heads/main'}));const signature='sha256='+createHmac('sha256',tenant.githubSecret!).update(raw).digest('hex');assert.equal(verifySignature(raw,tenant.githubSecret!,signature),true);assert.equal(verifySignature(raw,tenant.githubSecret!,'sha256=bad'),false);
  const webhook=await fetch(base+'/api/webhooks/github/alpha',{method:'POST',headers:{'X-Hub-Signature-256':signature,'X-GitHub-Delivery':'d1','X-GitHub-Event':'push','Content-Type':'application/json'},body:raw});assert.equal(webhook.status,202);
  const bad=await fetch(base+'/api/webhooks/github/alpha',{method:'POST',headers:{'Content-Type':'application/json'},body:raw});assert.equal(bad.status,401);
 }finally{ws?.terminate();await app.close();s.close();}
});
