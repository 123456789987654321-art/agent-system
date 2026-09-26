const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWifiNetworks, parseConnections, createNetworkService, isLocalNetworkRequest } = require('../services/network-status');

const scan = `Interface name : Wi-Fi
There are 3 networks currently visible.
SSID 1 : 家里的 Wi-Fi:5G
 Authentication : WPA3-Personal
 BSSID 1 : 00:00:00:00:00:01
 Signal : 42%
 Band : 5 GHz
 Channel : 36
 BSSID 2 : 00:00:00:00:00:02
 Signal : 92%
 Band : 5 GHz
 Channel : 149
SSID 2 : <img src=x onerror=alert(1)>
 身份验证 : 开放式
 BSSID 1 : 00:00:00:00:00:03
 信号 : 25%
 频道 : 6
SSID 3 :
 Authentication : WPA2-Personal
 BSSID 1 : 00:00:00:00:00:04
 Signal : 60%`;
const interfaces = `Name : WLAN
 State : connected
 SSID : 家里的 Wi-Fi:5G
 AP BSSID : 00:00:00:00:00:02
 Signal : 92%
Name : WLAN 2
 State : disconnected`;

test('Wi-Fi parser preserves SSIDs and chooses the strongest radio without exposing MAC addresses', () => {
  const result = parseWifiNetworks(scan);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], {ssid:'家里的 Wi-Fi:5G',hidden:false,signal:92,authentication:'WPA3-Personal',band:'5 GHz',channel:149,accessPoints:2});
  assert.equal(result[1].hidden,true);
  assert.equal(result[2].ssid,'<img src=x onerror=alert(1)>');
  assert(!JSON.stringify(result).includes('00:00:00'));
  assert.deepEqual(parseConnections(interfaces),[{ssid:'家里的 Wi-Fi:5G',signal:92}]);
  assert.deepEqual(parseConnections('名称 : WLAN\n状态 : 已连接\nSSID : 中文网络\n信号 : 80%'),[{ssid:'中文网络',signal:80}]);
});

test('local scan caches, coalesces concurrent requests and marks the connected SSID', async () => {
  let calls=0,clock=100000;
  const read=createNetworkService({platform:'win32',now:()=>clock,runCommand:async command=>{calls++;await new Promise(r=>setTimeout(r,5));return command==='interfaces'?interfaces:scan;}});
  const [a,b]=await Promise.all([read(),read()]);
  assert.equal(calls,2);assert.deepEqual(a,b);assert.equal(a.networks[0].connected,true);
  await read();assert.equal(calls,2);
  clock+=10001;await read();assert.equal(calls,4);
});

test('unsupported, denied, missing-adapter and unknown output never appear as an empty successful scan', async () => {
  const unsupported=createNetworkService({platform:'linux',runCommand:()=>{throw Error('must not run');}});
  assert.equal((await unsupported()).reason,'unsupported_system');
  for(const [output,reason] of [['Location permission is required','permission_required'],['There is no wireless interface on the system.','no_adapter'],['WLAN AutoConfig service is not running','service_unavailable'],['Unexpected localized response','scan_failed']]) {
    const read=createNetworkService({platform:'win32',runCommand:async()=>output});
    assert.deepEqual(await read(),{available:false,reason});
  }
  const empty=createNetworkService({platform:'win32',runCommand:async()=> 'There are 0 networks currently visible.'});
  assert.deepEqual((await empty()).networks,[]);
});

test('server radios are accessible only from same-device loopback requests', () => {
  const request={socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:3000',origin:'http://localhost:3000','sec-fetch-site':'same-origin'}};
  assert.equal(isLocalNetworkRequest(request),true);
  for(const patch of [
    {socket:{remoteAddress:'192.168.1.25'}},
    {headers:{...request.headers,host:'example.com'}},
    {headers:{...request.headers,origin:'https://attacker.example'}},
    {headers:{...request.headers,'x-forwarded-for':'127.0.0.1'}},
    {headers:{...request.headers,'sec-fetch-site':'cross-site'}}
  ])assert.equal(isLocalNetworkRequest({...request,...patch}),false);
});
