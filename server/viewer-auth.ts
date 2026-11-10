import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Tenant } from './config';

// Viewer cookies survive service restarts; rotating the viewer key invalidates them.
export function issueViewerCookie(tenant:Tenant,audience:number,now=Date.now()){
  const payload=Buffer.from(JSON.stringify({tenant:tenant.id,aud:audience,expires:now+8*3600000})).toString('base64url');
  return `${payload}.${createHmac('sha256',tenant.viewToken).update(payload).digest('hex')}`;
}
export function verifyViewerCookie(cookie:string,tenants:Tenant[],audience:number,now=Date.now()):Tenant|undefined{
  if(cookie.length>2000)return;
  const [payload,signature,...extra]=cookie.split('.');
  if(extra.length||!payload||!signature||!/^[a-f0-9]{64}$/.test(signature))return;
  try{const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));const tenant=tenants.find(t=>t.id===data.tenant);
    if(!tenant||data.aud!==audience||!Number.isSafeInteger(data.expires)||data.expires<=now||data.expires>now+8*3600000)return;
    const expected=createHmac('sha256',tenant.viewToken).update(payload).digest();
    return timingSafeEqual(expected,Buffer.from(signature,'hex'))?tenant:undefined;
  }catch{return;}
}
