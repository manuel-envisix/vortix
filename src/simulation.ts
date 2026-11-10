export type Activity = 'coding' | 'testing' | 'reviewing' | 'researching' | 'waiting' | 'delegating';
export interface Project { id: number; key?: string; name: string; short: string; color: string; description: string }
export interface Task { title: string; progress: number | null; cycle: number }
export interface Agent { id: string; name: string; projectId: number; role: Activity; activity: Activity; status: 'working' | 'waiting' | 'complete' | 'error' | 'unknown'; task: Task; parentId?: string; provider?:string;externalId?:string;runId?:string;sessionId?:string;prUrl?:string;progressKnown?:boolean;activityKnown?:boolean;rawStatus?:string;updatedAt?:string;source?:string;confidence?:string;activityConfidence?:string;repository?:string;branch?:string;commitSha?:string;sourceUrl?:string;liveDelivery?:{pr?:PullRequest;pipeline?:PipelineRun};tools?:{name:string;provider?:string;startedAt:string;state:string;durationMs?:number}[] }
export interface ActivityEvent { id: string; agentId: string; text: string; tick: number;timestamp?:string }
export interface PullRequest { number: number; title: string; files: string[]; state: 'draft' | 'open' | 'merged' | 'closed' | 'unknown';url?:string;reviews?:{id:number;state:string;submittedAt?:string}[] }
export interface PipelineRun { id: string; stages: { name: string; state: 'passed' | 'running' | 'queued' | 'failed' | 'unknown' }[] }
export interface Snapshot { agents: Agent[]; events: ActivityEvent[]; tick: number;projects?:Project[];mode?:'live'|'demo';cursor?:number;totalAgents?:number }
export interface AgentDataSource { create(count: number): Snapshot; advance(snapshot: Snapshot): Snapshot }
export const projects: Project[] = [
 {id:0,name:'Nexus Platform',short:'NEX',color:'#1de9b6',description:'Core infrastructure & APIs'},
 {id:1,name:'Orbit Commerce',short:'ORB',color:'#65b8fa',description:'Next-generation storefront'},
 {id:2,name:'Atlas Intelligence',short:'ATL',color:'#ac9bf5',description:'Research & knowledge systems'},
 {id:3,name:'Pulse Analytics',short:'PLS',color:'#e4bf7b',description:'Real-time product insights'},
 {id:4,name:'Sentinel Security',short:'SNT',color:'#71d5cd',description:'Identity & security operations'}
];
export const activities: Activity[] = ['coding','testing','reviewing','researching','waiting','delegating'];
const tasks = ['Implement streaming API','Add integration coverage','Review authentication flow','Research retrieval strategies','Optimize query performance','Coordinate release pipeline'];
export const simulation: AgentDataSource = {
 create(count) {
  const agents = Array.from({length:Math.max(1,Math.min(100,Math.round(count)))},(_,i):Agent=>({id:`agent-${i+1}`,name:`${['Nova','Echo','Atlas','Vega','Sage','Orion','Lyra','Flux'][i%8]}-${String(i+1).padStart(2,'0')}`,projectId:i%5,role:activities[i%6],activity:activities[i%6],status:i%6===4?'waiting':'working',task:{title:tasks[i%6],progress:(i*17+12)%91,cycle:0},parentId:i>=5?`agent-${i%5+1}`:undefined}));
  return {agents,tick:0,events:agents.slice(0,6).map((a,i)=>({id:`initial-${i}`,agentId:a.id,text:`${a.name} started ${a.task.title.toLowerCase()}`,tick:0}))};
 },
 advance(s) {
  const tick=s.tick+1; const events: ActivityEvent[]=[];
  const agents=s.agents.map((a,i)=>{
   if((tick+i)%3!==0)return a;
   let progress=(a.task.progress??0)+5+(i%8),cycle=a.task.cycle; let activity=a.activity; let status=a.status;
   if(progress>=100){progress=100;status='complete';events.push({id:`${tick}-${a.id}`,agentId:a.id,text:`${a.name} completed ${a.task.title.toLowerCase()}`,tick});}
   if(a.status==='complete'){progress=0;cycle++;activity=activities[(i+cycle)%6];status=activity==='waiting'?'waiting':'working';}
   else if(status!=='complete' && tick%4===0){activity=activities[(i+Math.floor(tick/4))%6];status=activity==='waiting'?'waiting':'working';events.push({id:`${tick}-${a.id}`,agentId:a.id,text:`${a.name} · ${activity} · ${projects[a.projectId].name}`,tick});}
   return {...a,activity,status,task:{title:tasks[(i+cycle)%6],progress,cycle}};
  });
  return {agents,tick,events:[...events,...s.events].slice(0,60)};
 }
};
export function delivery(a:Agent): {pr:PullRequest;pipeline:PipelineRun} {
 if(a.provider)return {pr:a.liveDelivery?.pr??{number:0,title:'Not reported',files:[],state:'unknown'},pipeline:a.liveDelivery?.pipeline??{id:'Unavailable',stages:[]}};
 const n=Number(a.id.split('-')[1]);const p=a.task.progress??0;
 return {pr:{number:240+n,title:a.task.title,files:[`src/${projects[a.projectId].short.toLowerCase()}/handler.ts`,'tests/handler.test.ts'],state:p===100?'merged':p>40?'open':'draft'},pipeline:{id:`run-${n}-${a.task.cycle}`,stages:['Build','Unit tests','Integration','Preview deploy'].map((name,i)=>({name,state:p>=(i+1)*25?'passed':p>=i*25?'running':'queued'}))}};
}
export function deliveryStatus(a: Agent): { pr: PullRequest['state']; ci: 'passed' | 'running' | 'queued' | 'failed' | 'unknown' } {
 const { pr, pipeline } = delivery(a);
 return { pr: pr.state, ci: !pipeline.stages.length?'unknown':pipeline.stages.some(s=>s.state==='failed')?'failed':pipeline.stages.every(s => s.state === 'passed') ? 'passed' : pipeline.stages.some(s => s.state === 'running') ? 'running' : pipeline.stages.some(s=>s.state==='queued')?'queued':'unknown' };
}
