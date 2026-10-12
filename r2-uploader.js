import { r2WorkerUrl } from './firebase-config.js';
const retries = 4;
function apiBase(){if(!/^https:\/\//.test(r2WorkerUrl)||r2WorkerUrl.includes('SET-YOUR'))throw new Error('Cloudflare R2 Worker URL is not configured in firebase-config.js.');return r2WorkerUrl.replace(/\/$/,'');}
function sessionKey(file){return `yj-r2:${file.name}:${file.size}:${file.lastModified}`;}
function getSession(file){try{return JSON.parse(localStorage.getItem(sessionKey(file))||'null')}catch{return null}}
export function getResumeProjectId(file){return file?getSession(file)?.projectId||'':'';}
export function forgetR2Session(file){if(file)localStorage.removeItem(sessionKey(file));}
function saveSession(file,session){localStorage.setItem(sessionKey(file),JSON.stringify(session))}
async function request(path,token,{method='GET',body,signal}={}){
 const response=await fetch(`${apiBase()}${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal});
 let data={};try{data=await response.json()}catch{}
 if(!response.ok)throw new Error(data.error||`R2 Worker request failed (${response.status}).`);return data;
}
function sendPart(path,token,blob,onProgress,signal){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('PUT',`${apiBase()}${path}`);xhr.setRequestHeader('Authorization',`Bearer ${token}`);xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(e.loaded,e.total)};xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText)}catch{};if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error||`Chunk upload failed (${xhr.status}).`));};xhr.onerror=()=>reject(new Error('Network interruption while uploading a chunk.'));xhr.onabort=()=>reject(new DOMException('Upload canceled.','AbortError'));signal.addEventListener('abort',()=>xhr.abort(),{once:true});xhr.send(blob);});}
export async function uploadR2({file,kind,projectId,prefix='media',auth,onProgress,onTask}){
 const token=await auth.currentUser.getIdToken(); const controller=new AbortController();let session=getSession(file);onTask?.({cancel:()=>controller.abort()});
 if(!session)session={clientId:crypto.randomUUID(),projectId,prefix,name:file.name,size:file.size,lastModified:file.lastModified,contentType:file.type||mimeFromName(file.name,kind)};
 if(session.projectId!==projectId)throw new Error('An interrupted upload belongs to an earlier project. Resume it by reselecting the remaining files for that project, or clear this browser upload session.');
 try{
  saveSession(file,session);
 let started=await request('/api/multipart/start',token,{method:'POST',body:{clientId:session.clientId,projectId,prefix,name:file.name,size:file.size,contentType:session.contentType}});
 if(['aborted','deleted'].includes(started.state)){session.clientId=crypto.randomUUID();saveSession(file,session);started=await request('/api/multipart/start',token,{method:'POST',body:{clientId:session.clientId,projectId,prefix,name:file.name,size:file.size,contentType:session.contentType}});}
  if(started.state==='complete')return {url:started.url,key:started.key};
  const completed=new Map((started.parts||[]).map(p=>[p.part_number,p]));
  const count=Math.ceil(file.size/started.partSize);
  for(let n=1;n<=count;n++){
   if(controller.signal.aborted)throw new DOMException('Upload canceled.','AbortError');
   if(completed.has(n)){onProgress?.(Math.min(100,Math.round([...completed.values()].reduce((sum,p)=>sum+p.bytes,0)/file.size*100)));continue;}
   const start=(n-1)*started.partSize, blob=file.slice(start,Math.min(file.size,start+started.partSize));let attempt=0;
   while(true){try{await sendPart(`/api/multipart/${session.clientId}/part/${n}`,token,blob,(loaded)=>{const done=[...completed.values()].reduce((sum,p)=>sum+p.bytes,0);onProgress?.(Math.min(99,Math.round((done+loaded)/file.size*100)));},controller.signal);completed.set(n,{bytes:blob.size});break;}catch(error){if(error.name==='AbortError'||++attempt>retries)throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(8000,500*2**attempt)));}}
  }
  const result=await request(`/api/multipart/${session.clientId}`,token,{method:'POST'});onProgress?.(100);return {url:result.url,key:result.key};
 }catch(error){if(error.name==='AbortError'){request(`/api/multipart/${session.clientId}`,token,{method:'DELETE'}).catch(()=>{});localStorage.removeItem(sessionKey(file));}throw error;}
}
export async function deleteR2Objects(keys,auth){if(!keys?.length)return;const token=await auth.currentUser.getIdToken();return request('/api/objects',token,{method:'DELETE',body:{keys}});}
export async function setR2Visibility(keys,published,auth){if(!keys?.length)return;const token=await auth.currentUser.getIdToken();return request('/api/objects/visibility',token,{method:'POST',body:{keys,published}});}
function mimeFromName(name,kind){const ext=name.split('.').pop().toLowerCase();const map={mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac',mp4:'video/mp4',webm:kind==='audio'?'audio/webm':'video/webm',mov:'video/quicktime',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',avif:'image/avif'};return map[ext]||'';}
