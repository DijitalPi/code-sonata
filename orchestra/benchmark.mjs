// Local, explicitly simulated capacity observation; never a real user count.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
const machines = Number(process.argv[2] || 120), seconds = Number(process.argv[3] || 45), listeners = Number(process.argv[4] || 120);
const port = 4494, url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['orchestra/server.mjs'], { env: { ...process.env, PORT: String(port), TRUST_PROXY: '1', ALLOW_SIMULATION: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { server.stdout.on('data', b => { if (String(b).includes('Agent Orchestra')) resolve(); }); server.once('error',reject); server.once('exit', c => reject(new Error(`server ${c}`))); });
const abort = new AbortController(), start = performance.now();
let bytes = 0, frames = 0, largest = 0, maximumGap = 0, previous = 0, peakMachines = 0, peakListeners = 0, simulated = 0;
const response = await fetch(url + '/api/stream', { signal: abort.signal });
const reader = response.body.getReader(); let buffer = '';
const collect = (async () => {
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; buffer += new TextDecoder().decode(chunk.value);
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0,index); buffer=buffer.slice(index+2);
        if (!line.startsWith('data: ')) continue;
        const frame = JSON.parse(line.slice(6)), now=performance.now(); frames++; largest=Math.max(largest,line.length);
        if(previous) maximumGap=Math.max(maximumGap,now-previous); previous=now;
        if(frame.players !== undefined) {peakMachines=Math.max(peakMachines,frame.players);peakListeners=Math.max(peakListeners,frame.listeners);simulated=Math.max(simulated,frame.simulated||0);}
      }
    }
  } catch (error) { if (!abort.signal.aborted) throw error; }
})();
const crowd = spawn(process.execPath, ['orchestra/crowd.mjs',String(machines),String(seconds),url,String(listeners)], { stdio: 'ignore' });
const latencies=[], memory=[];
const timer=setInterval(async()=>{
  const t=performance.now();
  try { const res=await fetch(url+'/api/health',{signal:AbortSignal.timeout(2000)}); await res.json(); latencies.push(performance.now()-t); memory.push(Number(execFileSync('ps',['-p',String(server.pid),'-o','rss='],{encoding:'utf8'}).trim())); }
  catch { latencies.push(2000); }
},1000);
try {
  await once(crowd,'exit'); clearInterval(timer); abort.abort(); await collect;
  const elapsed=(performance.now()-start)/1000; latencies.sort((a,b)=>a-b);
  const result={ simulation:true, requestedMachines:machines, requestedListeners:listeners, seconds:+elapsed.toFixed(1), peakMachines, simulatedMachines:simulated, peakListeners, frames, bytesPerSecPerListener:Math.round(bytes/elapsed), maxFrameBytes:largest, maxFrameGapMs:Math.round(maximumGap), healthP95Ms:+(latencies[Math.floor(latencies.length*.95)]||0).toFixed(1), serverPeakRSSMiB:+(Math.max(...memory)/1024).toFixed(1) };
  const path=`orchestra/evidence/capacity-${machines}.json`; await mkdir('orchestra/evidence',{recursive:true}); await writeFile(path,JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
} finally { clearInterval(timer); abort.abort(); crowd.kill(); server.kill(); await once(server,'exit'); }
