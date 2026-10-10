# 自动完成插件登录

新版客户端默认使用自动登录：打开登录面板，点击「使用 Discord 登录」，在浏览器授权同一 Discord 账号，返回 Discord 后通常 5 秒内完成登录。无需复制授权码或配置协议处理器；桌面外部浏览器和网页新标签页使用同一流程。原 OAuth Redirect URL、应用凭据及身份组配置不变。

只从本人插件打开授权页，不要使用他人转发的登录链接。登录只读取公开账号身份与配置服务器的身份组，不读取 Discord 客户端 token。

## 协议

Discord 一侧仍使用 authorization code grant 与 state/cookie 校验；以下是本服务新增的客户端结果领取协议，不是 Discord 的 device-code API。

1. 插件在内存生成 256 位随机校验凭据，仅将其 SHA-256 摘要和当前 Discord 用户 ID 发送给 `POST /auth/auto/start`。返回随机请求 ID、固定服务域名下的登录链接、10 分钟有效期和 5 秒查询间隔。
2. 浏览器打开 `/auth/auto/login/<id>`，建立独立 state 和 HttpOnly/Secure Cookie，随后进入原有 Discord 授权流程。
3. 回调校验 state/cookie、真实 Discord 身份及答疑身份组，并确认授权用户与发起插件的用户一致。成功仅记录结果，浏览器不显示登录码或会话凭据。
4. 插件以 `Authorization: LoginVerifier <随机凭据>` 和 JSON `{id}` 调用 `POST /auth/auto/poll`。仅正确的校验凭据可以领取结果；服务端在同一事务中创建会话并消费请求，不能重复领取。
5. 客户端存储独立服务会话并刷新云端库。取消登录、关闭所有登录面板或停用插件会停止等待；`POST /auth/auto/cancel` 使用相同凭据取消服务端请求。超时或浏览器账号不符会明确报错。

临时校验凭据不写入本地存储、URL 或日志；服务端只保存其摘要。会话仍只保存在插件本机，服务器只保存会话摘要。准备请求最多保留 1000 个；每个请求最多每 5 秒领取一次。客户端不并发轮询，网络失败最多重试两次，并延长间隔。关闭／停用后的晚到结果不会重新建立登录。

`GET /contributions/status` 新增 `automaticLogin: true`。旧客户端仍可使用原 `/auth/login` 与 `/auth/exchange`；新版面板将手动登录收在「使用一次性登录码（兼容旧版）」内。

## 反向代理更新

除了已有 `/auth/` 代理，还需应用 `deploy/nginx-contributions.conf` 中 `/answer-qr/auth/auto/poll` 的精确 location，安装 `deploy/nginx-poll-proxy.conf`。在 Nginx `http {}` 内新增独立 zone：

```nginx
limit_req_zone $binary_remote_addr zone=answer_qr_poll:1m rate=5r/s;
```

查询结果需要独立限流额度，否则会消耗登录／投稿端点的额度。客户端保留 `Authorization` 与 `Content-Type`，省略 Cookie；该路径关闭缓存和 access log。不改变其他站点的代理或限流。

服务升级前备份当前代码链接、数据库和将修改的 Nginx 文件。先运行测试，`nginx -t` 成功后再 reload；失败时恢复旧链接和本次改动的 Nginx 文件。库与 OAuth／身份组配置无需更改。

## 测试

服务端测试新增覆盖正常领取、错误凭据、浏览器账号不同、无身份组、拒绝授权、取消／过期后回调、并发领取、回调重放、容量与 CORS。

客户端：在仓库根目录运行 `node tests/automatic-login.cjs /path/to/Vencord`，使用该 Vencord checkout 已安装的 esbuild。测试使用真实插件模块和模拟 HTTP／存储／时钟，不访问 Discord 账号。真实 OAuth 成功授权仍需用户在自己的浏览器完成。
