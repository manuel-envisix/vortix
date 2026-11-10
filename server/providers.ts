import { eventId, classifyTool, type AgentEvent, type AgentState } from './events';
import type { Store } from './store';
import type { Tenant, Config } from './config';

export interface Diagnostic {provider:string;configured:boolean;state:'disabled'|'idle'|'connected'|'error';lastSuccess?:string;lastError?:string;nextRetryAt?:string;activeStreams?:number;streamError?:string;streamRetryAt?:string}
export class ProviderError extends Error {constructor(readonly status:number,readonly retryMs=0){super(`Provider HTTP ${status}`);}}
export async function apiJson(url:string,headers:Record<string,string>,fetcher:typeof fetch=fetch):Promise<any>{
  const r=await fetcher(url,{headers,signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!r.ok){const retry=Number(r.headers.get('retry-after'));const reset=Number(r.headers.get('x-ratelimit-reset'));throw new ProviderError(r.status,Number.isFinite(retry)&&retry>0?retry*1000:reset?Math.max(0,reset*1000-Date.now()):0);}
  if(Number(r.headers.get('content-length')??0)>4*1024*1024)throw Error('Provider response too large');
  const reader=r.body!.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw Error('Provider response too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function* parseSse(body:ReadableStream<Uint8Array>):AsyncGenerator<{event:string;id?:string;data:any}>{
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
  try{while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replace(/\r/g,'');if(buffer.length>1024*1024)throw Error('SSE event too large');let end:number;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);let event='message',id:string|undefined;const data:string[]=[];for(const line of block.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('id:'))id=line.slice(3).trim();else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}if(data.length){try{yield {event,id,data:JSON.parse(data.join('\n'))};}catch{ /* malformed provider record is ignored */ }}}}}finally{await reader.cancel().catch(()=>{});}
}

export class CursorCloudAdapter {
  readonly diagnostic:Diagnostic; private streams=new Map<string,AbortController>();private streamRetry=new Map<string,number>();private stopped=false;
  constructor(private tenant:Tenant,private store:Store,private config:Pick<Config,'maxAgents'|'maxStreams'>,private fetcher:typeof fetch=fetch,private base='https://api.cursor.com'){
    this.diagnostic={provider:'cursor_cloud',configured:!!tenant.cursorKey,state:tenant.cursorKey?'idle':'disabled'};
  }
  private headers(){return {Authorization:`Bearer ${this.tenant.cursorKey}`,Accept:'application/json'};}
  async poll(){
    if(!this.tenant.cursorKey)return;
    const agents:any[]=[];let cursor:string|undefined;const seen=new Set<string>();
    do{const page=await apiJson(`${this.base}/v1/agents?limit=100&includeArchived=false${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,this.headers(),this.fetcher);if(!Array.isArray(page.items))throw Error('Invalid Cursor list response');agents.push(...page.items.filter((a:any)=>a.status!=='ARCHIVED'));cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Repeated Cursor pagination cursor');if(cursor)seen.add(cursor);}while(cursor&&agents.length<this.config.maxAgents);
    const pending=agents.slice(0,this.config.maxAgents);let offset=0;const active=new Set<string>();
    this.store.cursor(this.tenant.id,'cursor-visible-agents',JSON.stringify(pending.map(a=>a.id)));
    this.store.emit('change',this.tenant.id);
    for(const [key,controller]of this.streams)if(!pending.some(a=>key.startsWith(a.id+'/')))controller.abort();
    const workers=await Promise.allSettled(Array.from({length:Math.min(3,pending.length)},async()=>{while(offset<pending.length){const item=pending[offset++];
      const detail=await apiJson(`${this.base}/v1/agents/${encodeURIComponent(item.id)}`,this.headers(),this.fetcher);
      if(detail.status==='ARCHIVED'){
        const visible=JSON.parse(this.store.cursor(this.tenant.id,'cursor-visible-agents')??'[]');this.store.cursor(this.tenant.id,'cursor-visible-agents',JSON.stringify(visible.filter((id:string)=>id!==detail.id)));this.store.emit('change',this.tenant.id);continue;
      }
      let run:any;if(detail.latestRunId)run=await apiJson(`${this.base}/v1/agents/${encodeURIComponent(item.id)}/runs/${encodeURIComponent(detail.latestRunId)}`,this.headers(),this.fetcher);
      else {const page=await apiJson(`${this.base}/v1/agents/${encodeURIComponent(item.id)}/runs?limit=1`,this.headers(),this.fetcher);run=page.items?.[0];}
      const branches=run?.git?.branches??[],repoUrl=detail.repos?.[0]?.url??branches[0]?.repoUrl;
      const repository=githubRepository(repoUrl),branch=branches.find((b:any)=>githubRepository(b.repoUrl)===repository)??branches[0];
      const states:Record<string,AgentEvent['status']>={CREATING:'working',RUNNING:'working',WAITING_FOR_BACKGROUND_WORK:'waiting',FINISHED:'complete',ERROR:'error',CANCELLED:'waiting',EXPIRED:'waiting'};
      const status=states[run?.status]??'unknown';
      if(!this.store.cursor(this.tenant.id,`cursor-history:${detail.id}`)){
        const history=await apiJson(`${this.base}/v1/agents/${encodeURIComponent(item.id)}/runs?limit=20`,this.headers(),this.fetcher);
        if(!Array.isArray(history.items))throw Error('Invalid Cursor runs response');
        for(const past of [...history.items].reverse())if(past.id!==run?.id){const state=states[past.status]??'unknown';this.store.ingest(this.tenant.id,{event_id:eventId('cursor-history',detail.id,past.id,past.status,past.updatedAt),provider:'cursor_cloud',agent_id:detail.id,run_id:past.id,session_id:detail.id,event_type:state==='complete'?'agent.completed':state==='error'?'agent.failed':'agent.updated',status:state,repository,timestamp:past.updatedAt??past.createdAt??new Date().toISOString(),source:'cursor_api',confidence:'observed',name:detail.name?.slice(0,256),provider_status:past.status});}
        this.store.cursor(this.tenant.id,`cursor-history:${detail.id}`,'loaded');
      }
      const timestamp=run?.updatedAt??detail.updatedAt??new Date().toISOString();
      const event:AgentEvent={event_id:eventId('cursor',detail.id,run?.id,run?.status,timestamp,repository,branch,detail.status),provider:'cursor_cloud',agent_id:detail.id,session_id:detail.id,run_id:run?.id,event_type:run?.status==='FINISHED'?'agent.completed':run?.status==='ERROR'?'agent.failed':'agent.updated',status,timestamp,source:'cursor_api',confidence:'observed',name:detail.name?.slice(0,256),task:detail.name?.slice(0,256),repository,branch:branch?.branch,pr_url:validPr(branch?.prUrl),provider_url:detail.url,provider_status:run?.status??detail.status};
      this.store.ingest(this.tenant.id,event);
      if(run&&['CREATING','RUNNING','WAITING_FOR_BACKGROUND_WORK'].includes(run.status)){
        const key=`${detail.id}/${run.id}`;active.add(key);
        if(!this.stopped&&!this.streams.has(key)&&this.streams.size<this.config.maxStreams&&(this.streamRetry.get(key)??0)<=Date.now()){const controller=new AbortController();this.streams.set(key,controller);void this.stream(detail.id,run.id,repository,controller).catch(error=>{if(!this.stopped&&!controller.signal.aborted){const retry=Date.now()+Math.max(30000,error instanceof ProviderError?error.retryMs:0);this.streamRetry.set(key,retry);this.diagnostic.streamError=error instanceof ProviderError?`HTTP_${error.status}`:'Stream unavailable; polling remains active';this.diagnostic.streamRetryAt=new Date(retry).toISOString();}}).finally(()=>{this.streams.delete(key);this.diagnostic.activeStreams=this.streams.size;});}
      }
    }}));
    const failed=workers.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    for(const [key,controller] of this.streams)if(!active.has(key))controller.abort();
    this.diagnostic.activeStreams=this.streams.size;this.diagnostic.state='connected';this.diagnostic.lastSuccess=new Date().toISOString();this.diagnostic.lastError=undefined;
  }
  private async stream(agentId:string,runId:string,repository:string|undefined,controller:AbortController){
    const cursorKey=`cursor-stream:${agentId}:${runId}`,last=this.store.cursor(this.tenant.id,cursorKey);
    const response=await this.fetcher(`${this.base}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`,{headers:{...this.headers(),Accept:'text/event-stream',...(last?{'Last-Event-ID':last}:{})},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]),redirect:'error'});
    if(response.status===410||response.status===400){this.store.cursor(this.tenant.id,cursorKey,'');return;}
    if(!response.ok||!response.body)throw new ProviderError(response.status,Math.max(0,Number(response.headers.get('retry-after')??0)*1000));
    this.diagnostic.streamError=undefined;this.diagnostic.streamRetryAt=undefined;
    for await(const record of parseSse(response.body)){
      const d=record.data;let event:Partial<AgentEvent>|undefined;
      if(record.event==='tool_call')event={event_type:d.status==='running'?'tool.started':d.result?.isError===true||d.result?.is_error===true?'tool.failed':'tool.completed',call_id:d.callId,tool_name:typeof d.name==='string'?d.name.slice(0,256):undefined,tool_provider:typeof d.name==='string'&&/^mcp/i.test(d.name)?'mcp':undefined,activity:classifyTool(d.name??'')};
      if(record.event==='status'||record.event==='result'){
        const status=String(d.status);event={event_type:status==='FINISHED'?'agent.completed':status==='ERROR'?'agent.failed':status==='WAITING_FOR_BACKGROUND_WORK'?'agent.waiting':'agent.updated',status:status==='FINISHED'?'complete':status==='ERROR'?'error':['CREATING','RUNNING'].includes(status)?'working':'waiting',provider_status:status};
        if(record.event==='result'){const b=d.git?.branches?.[0];event.branch=b?.branch;event.pr_url=validPr(b?.prUrl);}
      }
      if(event)this.store.ingest(this.tenant.id,{...event,activity_confidence:event.activity?'inferred':undefined,event_id:eventId('cursor-stream',agentId,runId,record.id??[record.event,d.status,d.callId]),provider:'cursor_cloud',agent_id:agentId,session_id:agentId,run_id:runId,repository,timestamp:new Date().toISOString(),source:'cursor_stream',confidence:'observed'});
      if(record.id)this.store.cursor(this.tenant.id,cursorKey,record.id);
      if(record.event==='done')break;
    }
  }
  stop(){this.stopped=true;for(const c of this.streams.values())c.abort();}
}

export function githubRepository(url:unknown):string|undefined {if(typeof url!=='string')return;const match=/^(?:https:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);return match?.[1];}
export function validPr(url:unknown):string|undefined{return typeof url==='string'&&/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)?url:undefined;}
export function matchesGitHub(agent:AgentState,repository:string,evidence:{prUrl?:string;branch?:string;sha?:string}){
  if(agent.repository?.toLowerCase()!==repository.toLowerCase())return false;
  return !!((evidence.prUrl&&agent.prUrl===evidence.prUrl)||(evidence.branch&&agent.branch===evidence.branch)||(evidence.sha&&agent.commitSha===evidence.sha));
}
export class GitHubAdapter {
  readonly diagnostic:Diagnostic;
  constructor(private tenant:Tenant,private store:Store,private fetcher:typeof fetch=fetch,private base='https://api.github.com'){this.diagnostic={provider:'github',configured:!!tenant.githubToken||!!tenant.githubSecret,state:tenant.githubToken||tenant.githubSecret?'idle':'disabled'};}
  private headers(){return {Authorization:`Bearer ${this.tenant.githubToken}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};}
  async poll(){
    if(!this.tenant.githubToken)return;
    const agents=this.store.agents(this.tenant.id);const repos=new Set([...this.tenant.repositories,...agents.flatMap(a=>a.repository?[a.repository]:[])]);
    for(const repo of repos){
      if(!/^[\w.-]+\/[\w.-]+$/.test(repo))continue;
      await apiJson(`${this.base}/repos/${repo}`,this.headers(),this.fetcher);
      const prs=new Set(agents.filter(a=>a.repository===repo&&a.prUrl).map(a=>Number(a.prUrl!.split('/').pop())));
      for(const agent of agents.filter(a=>a.repository===repo&&!a.prUrl&&a.branch)){
        const found=await apiJson(`${this.base}/repos/${repo}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0]+':'+agent.branch)}&per_page=100`,this.headers(),this.fetcher);
        for(const pr of found)if(pr.head?.ref===agent.branch&&pr.head?.repo?.full_name===repo)prs.add(pr.number);
      }
      for(const number of prs){
        const pr=await apiJson(`${this.base}/repos/${repo}/pulls/${number}`,this.headers(),this.fetcher);
        const files=await apiJson(`${this.base}/repos/${repo}/pulls/${number}/files?per_page=100`,this.headers(),this.fetcher);
        const reviews=await apiJson(`${this.base}/repos/${repo}/pulls/${number}/reviews?per_page=100`,this.headers(),this.fetcher);
        await apiJson(`${this.base}/repos/${repo}/commits/${encodeURIComponent(pr.head.sha)}`,this.headers(),this.fetcher);
        const runs=await apiJson(`${this.base}/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(pr.head.sha)}&per_page=20`,this.headers(),this.fetcher);
        this.apply(repo,'pull_request',{pull_request:pr,files,reviews},`poll-pr-${number}-${pr.updated_at}-${eventId(reviews)}`);
        const workflows=new Set<number>();
        for(const run of runs.workflow_runs??[]){if(workflows.has(run.workflow_id))continue;workflows.add(run.workflow_id);if(workflows.size>5)break;
          const jobs=await apiJson(`${this.base}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,this.headers(),this.fetcher);
          this.apply(repo,'workflow_run',{workflow_run:run,jobs:jobs.jobs??[]},`poll-ci-${run.id}-${run.updated_at}-${run.run_attempt}-${eventId(jobs.jobs)}`);
        }
      }
    }
    this.diagnostic.state='connected';this.diagnostic.lastSuccess=new Date().toISOString();this.diagnostic.lastError=undefined;
  }
  apply(repo:string,type:string,payload:any,deliveryId:string){
    const pr=payload.pull_request,run=payload.workflow_run,check=payload.check_run??payload.check_suite,deployment=payload.deployment;
    const prUrl=validPr(pr?.html_url??run?.pull_requests?.[0]?.html_url??(run?.pull_requests?.[0]?.number?`https://github.com/${repo}/pull/${run.pull_requests[0].number}`:undefined));
    const branch=pr?.head?.ref??run?.head_branch??check?.check_suite?.head_branch??deployment?.ref??(type==='push'?payload.ref?.replace(/^refs\/heads\//,''):undefined);
    const sha=pr?.head?.sha??run?.head_sha??check?.head_sha??deployment?.sha??payload.after;
    for(const agent of this.store.agents(this.tenant.id).filter(a=>matchesGitHub(a,repo,{prUrl,branch,sha}))){
      const delivery:NonNullable<AgentEvent['delivery']>={};
      if(pr){const oldPr=agent.delivery?.pr;const previous=oldPr?.number===pr.number?oldPr:undefined;const reviews=payload.reviews??[...(previous?.reviews??[]),...(payload.review?[payload.review]:[])];delivery.pr={number:pr.number,title:String(pr.title??'').slice(0,256),state:pr.merged_at||pr.merged?'merged':pr.state==='closed'?'closed':pr.draft?'draft':'open',files:payload.files?payload.files.slice(0,300).map((f:any)=>String(f.filename).slice(0,256)):previous?.files??[],url:pr.html_url,reviews:[...new Map(reviews.map((r:any)=>[r.id,{id:r.id,state:String(r.state).slice(0,256),submittedAt:r.submitted_at??r.submittedAt}])).values()].slice(-100) as any};}
      const job=run??check??payload.deployment_status;
      if(job){
        const key=`github-job:${agent.id}:${repo}:${sha}:${job.workflow_id??job.name??type}`;
        const version=String(job.updated_at??job.completed_at??job.started_at??'');const previous=this.store.cursor(this.tenant.id,key);if(previous&&version&&Date.parse(version)<Date.parse(previous))continue;if(version)this.store.cursor(this.tenant.id,key,version);
        const stage=(value:any,name:string)=>{const conclusion=value.conclusion??value.state;const state:'passed'|'failed'|'running'|'queued'|'unknown'=['success','neutral','skipped'].includes(conclusion)?'passed':['failure','timed_out','cancelled','action_required','error'].includes(conclusion)?'failed':value.status==='in_progress'||conclusion==='in_progress'?'running':value.status==='queued'||conclusion==='pending'?'queued':'unknown';return {name:name.slice(0,256),state};};
        const current=stage(job,String(job.name??(deployment?'Deployment':'GitHub checks')));
        const reported=(payload.jobs??[]).flatMap((j:any)=>[stage(j,j.name),...(j.steps??[]).map((step:any)=>stage(step,`${j.name} / ${step.name}`))]);
        const old=agent.commitSha===sha?agent.delivery?.pipeline?.stages??[]:[];
        const stages=[...old.filter(s=>s.name!==current.name&&!reported.some((r:any)=>r.name===s.name)),current,...reported].slice(-150);
        delivery.pipeline={id:String(job.id??deliveryId),stages};
      }
      this.store.ingest(this.tenant.id,{event_id:eventId('github',repo,deliveryId,agent.id),provider:agent.provider,agent_id:agent.externalId,event_type:'delivery.updated',timestamp:new Date().toISOString(),source:deliveryId.startsWith('poll-')?'github_api':'github_webhook',confidence:'observed',repository:repo,branch,commit_sha:sha,pr_url:prUrl,delivery});
    }
    this.diagnostic.lastSuccess=new Date().toISOString();this.diagnostic.state='connected';
  }
}
