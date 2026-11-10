import http from 'node:http';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { Store } from './store';
import { eventSchema } from './events';
import { CursorCloudAdapter, GitHubAdapter, ProviderError, type Diagnostic } from './providers';
import { GrokBotAdapter, ingestCursorHook, ingestOtlp } from './ingestion';
import type { Config, Tenant } from './config';
import { issueViewerCookie,verifyViewerCookie } from './viewer-auth';

const equal=(a:string,b:string)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
export function verifySignature(body:Buffer,secret:string,signature:string|undefined){const expected=`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`;return !!signature&&equal(signature,expected);}
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
async function body(req:http.IncomingMessage,max=65536){const chunks:Buffer[]=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>max)throw Object.assign(Error('Payload too large'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks);}
function json(res:http.ServerResponse,status:number,data:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data));}
export function createApp(config:Config,store:Store,options:{poll?:boolean;fetcher?:typeof fetch;webRoot?:string}={}){
  const browserLogins=new Map<string,{tenant:Tenant;expires:number}>(),dirty=new Set<string>(),timers:NodeJS.Timeout[]=[];
  const throttles=new Map<string,{start:number;count:number}>();let stopped=false;
  const providers=config.tenants.map(tenant=>({tenant,cursor:new CursorCloudAdapter(tenant,store,config,options.fetcher),github:new GitHubAdapter(tenant,store,options.fetcher)}));
  const originAllowed=(req:http.IncomingMessage)=>!req.headers.origin||config.allowedOrigins.includes(req.headers.origin);
  function bearer(req:http.IncomingMessage,scope:'view'|'ingest') {const token=req.headers.authorization?.replace(/^Bearer /,'');return token?config.tenants.find(t=>equal(token,scope==='view'?t.viewToken:t.ingestToken)):undefined;}
  function viewer(req:http.IncomingMessage){const cookie=/(?:^|;\s*)synvix_session=([^;]+)/.exec(req.headers.cookie??'')?.[1];return (cookie?verifyViewerCookie(cookie,config.tenants,config.port):undefined)??bearer(req,'view');}
  function setViewerCookie(req:http.IncomingMessage,res:http.ServerResponse,tenant:Tenant){res.setHeader('Set-Cookie',`synvix_session=${issueViewerCookie(tenant,config.port)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${req.headers['x-forwarded-proto']==='https'?'; Secure':''}`);}
  const root=path.resolve(options.webRoot??'dist');
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url??'/','http://localhost');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      if(!originAllowed(req))return json(res,403,{error:'Origin not allowed'});
      if(url.pathname==='/api/health')return json(res,200,{ok:true,service:'synvix',configured:config.tenants.length>0});
      if(!url.pathname.startsWith('/api/')){
        if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'Method not allowed'});
        let name=decodeURIComponent(url.pathname);if(name==='/')name='/index.html';
        const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep))return json(res,403,{error:'Forbidden'});
        try {const bytes=await readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]??'application/octet-stream','Cache-Control':name==='/index.html'?'no-cache':'public,max-age=3600'}).end(req.method==='HEAD'?undefined:bytes);}catch{return json(res,404,{error:'Not found. Build the frontend first.'});}return;
      }
      const throttleKey=`${req.socket.remoteAddress}:${url.pathname}`;let throttle=throttles.get(throttleKey);if(!throttle||Date.now()-throttle.start>60000){throttle={start:Date.now(),count:0};throttles.set(throttleKey,throttle);}if(++throttle.count>2400){res.setHeader('Retry-After','60');return json(res,429,{error:'Rate limited'});}if(throttles.size>1000)throttles.delete(throttles.keys().next().value!);
      if(req.method==='POST'&&url.pathname==='/api/session'){
        const tenant=bearer(req,'view');if(!tenant)return json(res,401,{error:'Viewer token required'});
        setViewerCookie(req,res,tenant);return json(res,200,{tenant:tenant.id});
      }
      if(req.method==='POST'&&url.pathname==='/api/browser-login'){
        const tenant=bearer(req,'view');if(!tenant)return json(res,401,{error:'Viewer token required'});
        const code=randomBytes(32).toString('hex');if(browserLogins.size>=1000)browserLogins.delete(browserLogins.keys().next().value!);browserLogins.set(code,{tenant,expires:Date.now()+60000});return json(res,200,{code,expiresIn:60});
      }
      if(req.method==='GET'&&url.pathname==='/api/browser-login'){
        const code=url.searchParams.get('code')??'',login=browserLogins.get(code);browserLogins.delete(code);
        if(!login||login.expires<Date.now())return json(res,401,{error:'Browser sign-in link expired. Run npm run open:chrome again.'});
        setViewerCookie(req,res,login.tenant);res.writeHead(303,{Location:'/?mode=live','Cache-Control':'no-store'}).end();return;
      }
      const webhook=/^\/api\/webhooks\/github\/([\w-]+)$/.exec(url.pathname);
      if(webhook&&req.method==='POST'){
        const tenant=config.tenants.find(t=>t.id===webhook[1]);if(!tenant?.githubSecret)return json(res,401,{error:'Webhook unavailable'});
        const raw=await body(req,2*1024*1024);if(!verifySignature(raw,tenant.githubSecret,req.headers['x-hub-signature-256'] as string))return json(res,401,{error:'Invalid signature'});
        const payload=JSON.parse(raw.toString('utf8')),repo=payload.repository?.full_name;
        if(typeof repo!=='string'||!tenant.repositories.includes(repo))return json(res,403,{error:'Repository is not configured'});
        const delivery=req.headers['x-github-delivery'];if(typeof delivery!=='string')return json(res,422,{error:'Delivery ID required'});
        providers.find(p=>p.tenant.id===tenant.id)!.github.apply(repo,String(req.headers['x-github-event']),payload,delivery);return json(res,202,{accepted:true});
      }
      if(req.method==='GET'){
        const tenant=viewer(req);if(!tenant)return json(res,401,{error:'Viewer token required'});
        if(url.pathname==='/api/snapshot')return json(res,200,store.snapshot(tenant.id));
        if(url.pathname==='/api/events'||url.pathname==='/api/replay'){
          const after=Math.max(0,Number(url.searchParams.get('after')??0)),limit=Math.min(1000,Math.max(1,Number(url.searchParams.get('limit')??1000)));
          if(!Number.isSafeInteger(after)||!Number.isSafeInteger(limit))return json(res,422,{error:'Invalid cursor'});
          const events=store.events(tenant.id,after,limit,{agent:url.searchParams.get('agent')??undefined,run:url.searchParams.get('run')??undefined,provider:url.searchParams.get('provider')??undefined,latest:url.searchParams.get('latest')==='true'});return json(res,200,{events,cursor:events.at(-1)?.seq??after,latest:store.lastSeq(tenant.id)});
        }
        if(url.pathname==='/api/connectors'){const p=providers.find(p=>p.tenant.id===tenant.id)!;return json(res,200,{tenant:tenant.id,connectors:[p.cursor.diagnostic,p.github.diagnostic,{provider:'grok_bot',configured:true,state:'idle',mode:'reported_events_only'}]});}
        if(url.pathname==='/api/mcp')return json(res,405,{error:'Stateless MCP uses POST'});
        return json(res,404,{error:'Not found'});
      }
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      const tenant=bearer(req,'ingest');if(!tenant)return json(res,401,{error:'Ingestion token required'});
      if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')return json(res,415,{error:'Compressed telemetry not supported'});
      if(!String(req.headers['content-type']).includes('application/json'))return json(res,415,{error:'Use application/json'});
      const input=JSON.parse((await body(req,url.pathname.includes('otlp')?4*1024*1024:65536)).toString('utf8'));
      if(url.pathname==='/api/ingest'){
        const batch=z.array(eventSchema).max(100).parse(Array.isArray(input)?input:[input]);return json(res,202,{accepted:batch.reduce((n,event)=>n+Number(store.ingest(tenant.id,event)),0)});
      }
      if(url.pathname==='/api/hooks/cursor')return json(res,202,{accepted:ingestCursorHook(store,tenant.id,input)});
      if(url.pathname==='/api/grok/report')return json(res,202,{accepted:new GrokBotAdapter(store,tenant.id).report(input)});
      if(url.pathname==='/api/cursor/aliases'){
        const value=z.object({conversation_id:z.string().min(1).max(240),agent_id:z.string().min(1).max(240)}).parse(input);store.cursor(tenant.id,`cursor-alias:${value.conversation_id}`,value.agent_id);return json(res,200,{ok:true});
      }
      const otlp=/^\/api\/otlp\/v1\/(traces|logs)$/.exec(url.pathname);
      if(otlp){ingestOtlp(store,tenant.id,input,otlp[1] as 'traces'|'logs');return json(res,200,{});}
      if(url.pathname==='/api/mcp'){
        const {id,method,params}=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number()]).optional(),method:z.string(),params:z.record(z.string(),z.unknown()).optional()}).parse(input);
        if(id===undefined){res.writeHead(202).end();return;}
        const reply=(result:unknown)=>json(res,200,{jsonrpc:'2.0',id,result});
        if(method==='initialize')return reply({protocolVersion:params?.protocolVersion==='2025-03-26'?'2025-03-26':'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'synvix-activity-reporter',version:'1.0.0'},instructions:'Only report verified activity milestones. Do not send prompts, reasoning, credentials, command text, tool arguments, or raw outputs. Reporting does not grant monitoring access to internal execution.'});
        if(method==='ping')return reply({});
        if(method==='tools/list')return reply({tools:[{name:'report_activity',description:'Report one Grok Bot activity milestone to Synvix. Self-reported metadata only; reuse event_id when retrying.',inputSchema:z.toJSONSchema(eventSchema.omit({provider:true,source:true,confidence:true})),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}]});
        if(method==='tools/call'&&params?.name==='report_activity'){try {const accepted=new GrokBotAdapter(store,tenant.id).report(params.arguments);return reply({content:[{type:'text',text:JSON.stringify({accepted})}]});}catch{return reply({isError:true,content:[{type:'text',text:'Invalid activity metadata'}]});}}
        return json(res,200,{jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
      }
      return json(res,404,{error:'Not found'});
    }catch(error){return json(res,(error as any).status??((error as any).name==='ZodError'||error instanceof SyntaxError?422:500),{error:(error as any).status===413?'Payload too large':'Invalid request or unavailable operation'});}
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
  const clients=new Map<WebSocket,{tenant:Tenant;expires:number;alive:boolean}>();
  server.on('upgrade',(req,socket,head)=>{
    const tenant=viewer(req);if(new URL(req.url??'/','http://localhost').pathname!=='/api/ws'||!tenant||!originAllowed(req)||clients.size>=100){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      clients.set(ws,{tenant,expires:Date.now()+8*3600000,alive:true});
      ws.send(JSON.stringify({type:'snapshot',snapshot:store.snapshot(tenant.id)}));
      ws.on('pong',()=>{const c=clients.get(ws);if(c)c.alive=true;});ws.on('error',()=>ws.terminate());ws.on('close',()=>clients.delete(ws));
      ws.on('message',raw=>{try{const input=JSON.parse(raw.toString());if(input.type==='subscribe'&&Number.isSafeInteger(input.after)&&input.after>=0){const events=store.events(tenant.id,input.after,1000);ws.send(JSON.stringify({type:'recovery',events,cursor:events.at(-1)?.seq??input.after,more:events.length===1000}));ws.send(JSON.stringify({type:'snapshot',snapshot:store.snapshot(tenant.id)}));}}catch{ws.close(1008,'Invalid message');}});
    });
  });
  const changed=(tenant:string)=>dirty.add(tenant);store.on('change',changed);
  timers.push(setInterval(()=>{for(const tenant of dirty){const payload=JSON.stringify({type:'snapshot',snapshot:store.snapshot(tenant)});for(const [ws,client]of clients)if(client.tenant.id===tenant&&ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>1024*1024)ws.terminate();else ws.send(payload);}}dirty.clear();},500));
  timers.push(setInterval(()=>{for(const [ws,c]of clients){if(!c.alive||c.expires<Date.now())ws.terminate();else {c.alive=false;ws.ping();}}for(const [code,s]of browserLogins)if(s.expires<Date.now())browserLogins.delete(code);},15000));
  function schedule(adapter:{poll:()=>Promise<void>;diagnostic:Diagnostic},delay=0,failures=0){if(stopped)return;const timer=setTimeout(async()=>{pollTimers.delete(timer);try{await adapter.poll();adapter.diagnostic.nextRetryAt=undefined;schedule(adapter,config.pollMs);}catch(error){const retry=Math.max(config.pollMs*Math.min(16,2**failures),(error instanceof ProviderError?error.retryMs:0));adapter.diagnostic.state='error';adapter.diagnostic.lastError=error instanceof ProviderError?`HTTP_${error.status}`:'Connection or provider schema error';adapter.diagnostic.nextRetryAt=new Date(Date.now()+retry).toISOString();schedule(adapter,retry,failures+1);}},delay);timer.unref();pollTimers.add(timer);}
  const pollTimers=new Set<NodeJS.Timeout>();if(options.poll!==false)for(const p of providers){if(p.tenant.cursorKey)schedule(p.cursor);if(p.tenant.githubToken)schedule(p.github);}
  return {server,providers,async close(){stopped=true;store.off('change',changed);for(const t of [...timers,...pollTimers])clearTimeout(t);for(const p of providers)p.cursor.stop();for(const ws of clients.keys())ws.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
