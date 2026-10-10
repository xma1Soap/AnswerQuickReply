# 自动完成插件登录

新版客户端默认使用配对登录：打开登录面板，点击「使用 Discord 登录」，在浏览器输入**自己插件面板显示的 4 位配对码**，再授权同一 Discord 账号。返回 Discord 后通常 5 秒内完成登录。无需复制一次性登录码或配置协议处理器；桌面外部浏览器和网页新标签页使用同一流程。原 OAuth Redirect URL、应用凭据及身份组配置不变。

只从本人插件打开授权页，不要使用他人转发的登录链接，也不要输入他人告诉你的配对码。浏览器页面不会显示配对码或候选答案；如果没有在自己的插件点击登录，应关闭页面。配对码猜错一次就立即作废，需要回插件重新开始。登录只读取公开账号身份与配置服务器的身份组，不读取 Discord 客户端 token。

## 协议

Discord 一侧仍使用 authorization code grant 与 state/cookie 校验；以下是本服务新增的客户端结果领取协议，不是 Discord 的 device-code API。

1. 插件在内存生成 256 位随机校验凭据，仅将其 SHA-256 摘要、当前 Discord 用户 ID 和必填 `pairing: 1` 发送给 `POST /auth/auto/start`。返回随机请求 ID、固定服务域名下的登录链接、`pairCode`（`0000`–`9999`，保留前导零）、10 分钟有效期和 5 秒查询间隔。插件醒目显示配对码。省略配对协议的旧客户端返回 400 `client_outdated`。
2. 浏览器打开 `GET /auth/auto/login/<id>`，先收到一个确认页和这次登录专用的 HttpOnly/Secure/SameSite=Lax Cookie。页面隐藏表单 nonce，服务端只保存 nonce/Cookie 的哈希；页面不包含配对码。CSP 的 `form-action 'self'` 只允许提交回本站。确认页使用 `Referrer-Policy: same-origin`，让 Chromium 的本站表单 POST 携带正确 Origin，同时不向外站发送 Referer；中间页和回调继续使用 `no-referrer`。
3. 浏览器以表单 POST `/auth/auto/login/<id>/confirm`，提交 `nonce` 与 `code`。Cookie、nonce、登录尝试和配对码必须同时匹配，才显示「继续 Discord 授权」链接；点击后进入 Discord。确认成功使用 200 中间页和普通链接，避免 Chromium 将表单的跨域 302 当作违反 `form-action 'self'` 而拦截，同时不放宽 CSP。错误输入一次即标记失败，并发确认只能成功一次，nonce 无法重放。确认页和确认接口都不接受查询参数中的 `code` 或 `nonce`。攻击者从自己浏览器拿到的表单不能在没有对应 Cookie 的另一个浏览器提交成功。
4. Discord 回调校验 state/cookie、真实身份及答疑身份组，并确认授权用户与发起插件的用户一致。成功仅记录结果，浏览器不显示配对码、登录码或会话凭据。
5. 插件以 `Authorization: LoginVerifier <随机凭据>` 和 JSON `{id}` 调用 `POST /auth/auto/poll`。仅正确的校验凭据可以领取结果；服务端在同一事务中创建会话并消费请求，不能重复领取。取消、输错配对码或账号不符会明确报错。
6. 客户端存储独立服务会话并刷新云端库。取消登录、关闭所有登录面板或停用插件会停止等待；`POST /auth/auto/cancel` 使用相同凭据取消服务端请求。关闭／停用后的晚到结果不会重新建立登录。

临时校验凭据和配对码不写入本地持久存储、URL 或日志。会话只保存在插件本机，服务器只保存会话摘要。准备请求与 OAuth state 各最多保留 5000 个；容量满时拒绝新尝试，不挤掉其他人的未完成登录。每个请求最多每 5 秒领取一次。客户端不并发轮询，网络失败最多重试两次，并延长间隔。

`GET /contributions/status` 返回 `automaticLogin: true, pairing: true`；客户端必须同时确认配对支持才能走自动流程。旧客户端仍可使用原 `/auth/login` 与 `/auth/exchange`；新版面板将手动登录收在「使用一次性登录码（兼容旧版）」内。尚未支持配对协议的 Kettu 移植应仅使用一次性登录码，不能用旧自动登录协议。

## 反向代理更新

除了已有 `/auth/` 代理，还需应用 `deploy/nginx-contributions.conf` 中登录入口和轮询的精确 location，安装 `deploy/nginx-auth-entry-proxy.conf`、`deploy/nginx-poll-proxy.conf`。在 Nginx `http {}` 内声明独立 zone（已有定义不得重复）：

```nginx
limit_req_zone $binary_remote_addr zone=answer_qr_poll:1m rate=5r/s;
limit_req_zone $binary_remote_addr zone=answer_qr_login:1m rate=3r/m;
```

查询结果使用独立额度；仅 `/auth/auto/start` 与 `/auth/login` 共用每 IP 每分钟 3 次、突发 5 次的登录入口额度。其他投稿/授权请求现有限流不变。插件 API 保留 `Authorization` 与 `Content-Type`，省略 Cookie；浏览器配对/授权流程使用对应 Cookie。关闭缓存和 access log。不改变其他站点的代理或限流。

可先在 Linux 用 `python3 -B deploy/validate_nginx.py` 隔离检查模板，使用临时配置，不加载已安装站点或启动服务。正式配置仍须 `nginx -t`。服务升级前使用 SQLite backup 功能备份数据库，并保留代码链接、库、配置和所改 Nginx 文件；见 [发布手册](SECURITY-DEPLOYMENT.md)。正式部署前须获得用户确认，告知旧自动登录需更新、撤销旧会话会要求所有人重新登录。库、OAuth／名单和身份组配置无需更改。

## 测试

服务端测试覆盖正常配对领取、输错即作废、nonce 重放、跨浏览器 Cookie、缺少配对协议、页面不泄露配对码、并发确认，以及错误领取凭据、账号不同、无身份组、拒绝授权、取消／过期回调、容量与 CORS。两份威胁测试断言转发登录链接无法直接取得会话。

客户端：在仓库根目录运行 `node tests/automatic-login.cjs /path/to/Vencord`，使用该 Vencord checkout 已安装的 esbuild。测试使用真实插件模块和模拟 HTTP／存储／时钟，不访问 Discord 账号。真实 OAuth 成功授权仍需用户在自己的浏览器完成。
