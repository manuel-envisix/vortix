import { startTransition, useEffect, useRef, useState } from 'react';
import type { Snapshot } from './simulation';

// Data plumbing only: URL selects the source; no replacement dashboard or renderer.
export function useLiveFleet(){
  const enabled=new URLSearchParams(location.search).get('mode')==='live';
  const [authRevision,setAuthRevision]=useState(0);
  useEffect(()=>{const changed=()=>setAuthRevision(n=>n+1);window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
  const [snapshot,setSnapshot]=useState<Snapshot>({agents:[],events:[],projects:[],tick:0,mode:'live'});
  const [connection,setConnection]=useState('Connecting');const latest=useRef(snapshot),cursor=useRef(0);
  useEffect(()=>{
    if(!enabled)return;
    let stopped=false,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>|undefined,delay=1000;
    function apply(next:Snapshot){
      if(!Array.isArray(next.agents)||!Array.isArray(next.projects)||!Array.isArray(next.events))throw Error('Invalid snapshot');
      if(next.agents.length>100)next={...next,agents:next.agents.slice(0,100)};
      const previous=latest.current;
      const projects=JSON.stringify(previous.projects)===JSON.stringify(next.projects)?previous.projects:next.projects;
      const before=new Map(previous.agents.map(a=>[a.id,a]));
      const agents=next.agents.map(a=>{const old=before.get(a.id);return old&&JSON.stringify(old)===JSON.stringify(a)?old:a;});
      latest.current={...next,projects,agents};cursor.current=next.cursor??0;
      startTransition(()=>setSnapshot(latest.current));
    }
    async function connect(){
      try{
        const params=new URLSearchParams(location.hash.slice(1)),token=params.get('token');
        if(token){const response=await fetch('/api/session',{method:'POST',headers:{Authorization:`Bearer ${token}`},credentials:'same-origin'});if(!response.ok)throw Error('Viewer authentication required');history.replaceState(null,'',location.pathname+location.search);}
        const response=await fetch('/api/snapshot',{credentials:'same-origin',cache:'no-store'});
        if(response.status===401){setConnection('Viewer token required');return;}
        if(!response.ok)throw Error('Backend unavailable');
        const data=await response.json();if(stopped)return;apply(data);
        socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/ws`);
        socket.onopen=()=>{delay=1000;setConnection('Live connected');socket!.send(JSON.stringify({type:'subscribe',after:cursor.current}));};
        socket.onmessage=e=>{try{const message=JSON.parse(e.data);if(message.type==='snapshot')apply(message.snapshot);}catch{socket?.close();}};
        socket.onclose=()=>{if(!stopped){setConnection('Reconnecting · last known state');retry=setTimeout(connect,delay);delay=Math.min(30000,delay*2);}};
        socket.onerror=()=>socket?.close();
      }catch{if(!stopped){setConnection('Backend unavailable');retry=setTimeout(connect,delay);delay=Math.min(30000,delay*2);}}
    }
    void connect();return()=>{stopped=true;clearTimeout(retry);socket?.close();};
  },[enabled,authRevision]);
  return {enabled,snapshot,connection};
}
