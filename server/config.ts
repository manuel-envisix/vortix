import { readFileSync } from 'node:fs';
import { z } from 'zod';
const tenantSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),viewToken:z.string().min(16),ingestToken:z.string().min(16),githubSecret:z.string().optional(),cursorKey:z.string().optional(),githubToken:z.string().optional(),repositories:z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).default([])});
export type Tenant=z.infer<typeof tenantSchema>;
export interface Config {host:string;port:number;db:string;tenants:Tenant[];pollMs:number;maxAgents:number;maxStreams:number;allowedOrigins:string[]}
export function readConfig():Config {
  const tenants=process.env.SYNVIX_TENANTS_FILE?z.array(tenantSchema).parse(JSON.parse(readFileSync(process.env.SYNVIX_TENANTS_FILE,'utf8'))):process.env.SYNVIX_VIEW_TOKEN&&process.env.SYNVIX_INGEST_TOKEN?[tenantSchema.parse({id:'local',viewToken:process.env.SYNVIX_VIEW_TOKEN,ingestToken:process.env.SYNVIX_INGEST_TOKEN,cursorKey:process.env.CURSOR_API_KEY,githubToken:process.env.GITHUB_TOKEN,githubSecret:process.env.GITHUB_WEBHOOK_SECRET,repositories:(process.env.GITHUB_REPOSITORIES??'').split(',').filter(Boolean)})]:[];
  if(new Set(tenants.map(t=>t.id)).size!==tenants.length)throw Error('Duplicate tenant IDs');
  if(new Set(tenants.flatMap(t=>[t.viewToken,t.ingestToken])).size!==tenants.length*2)throw Error('Tenant and scope tokens must be unique');
  const port=Number(process.env.SYNVIX_PORT??4310);
  return {host:'127.0.0.1',port,db:process.env.SYNVIX_DB??'.local/synvix.sqlite',tenants,pollMs:Math.max(15000,Number(process.env.SYNVIX_POLL_MS??30000)),maxAgents:Math.min(100,Math.max(1,Number(process.env.SYNVIX_MAX_AGENTS??100))),maxStreams:Math.min(20,Math.max(0,Number(process.env.SYNVIX_CURSOR_STREAMS??5))),allowedOrigins:[`http://127.0.0.1:${port}`,`http://localhost:${port}`,'http://127.0.0.1:5173','http://localhost:5173',...(process.env.SYNVIX_ORIGINS??'').split(',').filter(Boolean)]};
}
