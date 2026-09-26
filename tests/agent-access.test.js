const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('missing API key cannot trigger agent shortcuts; manual controls still work', {timeout:20000}, async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-access-'));
  const listener=net.createServer();
  await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),REPORT_DATA_FILE:path.join(directory,'events.json')}});
  t.after(async()=>{if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}fs.rmSync(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{child.stdout.on('data',data=>{if(String(data).includes('Agent Server running'))resolve();});child.once('error',reject);child.once('exit',code=>reject(Error('Server exited: '+code)));});
  const url='http://127.0.0.1:'+port;
  const post=(route,body)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  for(const config of [undefined,{}, {apiKey:''},{apiKey:'   '},{apiKey:123}]) {
    const response=await post('/api/interact',{text:'打开客厅灯',llmConfig:config});
    assert.equal(response.status,401);assert.equal((await response.json()).code,'API_KEY_REQUIRED');
  }
  const report=async()=>(await(await fetch(url+'/api/report/today')).json());
  assert.equal((await report()).counts.deviceChanges,0);
  assert.equal((await post('/api/toggle_device',{device:'light_living',state:'开启'})).status,200);
  assert.equal((await report()).counts.deviceChanges,1);
  assert.equal((await post('/api/task',{name:'手动测试任务',seconds:60})).status,200);
  assert.equal((await post('/api/task_control',{action:'pause'})).status,200);
});
