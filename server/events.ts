import { createHash } from 'node:crypto';
import { z } from 'zod';

export const activities = ['coding','testing','reviewing','researching','waiting','delegating'] as const;
const id = z.string().min(1).max(240);
const text = z.string().max(256);
export const eventSchema = z.object({
  event_id: id, provider: z.enum(['cursor_cloud','grok_bot','github']), agent_id: id,
  session_id: id.optional(), run_id: id.optional(), parent_agent_id: id.nullable().optional(),
  project_id: id.optional(), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  name: text.optional(), task: text.optional(), task_id: id.optional(),
  status: z.enum(['working','waiting','complete','error','unknown']).optional(),
  activity: z.enum(activities).optional(),
  event_type: z.enum(['agent.discovered','agent.updated','agent.started','agent.completed','agent.failed','agent.waiting','agent.resumed','tool.started','tool.completed','tool.failed','model.request.started','model.request.completed','subagent.spawned','subagent.completed','delivery.updated']),
  timestamp: z.iso.datetime({offset:true}), source: z.enum(['cursor_api','cursor_stream','cursor_hook','grok_report','otlp','github_api','github_webhook']),
  confidence: z.enum(['observed','inferred','reported']),activity_confidence:z.enum(['observed','inferred','reported']).optional(),
  tool_name: text.optional(), tool_provider: text.optional(), call_id: id.optional(),
  duration_ms: z.number().min(0).max(604800000).optional(), error_code: text.optional(),
  branch: text.optional(), commit_sha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  pr_url: z.url().max(600).refine(s=>/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(s)).optional(),
  provider_url: z.url().max(600).refine(s=>/^https:\/\/(cursor\.com|grok\.com|github\.com)\//.test(s)).optional(),
  provider_status: text.optional(),
  delivery: z.object({
    pr: z.object({number:z.number().int().positive(),title:text,state:z.enum(['draft','open','merged','closed']),files:z.array(text).max(300),url:z.url().optional(),reviews:z.array(z.object({id:z.number().int(),state:text,submittedAt:z.string().optional()})).max(100).optional()}).optional(),
    pipeline: z.object({id,stages:z.array(z.object({name:text,state:z.enum(['passed','running','queued','failed','unknown'])})).max(150)}).optional()
  }).optional()
});
export type AgentEvent = z.infer<typeof eventSchema>;
export type StoredEvent = AgentEvent & {seq:number};
export interface AgentState {
  id:string; provider:AgentEvent['provider']; externalId:string; name:string; repository?:string;
  projectKey:string; sessionId?:string; runId?:string; parentId?:string; taskId?:string;
  task:string; status:'working'|'waiting'|'complete'|'error'|'unknown'; activity:typeof activities[number]|null;
  timestamp:string; executionAt?:string;source:AgentEvent['source']; confidence:AgentEvent['confidence']; branch?:string; commitSha?:string;
  prUrl?:string; providerUrl?:string; providerStatus?:string; delivery?:AgentEvent['delivery'];
  tools:Record<string,{name:string;provider?:string;startedAt:string;state:'running'|'completed'|'failed';durationMs?:number}>;
  activityAt?:string;activityConfidence?:AgentEvent['confidence'];
}
export const identity = (provider:string,agent:string) => `${provider}:${agent}`;
export function eventId(...parts:unknown[]) {return createHash('sha256').update(JSON.stringify(parts)).digest('hex');}
export function classifyTool(name:string):AgentEvent['activity']|undefined {
  const s=name.toLowerCase();
  if (/test|pytest|vitest|jest|coverage/.test(s)) return 'testing';
  if (/review|pull_request|code_review/.test(s)) return 'reviewing';
  if (/read|search|fetch|browse|grep|glob|history|list/.test(s)) return 'researching';
  if (/edit|write|patch|create|delete|replace/.test(s)) return 'coding';
  if (/subagent|delegate|spawn|task/.test(s)) return 'delegating';
  return undefined;
}
export function reduceAgent(old:AgentState|undefined,e:AgentEvent):AgentState {
  const fresh:AgentState=old??{id:identity(e.provider,e.agent_id),provider:e.provider,externalId:e.agent_id,name:e.name??e.agent_id,projectKey:e.project_id??e.repository??'unassigned',task:'Not reported',status:'unknown',activity:null,timestamp:e.timestamp,source:e.source,confidence:e.confidence,tools:{}};
  if(old && e.event_type!=='delivery.updated' && old.executionAt && Date.parse(e.timestamp)<Date.parse(old.executionAt))return old;
  const next={...fresh,tools:{...fresh.tools},timestamp:Date.parse(e.timestamp)>Date.parse(fresh.timestamp)?e.timestamp:fresh.timestamp};
  if(e.event_type!=='delivery.updated')next.executionAt=e.timestamp;
  if(e.name)next.name=e.name;
  if(e.repository)next.repository=e.repository;
  if(e.project_id||e.repository)next.projectKey=e.project_id??e.repository!;
  if(e.session_id)next.sessionId=e.session_id;
  if(e.run_id&&e.run_id!==next.runId){next.runId=e.run_id;next.tools={};next.activity=null;next.activityAt=undefined;}
  if(e.parent_agent_id!==undefined)next.parentId=e.parent_agent_id?identity(e.provider,e.parent_agent_id):undefined;
  if(e.task)next.task=e.task;
  if(e.task_id)next.taskId=e.task_id;
  if(e.status)next.status=e.status;
  if(['agent.started','agent.resumed'].includes(e.event_type)||(e.event_type==='subagent.spawned'&&e.confidence!=='inferred'))next.status='working';
  if(e.event_type==='tool.started'&&next.status!=='complete'&&next.status!=='error')next.status='working';
  if(next.status==='working'&&fresh.status==='waiting'&&!e.activity){next.activity=null;next.activityAt=undefined;next.activityConfidence=undefined;}
  if(e.provider_status)next.providerStatus=e.provider_status;
  if(e.provider_url)next.providerUrl=e.provider_url;
  if(e.branch)next.branch=e.branch;
  if(e.commit_sha)next.commitSha=e.commit_sha;
  if(e.pr_url)next.prUrl=e.pr_url;
  if(e.delivery)next.delivery={...next.delivery,...e.delivery};
  const activityConfidence=e.activity_confidence??e.confidence;
  if(e.activity && next.status!=='complete' && next.status!=='error' && (activityConfidence!=='inferred'||!next.activityAt||next.activityConfidence==='inferred'||Date.parse(e.timestamp)-Date.parse(next.activityAt)>30000)){next.activity=e.activity;next.activityAt=e.timestamp;next.activityConfidence=activityConfidence;next.confidence=e.confidence;next.source=e.source;}
  if(e.event_type.startsWith('tool.')&&e.call_id){
    const previous=next.tools[e.call_id];
    next.tools[e.call_id]={name:e.tool_name??previous?.name??'Unknown tool',provider:e.tool_provider??previous?.provider,startedAt:previous?.startedAt??e.timestamp,state:e.event_type==='tool.started'?'running':e.event_type==='tool.failed'?'failed':'completed',durationMs:e.duration_ms??(previous?Math.max(0,Date.parse(e.timestamp)-Date.parse(previous.startedAt)):undefined)};
    const entries=Object.entries(next.tools);if(entries.length>100)delete next.tools[entries[0][0]];
  }
  const terminal=e.event_type==='agent.completed'||e.event_type==='agent.failed'||e.event_type==='subagent.completed';
  if(terminal){next.status=e.event_type==='agent.failed'?'error':'complete';next.activity=null;next.activityConfidence=undefined;next.source=e.source;next.confidence=e.confidence;}
  if(e.event_type==='agent.waiting'){next.status='waiting';next.activity='waiting';next.activityConfidence=e.confidence;next.source=e.source;next.confidence=e.confidence;}
  return next;
}
