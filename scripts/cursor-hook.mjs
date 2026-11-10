// Metadata-only Cloud bridge. Network delivery runs in a separate short-lived process.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const delivery=process.argv[2]==='--deliver';
let size=0;const chunks=[];
for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)break;chunks.push(chunk);}
const event=process.argv[2];
// Neutral hook responses keep the original agent flow and native approval policy in charge.
const finish=()=>{if(!delivery)process.stdout.write(JSON.stringify(event==='preToolUse'||event==='subagentStart'?{permission:'allow'}:event==='beforeSubmitPrompt'?{continue:true}:{}));};
try {
  if(size>1024*1024)throw Error('Oversized input');
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const url=process.env.SYNVIX_INGEST_URL,token=process.env.SYNVIX_INGEST_TOKEN;
  if(!url||!token)throw Error('Not configured');
  if(delivery){
    const target=new URL('/api/hooks/cursor',url);
    if(target.username||target.password||(target.protocol!=='https:'&&!(target.protocol==='http:'&&['127.0.0.1','localhost'].includes(target.hostname))))throw Error('Use HTTPS');
    await fetch(target,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(1200),redirect:'error'});
  } else {
    const allowed=new Set(['beforeSubmitPrompt','preToolUse','postToolUse','postToolUseFailure','afterFileEdit','subagentStart','subagentStop','stop']);
    if(!allowed.has(event)||!input.conversation_id)throw Error('Unsupported event');
    const record={event_id:randomUUID(),event,conversation_id:String(input.conversation_id).slice(0,240),timestamp:new Date().toISOString()};
    for(const [key,value]of Object.entries({agent_id:process.env.SYNVIX_CURSOR_AGENT_ID,run_id:process.env.SYNVIX_CURSOR_RUN_ID,repository:process.env.SYNVIX_REPOSITORY,tool_name:input.tool_name,tool_use_id:input.tool_use_id??input.tool_call_id,subagent_id:input.subagent_id,parent_agent_id:input.parent_agent_id,parent_conversation_id:input.parent_conversation_id}))if(typeof value==='string')record[key]=value.slice(0,key==='tool_name'?256:240);
    if(typeof (input.duration??input.duration_ms)==='number')record.duration_ms=Math.max(0,Math.min(604800000,input.duration??input.duration_ms));
    if(['timeout','error','permission_denied'].includes(input.failure_type))record.error_code=input.failure_type;
    if(['completed','error','aborted'].includes(input.status))record.status=input.status;
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--deliver'],{detached:true,windowsHide:true,stdio:['pipe','ignore','ignore']});
    child.on('error',()=>{});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(record));child.stdin.unref?.();child.unref();
  }
} catch { /* Telemetry never changes task success or injects context/tool output. */ }
finish();
