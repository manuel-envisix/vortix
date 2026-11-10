import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Launch the local viewer without printing credentials or giving provider keys to Chrome.
const browserEnv={...process.env};
for(const key of ['CURSOR_API_KEY','GITHUB_TOKEN','GITHUB_WEBHOOK_SECRET','SYNVIX_VIEW_TOKEN','SYNVIX_INGEST_TOKEN'])delete browserEnv[key];
try{process.loadEnvFile('.env');}catch{console.error('Create .env and configure SYNVIX_VIEW_TOKEN first.');process.exit(1);}
const token=process.env.SYNVIX_VIEW_TOKEN,port=Number(process.env.SYNVIX_PORT??4310);
if(!token||!Number.isInteger(port)||port<1||port>65535){console.error('Configure a viewer token and a valid backend port in .env.');process.exit(1);}
const candidates=[process.env.CHROME_PATH,...[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA].filter(Boolean).map(root=>path.join(root,'Google','Chrome','Application','chrome.exe'))].filter(Boolean);
const chrome=candidates.find(file=>existsSync(file));
if(!chrome){console.error('Chrome was not found. Set CHROME_PATH to its executable.');process.exit(1);}
let code;
try{const response=await fetch(`http://127.0.0.1:${port}/api/browser-login`,{method:'POST',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error();code=(await response.json()).code;if(typeof code!=='string'||!/^[a-f0-9]{64}$/.test(code))throw Error();}catch{console.error('Backend sign-in failed. Start the backend with npm start and check the viewer token in .env.');process.exit(1);}
const child=spawn(chrome,['--new-window',`http://127.0.0.1:${port}/api/browser-login?code=${code}`],{detached:true,windowsHide:false,stdio:'ignore',env:browserEnv});
child.on('error',()=>{console.error('Could not open Chrome.');process.exitCode=1;});
child.unref();
console.log('Opened the authenticated local live view in Chrome.');
