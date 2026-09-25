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

- 页面加载和点击“定位”时，优先请求浏览器的新位置；浏览器不支持、拒绝或超时后，改由浏览器直接请求 ipwho.is 获取访问者的大致网络位置。
- IP 定位请求必须保留在客户端，避免把部署服务器的公网 IP 当成访问者位置。IP 来源单独标注，县/区显示“未确定”。
- Nominatim 将坐标转换为“国-省-市-县（区）”。地址解析失败不影响使用已获得的坐标查询天气，界面显示“定位成功，地址解析暂不可用”；仅浏览器与网络 API 都没有获取到坐标时显示“定位失败，请重新定位”；IP 定位可使用其自身返回的国家、省、市信息。
- Open-Meteo 提供当前天气、小时天气及七天预报；页面显示数据时间、获取时间，并按位置自动选择时区。
- 页面可见时，每 5 分钟重新定位和更新天气；隐藏时暂停自动请求，重新进入页面且数据已过期时立即刷新。
- 两种定位都失败时，不查询默认城市天气，也不继续把旧位置天气显示为当前位置。
- 外部 API 的网络可达性及公共服务额度影响可用性。定位、地址和天气请求均设置超时；网络定位失败时可再次点击“定位”。
- 浏览器真实定位仍取决于访问设备的定位能力及站点授权。发布后应在实际访问环境中验证定位和三个外部 API 的连通性。
