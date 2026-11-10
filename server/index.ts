import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readConfig } from './config';
import { Store } from './store';
import { createApp } from './app';
const config=readConfig();mkdirSync(path.dirname(config.db),{recursive:true});
const store=new Store(config.db),app=createApp(config,store);
app.server.listen(config.port,config.host,()=>{
  console.log(`Synvix backend: http://${config.host}:${config.port} (loopback only)`);
  console.log(config.tenants.length?'Connectors configured. Viewer credentials stay in your local environment.':'No credentials configured. Demo remains available; copy .env.example to .env to enable authenticated live data.');
});
let stopping=false;async function stop(){if(stopping)return;stopping=true;await app.close();store.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
