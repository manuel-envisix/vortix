import { z } from 'zod';
import { eventSchema, eventId, classifyTool, type AgentEvent } from './events';
import type { Store } from './store';

export class GrokBotAdapter {
  constructor(private store:Store,private tenant:string){}
  report(input:unknown){return this.store.ingest(this.tenant,eventSchema.parse({...input as object,provider:'grok_bot',source:'grok_report',confidence:'reported'}));}
}
const hookSchema=z.object({event_id:z.string().max(240).optional(),event:z.enum(['beforeSubmitPrompt','preToolUse','postToolUse','postToolUseFailure','afterFileEdit','beforeShellExecution','afterShellExecution','subagentStart','subagentStop','stop']),agent_id:z.string().max(240).optional(),conversation_id:z.string().min(1).max(240),run_id:z.string().max(240).optional(),tool_name:z.string().max(256).optional(),tool_use_id:z.string().max(240).optional(),subagent_id:z.string().max(240).optional(),parent_agent_id:z.string().max(240).optional(),repository:z.string().optional(),timestamp:z.iso.datetime({offset:true}),success:z.boolean().optional(),duration_ms:z.number().min(0).max(604800000).optional(),error_code:z.enum(['timeout','error','permission_denied']).optional(),status:z.enum(['completed','error','aborted']).optional(),parent_conversation_id:z.string().max(240).optional()});
export function ingestCursorHook(store:Store,tenant:string,input:unknown){
  const h=hookSchema.parse(input);if(h.event==='subagentStop'&&!h.subagent_id)return false;const mapped=store.cursor(tenant,`cursor-alias:${h.conversation_id}`);
  const root=h.agent_id??mapped??`conversation:${h.conversation_id}`,agentId=h.subagent_id??root;
  const types:Record<string,AgentEvent['event_type']>={beforeSubmitPrompt:'agent.started',preToolUse:'tool.started',postToolUse:'tool.completed',postToolUseFailure:'tool.failed',afterFileEdit:'agent.updated',beforeShellExecution:'tool.started',afterShellExecution:'tool.completed',subagentStart:'subagent.spawned',subagentStop:'subagent.completed',stop:'agent.waiting'};
  const tool=h.tool_name??(h.event==='afterFileEdit'?'edit_file':h.event.includes('Shell')?'shell':undefined);
  const event:AgentEvent={event_id:h.event_id??eventId('cursor-hook',h),provider:'cursor_cloud',agent_id:agentId,session_id:h.conversation_id,run_id:h.run_id,parent_agent_id:h.subagent_id?(h.parent_agent_id??(h.parent_conversation_id?store.cursor(tenant,`cursor-alias:${h.parent_conversation_id}`):undefined)??root):undefined,repository:h.repository,event_type:h.event==='subagentStop'&&h.status==='error'?'agent.failed':h.event==='subagentStop'&&h.status==='aborted'?'agent.waiting':h.success===false&&types[h.event]==='tool.completed'?'tool.failed':types[h.event],timestamp:h.timestamp,source:'cursor_hook',confidence:h.event==='preToolUse'||h.event==='subagentStart'?'inferred':'observed',duration_ms:h.duration_ms,error_code:h.error_code,tool_name:tool,tool_provider:tool&&/^MCP:/i.test(tool)?'mcp':undefined,call_id:h.tool_use_id,activity:tool?classifyTool(tool):undefined,status:h.event==='beforeSubmitPrompt'?'working':h.event==='subagentStart'?'unknown':undefined};
  return store.ingest(tenant,{...event,activity_confidence:event.activity?'inferred':undefined});
}
function attributes(list:any[]):Record<string,any>{const result:Record<string,any>={};for(const x of list??[])result[x.key]=x.value?.stringValue??x.value?.intValue??x.value?.boolValue;return result;}
function nanos(value:unknown){const ms=Number(BigInt(String(value??0))/1000000n);if(!ms||!Number.isFinite(ms))return new Date().toISOString();return new Date(ms).toISOString();}
export function ingestOtlp(store:Store,tenant:string,body:any,kind:'traces'|'logs'){
  let accepted=0;const spans:any[]=[];
  if(kind==='traces')for(const r of body.resourceSpans??[]){const resource=attributes(r.resource?.attributes);for(const s of r.scopeSpans??[])for(const span of s.spans??[])spans.push({...span,attrs:{...resource,...attributes(span.attributes)}});}
  if(spans.length>1000)throw Error('OTLP batch exceeds 1000 spans');
  for(const span of spans)if(span.parentSpanId)store.cursor(tenant,`otel-parent:${span.traceId}:${span.spanId}`,span.parentSpanId);
  // Remember all agent spans first: children may precede parents in an export.
  for(const span of spans){if(span.attrs['gen_ai.operation.name']==='invoke_agent'||String(span.name).startsWith('invoke_agent')){
    const a=span.attrs,external=String(a['gen_ai.agent.id']??span.spanId);
    store.cursor(tenant,`otel:${span.traceId}:${span.spanId}`,JSON.stringify({agent:external,session:a['gen_ai.conversation.id']??span.traceId,provider:a['synvix.provider']==='cursor_cloud'?'cursor_cloud':'grok_bot'}));
  }}
  const direct=(trace:string,span:string|undefined):any=>{const value=span?store.cursor(tenant,`otel:${trace}:${span}`):undefined;return value?JSON.parse(value):undefined;};
  const resolve=(trace:string,span:string|undefined):any=>{const seen=new Set<string>();while(span&&!seen.has(span)&&seen.size<64){seen.add(span);const known=direct(trace,span);if(known)return known;span=store.cursor(tenant,`otel-parent:${trace}:${span}`);}return undefined;};
  for(const span of spans){
    const a=span.attrs,own=direct(span.traceId,span.spanId),parent=resolve(span.traceId,span.parentSpanId);let owner=own??parent;
    if(!owner&&a['gen_ai.agent.id'])owner={agent:a['gen_ai.agent.id'],session:a['gen_ai.conversation.id']??span.traceId,provider:a['synvix.provider']==='cursor_cloud'?'cursor_cloud':'grok_bot'};
    if(!owner)continue;
    const tool=a['gen_ai.tool.name'],isTool=a['gen_ai.operation.name']==='execute_tool'||String(span.name).startsWith('execute_tool');
    if(!own&&!isTool)continue;
    const common={provider:owner.provider,agent_id:String(owner.agent),session_id:String(owner.session),run_id:a['synvix.run.id'],repository:a['synvix.repository'],source:'otlp',confidence:'observed',tool_name:tool,tool_provider:a['gen_ai.tool.type']??a['synvix.tool.provider'],call_id:String(a['gen_ai.tool.call.id']??span.spanId)};
    const start={...common,event_id:eventId('otel',span.traceId,span.spanId,'start'),event_type:own?(parent?'subagent.spawned':'agent.started'):'tool.started',status:own?'working':undefined,parent_agent_id:own&&parent?String(parent.agent):undefined,timestamp:nanos(span.startTimeUnixNano),activity:isTool?classifyTool(String(tool??'')):undefined};
    accepted+=Number(store.ingest(tenant,{...start,activity_confidence:start.activity?'inferred':undefined}));
    if(span.endTimeUnixNano){const failed=span.status?.code===2;accepted+=Number(store.ingest(tenant,{...common,event_id:eventId('otel',span.traceId,span.spanId,'end'),event_type:own?(failed?'agent.failed':'agent.completed'):(failed?'tool.failed':'tool.completed'),timestamp:nanos(span.endTimeUnixNano),duration_ms:Math.max(0,Number((BigInt(span.endTimeUnixNano)-BigInt(span.startTimeUnixNano))/1000000n)),error_code:failed?'SPAN_ERROR':undefined}));}
  }
  if(kind==='logs')for(const r of body.resourceLogs??[])for(const s of r.scopeLogs??[])for(const log of s.logRecords??[]){const a={...attributes(r.resource?.attributes),...attributes(log.attributes)};if(!a['synvix.event_type']||!a['gen_ai.agent.id'])continue;const parsed=eventSchema.safeParse({event_id:eventId('otel-log',a['synvix.event_id']??[log.timeUnixNano,a['gen_ai.agent.id'],a['synvix.event_type']]),provider:a['synvix.provider']==='cursor_cloud'?'cursor_cloud':'grok_bot',agent_id:a['gen_ai.agent.id'],session_id:a['gen_ai.conversation.id'],event_type:a['synvix.event_type'],tool_name:a['gen_ai.tool.name'],tool_provider:a['synvix.tool.provider'],call_id:a['gen_ai.tool.call.id'],timestamp:nanos(log.timeUnixNano),source:'otlp',confidence:'observed'});if(parsed.success)accepted+=Number(store.ingest(tenant,parsed.data));}
  return accepted;
}
