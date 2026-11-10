// Explicitly synthetic local fixture server. Never contacts a provider account.
import { Store } from '../server/store';
import { createApp } from '../server/app';
import type { Config } from '../server/config';
const store=new Store(':memory:');
const config:Config={host:'127.0.0.1',port:4311,db:':memory:',pollMs:30000,maxAgents:100,maxStreams:0,allowedOrigins:['http://127.0.0.1:4311'],tenants:[{id:'fixture',viewToken:'synvix-local-fixture-view-token',ingestToken:'synvix-local-fixture-ingest-token',repositories:[]}]};
for(let i=0;i<6;i++)store.ingest('fixture',{event_id:`fixture-${i}`,provider:'grok_bot',agent_id:`fixture-bot-${i}`,name:`Fixture Bot ${i}`,session_id:`fixture-session-${i}`,run_id:`fixture-run-${i}`,parent_agent_id:i?'fixture-bot-0':null,repository:i%2?'fixtures/commerce':'fixtures/platform',task:'Local smoke fixture — not a real Grok session',event_type:'agent.started',timestamp:new Date().toISOString(),source:'grok_report',confidence:'reported',status:'working'});
const app=createApp(config,store,{poll:false});
app.server.listen(4311,'127.0.0.1',()=>console.log('Synthetic fixture preview: http://127.0.0.1:4311/?mode=live#token=synvix-local-fixture-view-token'));
let tick=0;const timer=setInterval(()=>{const waiting=++tick%2===0;store.ingest('fixture',{event_id:`fixture-tick-${tick}`,provider:'grok_bot',agent_id:'fixture-bot-0',event_type:waiting?'agent.waiting':'agent.resumed',timestamp:new Date().toISOString(),source:'grok_report',confidence:'reported',status:waiting?'waiting':'working'});},3000);
process.on('SIGINT',()=>{clearInterval(timer);void app.close().then(()=>{store.close();process.exit(0);});});
