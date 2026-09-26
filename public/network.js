(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  $('networkWindowsSettings').hidden = !/Win/i.test(navigator.platform);
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  let active = false, interval, controller, scanId = 0, localSnapshot = null;
  let received = 0, resources = 0, opaque = 0;
  const text = (id,value) => { $(id).textContent = value; };
  const formatBytes = bytes => bytes < 1024 ? bytes+' B' : bytes < 1048576 ? (bytes/1024).toFixed(1)+' KB' : (bytes/1048576).toFixed(2)+' MB';
  const quality = { 'slow-2g': '较慢', '2g': '较慢', '3g': '一般', '4g': '较快' };
  const types = { wifi:'Wi-Fi', cellular:'移动数据', ethernet:'有线网络', bluetooth:'蓝牙网络', none:'未连接', other:'其他网络' };
  function update() {
    const online = navigator.onLine;
    const type = connection?.type;
    text('networkOnline', online ? '系统报告已联网' : '系统报告已离线');
    $('networkOnline').dataset.state = online ? 'online' : 'offline';
    const localWifi = online && localSnapshot?.available && localSnapshot.connections.length;
    text('networkType', !online ? '无网络连接' : types[type] || (localWifi ? 'Wi-Fi（本机）' : '浏览器未提供'));
    text('networkQuality', !online ? '离线' : quality[connection?.effectiveType] || '暂不可读取');
    text('networkDownlink', online && Number.isFinite(connection?.downlink) ? connection.downlink+' Mbps' : '—');
    text('networkRtt', online && Number.isFinite(connection?.rtt) ? connection.rtt+' ms' : '—');
    text('networkSaveData', connection?.saveData === true ? '已开启' : connection?.saveData === false ? '未开启' : '暂不可读取');
    text('networkCellular', !online ? '设备离线' : type === 'cellular' ? '正在使用移动数据' : (type && type !== 'unknown' && type !== 'other') ? '当前未使用移动数据' : '浏览器未提供连接类型');
    text('networkTraffic', formatBytes(received));
    text('networkResources', resources+' 个资源 · '+opaque+' 个资源未计入字节数');
  }
  function account(entries) {
    entries.forEach(entry => {
      resources++;
      if (Number.isFinite(entry.transferSize) && entry.transferSize > 0) received += entry.transferSize;
      else opaque++;
    });
    if (active) update();
  }
  let observer;
  if ('PerformanceObserver' in window) {
    try { observer = new PerformanceObserver(list=>account(list.getEntries())); observer.observe({type:'resource',buffered:true}); }
    catch { account(performance.getEntriesByType('resource')); }
  } else account(performance.getEntriesByType('resource'));
  account(performance.getEntriesByType('navigation'));

  const reasons = {
    remote_device: '网页无法直接扫描此设备附近的 Wi-Fi。请在手机或电脑的系统网络设置中查看；这里不会显示服务器附近的热点。',
    unsupported_system: '此系统暂不支持网页内的 Wi-Fi 列表读取，请打开系统网络设置查看。',
    permission_required: '系统未允许读取 Wi-Fi。请在 Windows「设置 → 隐私和安全性 → 位置」中检查位置权限，再刷新。',
    no_adapter: '未检测到无线网卡。请确认设备支持 Wi-Fi，并已开启无线网络。',
    service_unavailable: 'Windows 无线网络服务未启动。请先在系统设置中开启 Wi-Fi。',
    timeout: '读取超时，请稍后刷新。',
    scan_failed: '暂时无法读取 Wi-Fi 列表。请检查系统 Wi-Fi 是否开启后重试。'
  };
  function item(tag, className, value) {
    const el = document.createElement(tag); el.className=className;
    if (value !== undefined) el.textContent=value;
    return el;
  }
  function renderWifi(data) {
    const list=$('networkWifiList');list.replaceChildren();
    $('networkWifiEmpty').hidden=false;
    if (!data.available) {
      text('networkWifiCount','系统查看');
      text('networkWifiEmpty',reasons[data.reason] || reasons.scan_failed);
      text('networkScanTime','');return;
    }
    text('networkWifiCount',data.networks.length+' 个网络');
    text('networkScanTime','本机 Windows 可见网络 · '+new Date(data.scannedAt).toLocaleTimeString('zh-CN',{hour12:false})+' 更新');
    text('networkWifiEmpty','暂无可见 Wi-Fi，请确认已打开 Wi-Fi 并靠近路由器。');
    $('networkWifiEmpty').hidden=data.networks.length>0;
    data.networks.forEach(n=>{
      const row=item('li','network-wifi-row');
      const copy=item('div','network-wifi-copy');
      const heading=item('div','network-wifi-name');
      heading.append(item('strong','',n.hidden?'隐藏网络':n.ssid));
      if(n.connected)heading.append(item('span','network-connected','本机已连接'));
      copy.append(heading,item('p','network-muted',[n.authentication,n.band,n.channel!==null?'信道 '+n.channel:''].filter(Boolean).join(' · ')));
      const signal=item('div','network-signal');
      const bars=item('span','network-bars');bars.setAttribute('aria-hidden','true');
      for(let i=0;i<4;i++){const bar=item('i','');bar.dataset.lit=String(n.signal!==null && n.signal>i*25);bars.append(bar);}
      signal.append(bars,item('span','',n.signal===null?'未知':n.signal+'%'));
      signal.setAttribute('aria-label','信号强度 '+(n.signal===null?'未知':n.signal+'%'));
      row.append(copy,signal);list.append(row);
    });
  }
  async function refresh() {
    controller?.abort();controller=new AbortController();const ownController=controller,id=++scanId;
    $('networkRefresh').disabled=true;$('networkRefresh').setAttribute('aria-busy','true');
    $('networkWifiList').replaceChildren();$('networkWifiEmpty').hidden=false;
    text('networkWifiEmpty','正在读取网络信息…');text('networkWifiCount','读取中');text('networkScanTime','');
    localSnapshot=null;update();
    const timer=setTimeout(()=>ownController.abort(),12000);
    try {
      // Only a loopback origin can identify the server's radios as this device.
      if (!['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
        renderWifi({available:false,reason:'remote_device'});return;
      }
      const response=await fetch('/api/network/wifi',{cache:'no-store',signal:ownController.signal});
      if(!response.ok)throw Error('Network status unavailable');
      const data=await response.json();if(id!==scanId)return;
      if(data.available && (!Array.isArray(data.networks)||!Array.isArray(data.connections)))throw Error('Invalid network response');
      localSnapshot=data;renderWifi(data);update();
    } catch(error) {
      if(id===scanId && active)renderWifi({available:false,reason:error.name==='AbortError'?'timeout':'scan_failed'});
    } finally {
      clearTimeout(timer);
      if(id===scanId){$('networkRefresh').disabled=false;$('networkRefresh').removeAttribute('aria-busy');}
    }
  }
  function changed() {
    localSnapshot=null;
    if(active){update();refresh();}
  }
  window.NetworkPage={
    open(){active=true;clearInterval(interval);update();refresh();interval=setInterval(update,2000);},
    leave(){active=false;clearInterval(interval);scanId++;controller?.abort();$('networkRefresh').disabled=false;$('networkRefresh').removeAttribute('aria-busy');},
    refresh
  };
  $('networkRefresh').addEventListener('click',refresh);
  $('networkResetTraffic').addEventListener('click',()=>{observer?.takeRecords();received=0;resources=0;opaque=0;update();text('networkTrafficSince','从 '+new Date().toLocaleTimeString('zh-CN',{hour12:false})+' 起统计');});
  window.addEventListener('online',changed);window.addEventListener('offline',changed);
  connection?.addEventListener?.('change',changed);
})();
