import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { eventSchema, identity, reduceAgent, type AgentState, type StoredEvent } from './events';
import type { Snapshot, Project, Agent } from '../src/simulation';

export class Store extends EventEmitter {
  readonly db:DatabaseSync;
  constructor(file:string) {
    super();this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant TEXT NOT NULL,event_id TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(tenant,event_id));
      CREATE INDEX IF NOT EXISTS events_tenant_seq ON events(tenant,seq);
      CREATE TABLE IF NOT EXISTS agents(tenant TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS projects(tenant TEXT NOT NULL,key TEXT NOT NULL,id INTEGER NOT NULL,PRIMARY KEY(tenant,key),UNIQUE(tenant,id));
      CREATE TABLE IF NOT EXISTS cursors(tenant TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tenant,key));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS dedupe(tenant TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(tenant,key))');
  }
  ingest(tenant:string,input:unknown) {
    const event=eventSchema.parse(input);this.db.exec('BEGIN IMMEDIATE');
    try {
      if(event.call_id&&event.run_id&&event.event_type.startsWith('tool.')){const key=JSON.stringify([event.provider,event.agent_id,event.run_id,event.call_id,event.event_type]);const inserted=this.db.prepare('INSERT OR IGNORE INTO dedupe VALUES(?,?)').run(tenant,key);if(!inserted.changes){this.db.exec('COMMIT');return false;}}
      const inserted=this.db.prepare('INSERT OR IGNORE INTO events(tenant,event_id,json) VALUES(?,?,?)').run(tenant,event.event_id,JSON.stringify(event));
      if(!inserted.changes){this.db.exec('COMMIT');return false;}
      const key=identity(event.provider,event.agent_id),old=this.agent(tenant,key),next=reduceAgent(old,event);
      this.db.prepare('INSERT INTO agents VALUES(?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET json=excluded.json').run(tenant,key,JSON.stringify(next));
      const project=this.db.prepare('SELECT id FROM projects WHERE tenant=? AND key=?').get(tenant,next.projectKey);
      if(!project){const row=this.db.prepare('SELECT COALESCE(MAX(id),-1)+1 AS id FROM projects WHERE tenant=?').get(tenant)!;this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(tenant,next.projectKey,row.id as number);}
      this.db.exec('COMMIT');this.emit('change',tenant);return true;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  agent(tenant:string,id:string):AgentState|undefined {const row=this.db.prepare('SELECT json FROM agents WHERE tenant=? AND id=?').get(tenant,id);return row?JSON.parse(row.json as string):undefined;}
  agents(tenant:string):AgentState[]{return this.db.prepare('SELECT json FROM agents WHERE tenant=? ORDER BY rowid').all(tenant).map(r=>JSON.parse(r.json as string));}
  events(tenant:string,after=0,limit=1000,filter:{agent?:string;run?:string;provider?:string;latest?:boolean}={}):StoredEvent[]{
    const rows=this.db.prepare("SELECT seq,json FROM events WHERE tenant=? AND seq>? AND (? IS NULL OR json_extract(json,'$.agent_id')=?) AND (? IS NULL OR json_extract(json,'$.run_id')=?) AND (? IS NULL OR json_extract(json,'$.provider')=?) ORDER BY seq "+(filter.latest?'DESC':'ASC')+" LIMIT ?").all(tenant,after,filter.agent??null,filter.agent??null,filter.run??null,filter.run??null,filter.provider??null,filter.provider??null,Math.min(1000,Math.max(1,limit)));
    const events=rows.map(r=>({...JSON.parse(r.json as string),seq:r.seq}));return filter.latest?events.reverse():events;
  }

  cursor(tenant:string,key:string,value?:string):string|undefined{if(value!==undefined)this.db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?,?)').run(tenant,key,value);return this.db.prepare('SELECT value FROM cursors WHERE tenant=? AND key=?').get(tenant,key)?.value as string|undefined;}
  lastSeq(tenant:string){return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE tenant=?').get(tenant)!.seq);}
  snapshot(tenant:string):Snapshot {
    const palette=['#1de9b6','#65b8fa','#ac9bf5','#e4bf7b','#71d5cd'];
    const projects:Project[]=this.db.prepare('SELECT key,id FROM projects WHERE tenant=? ORDER BY id').all(tenant).map(r=>({id:Number(r.id),key:r.key as string,name:r.key==='unassigned'?'Unassigned':r.key as string,short:String(r.key).split('/').pop()!.slice(0,3).toUpperCase(),color:palette[Number(r.id)%palette.length],description:r.key==='unassigned'?'Repository not reported':String(r.key)}));
    const visibleJson=this.cursor(tenant,'cursor-visible-agents');const visible=visibleJson?new Set<string>(JSON.parse(visibleJson)):undefined;
    const rows=this.agents(tenant).filter(a=>a.provider!=='cursor_cloud'||!visible||visible.has(a.externalId)),byProject=new Map(projects.map(p=>[p.key,p.id]));
    const agents:Agent[]=rows.map(a=>({id:a.id,name:a.name,projectId:byProject.get(a.projectKey)!,role:a.activity??'waiting',activity:a.activity??'waiting',status:a.status,task:{title:a.task,progress:null,cycle:0},parentId:a.parentId,provider:a.provider,externalId:a.externalId,runId:a.runId,sessionId:a.sessionId,prUrl:a.prUrl,progressKnown:false,activityKnown:a.activity!==null,rawStatus:a.providerStatus??a.status,updatedAt:a.timestamp,source:a.source,confidence:a.confidence,activityConfidence:a.activityConfidence,repository:a.repository,branch:a.branch,commitSha:a.commitSha,sourceUrl:a.providerUrl,liveDelivery:a.delivery,tools:Object.values(a.tools)}));
    const events=this.db.prepare("SELECT seq,json FROM events WHERE tenant=? AND (? IS NULL OR json_extract(json,'$.provider')!='cursor_cloud' OR json_extract(json,'$.agent_id') IN (SELECT value FROM json_each(?))) ORDER BY seq DESC LIMIT 60").all(tenant,visibleJson??null,visibleJson??'[]').map(r=>{const e=JSON.parse(r.json as string);return {id:String(r.seq),agentId:identity(e.provider,e.agent_id),text:`${e.name??e.agent_id} · ${e.event_type}${e.tool_name?` · ${e.tool_name}`:''}${e.tool_provider?` (${e.tool_provider})`:''} · ${e.confidence}`,tick:0,timestamp:e.timestamp};});
    return {agents,projects,events,tick:0,mode:'live',cursor:this.lastSeq(tenant),totalAgents:agents.length};
  }
  close(){this.db.close();}
}
