# 云端部署说明

项目包含 Node.js 和 WebSocket，GitHub Pages 不能直接运行。推荐使用 GitHub Codespaces 生成临时公网地址，或使用 Render 长期部署。

## 方式一：GitHub Codespaces 公网链接

1. 把项目上传到 GitHub 仓库。
2. 打开仓库，点击 `Code` -> `Codespaces` -> `Create codespace on main`。
3. Codespaces 会自动安装依赖并启动项目。
4. 打开底部或侧边的 `Ports` 面板。
5. 找到端口 `3000`，把 Port Visibility 设置为 `Public`。
6. 复制端口对应的 `https://...-3000.app.github.dev` 地址。

使用该地址访问时，前端会自动切换到 `wss://`，语音识别和 WebSocket 都可以使用。

注意：Codespaces 停止运行后，公网地址会失效。需要长期在线时使用 Render。

## 方式二：Render 长期部署

项目使用 Node.js + WebSocket，适合 Render Web Service。

## Render 部署步骤

1. 将项目上传到 GitHub 仓库。
2. 登录 Render，选择 `New` -> `Web Service`。
3. 连接 GitHub 仓库。
4. 填写：
   - Runtime: `Node`
   - Build Command: `npm ci`
   - Start Command: `npm start`
   - Health Check Path: `/health`
5. 部署完成后，Render 会生成类似下面的公网地址：

```text
https://home-agent-system.onrender.com
```

## 环境变量

云端部署不需要把真实 API Key 提交到代码中。项目当前允许用户在网页设置页输入自己的 API Key。

如果需要服务端统一配置密钥，请在 Render 的 Environment 页面添加对应环境变量，不要把真实密钥写入：

- `server.js`
- `public/app.js`
- `render.yaml`
- `Dockerfile`
- GitHub 仓库

## WebSocket

前端已经根据页面协议自动选择：

```javascript
location.protocol === 'https:' ? 'wss:' : 'ws:'
```

因此 Render 的 HTTPS 地址会自动使用 `wss://`，不需要额外修改。

## 免费实例说明

Render 免费实例在一段时间没有访问后可能会休眠，下次打开页面时首次加载会稍慢。需要长期在线时，应升级实例或改用其他付费云服务。

## 定位与天气更新

- 天气页面已移除地址、经纬度、定位精度、位置更新时间和定位按钮；保留天气预报与天气更新时间。
- 页面加载时自动获取浏览器的新位置；浏览器不支持、拒绝或超时后，改由浏览器直接请求 ipwho.is 获取访问者的大致网络位置。
- IP 定位请求必须保留在客户端，避免把部署服务器的公网 IP 当成访问者位置。
- 天气直接按获得的坐标查询，不再发起地址解析请求。已有后台地址接口保留，不参与天气页面加载。
- Open-Meteo 提供当前天气、小时天气及七天预报；页面显示数据时间、获取时间，并按位置自动选择时区。
- 页面可见时，每 5 分钟重新定位和更新天气；隐藏时暂停自动请求，重新进入页面且数据已过期时立即刷新。
- 两种定位都失败时，不查询默认城市天气，也不继续把旧位置天气显示为当前位置；用户可检查定位权限或刷新页面重试。
- 浏览器真实定位取决于访问设备的定位能力及站点授权；外部 API 的网络可达性与公共服务额度也影响天气可用性。
- HTML、JS、CSS 要求缓存重新验证；页面资源添加版本参数。GitHub 推送不等同于部署完成：需确认托管平台运行最新提交，再刷新页面。
