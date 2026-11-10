import { useEffect,useState } from 'react';
import { ExternalLink,GitBranch,Activity } from 'lucide-react';
import type { Agent } from './simulation';

type HistoryEvent={event_id:string;event_type:string;timestamp:string;tool_name?:string;tool_provider?:string;duration_ms?:number;confidence:string;error_code?:string};
export default function LiveAgentDetails({agent:a}:{agent:Agent}){
  const [history,setHistory]=useState<{id:string;events:HistoryEvent[];error:boolean}>({id:a.id,events:[],error:false});
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    const query=new URLSearchParams({agent:a.externalId??a.id,provider:a.provider??'',limit:'30',latest:'true'});
    const timer=setTimeout(()=>{void fetch('/api/events?'+query,{credentials:'same-origin',signal:controller.signal,cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(active)setHistory({id:a.id,events:data.events.slice().reverse(),error:false});}).catch(()=>{if(active)setHistory({id:a.id,events:[],error:true});});},100);
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[a.id,a.externalId,a.provider,a.updatedAt]);
  const rows=[['Provider',a.provider==='cursor_cloud'?'Cursor Cloud':a.provider],['Provider state',a.rawStatus??a.status],['Activity',a.activityKnown===false?'Not reported':a.activity],['Repository',a.repository??'Not reported'],['Branch',a.branch??'Not reported'],['Agent ID',a.externalId??a.id],['Run ID',a.runId??'Not reported'],['Session ID',a.sessionId??'Not reported'],['Last event',a.updatedAt?new Date(a.updatedAt).toLocaleString():'Not reported'],['Evidence',`${a.source??'Unknown'} · ${a.confidence??'unknown'}`]];
  const events=history.id===a.id?history.events:[];
  return <>
    <div className="section-label"><span><Activity size={12}/> LIVE DETAILS</span></div>
    <dl className="live-detail-grid">{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>
    <div className="live-detail-links">{a.sourceUrl&&<a href={a.sourceUrl} target="_blank" rel="noreferrer">Open in Cursor <ExternalLink size={12}/></a>}{a.prUrl&&<a href={a.prUrl} target="_blank" rel="noreferrer"><GitBranch size={12}/> Pull request <ExternalLink size={12}/></a>}</div>
    <div className="section-label">TOOLS <span>{a.tools?.length??0} REPORTED</span></div>
    {!a.tools?.length?<p className="muted">No tool activity reported for this agent.</p>:<div className="live-tools">{a.tools.slice(-12).reverse().map((tool,i)=><div key={`${tool.name}-${tool.startedAt}-${i}`}><span>{tool.name}<small>{tool.provider??'Provider tool'}</small></span><span className={tool.state==='failed'?'tool-failed':''}>{tool.state}<small>{tool.durationMs!==undefined?`${(tool.durationMs/1000).toFixed(1)}s`:'Since '+new Date(tool.startedAt).toLocaleTimeString()}</small></span></div>)}</div>}
    <div className="section-label">RECENT EVENTS <span>LAST 30</span></div>
    {events.map(event=><div className="live-history-event" key={event.event_id}><span className="status-dot"/><div><b>{event.event_type.replaceAll('.',' · ')}</b>{event.tool_name&&<span>{event.tool_name}{event.tool_provider?` · ${event.tool_provider}`:''}</span>}<small>{new Date(event.timestamp).toLocaleString()} · {event.confidence}{event.duration_ms!==undefined?` · ${event.duration_ms}ms`:''}{event.error_code?` · ${event.error_code}`:''}</small></div></div>)}
    {!events.length&&<p className="muted">{history.id===a.id&&history.error?'Event history is temporarily unavailable.':'No event history reported yet.'}</p>}
  </>;
}
