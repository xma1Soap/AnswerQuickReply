# Discord 登录、身份组鉴权、投稿和审核

默认部署中，`/library.json` 和投稿都只对**指定 Discord 服务器里拥有答疑身份组的成员**开放。用户通过 Discord OAuth2 登录，身份和身份组都由服务端向 Discord 查询，不能通过填写 Discord ID 或修改插件获得权限。**OAuth 凭据或身份组未配置时，服务拒绝以身份组模式启动；登录、提交和审核接口返回 503。**

## 管理员首次配置 Discord 应用

1. 用管理员自己的账号打开 [Discord Developer Portal](https://discord.com/developers/applications)，创建一个应用。
2. 在应用的 OAuth2 设置中添加且保存完整 Redirect URL：`<publicBaseUrl>/auth/callback`，例如 `https://YOUR_DOMAIN/answer-qr/auth/callback`。
3. 取得该应用的 Application ID 和 OAuth2 Client Secret。在 VPS 的 **root 终端**运行：

   ```sh
   python3 -B /opt/answer-qr/current/configure_oauth.py
   ```

4. 按提示输入应用 ID；Client Secret 使用隐藏输入，不会出现在命令参数、shell 历史或脚本输出里。配置工具保留已有地址、数据库路径和角色列表，同目录原子替换配置并保留属主，文件权限为 `0640`。成功后运行：

   ```sh
   systemctl restart answer-qr
   curl --fail http://127.0.0.1:8765/contributions/status
   ```

5. 状态变为 `enabled: true` 只表示凭据已经填写、服务可启动。仍需从插件真实登录一次，确认应用 Secret、Redirect URL 和 Discord 网络访问都正确。真实 OAuth 流程未在没有应用凭据时冒充测试成功。

Client Secret 只输入服务器，不发送给聊天助手或放进插件。官方流程使用 [authorization code grant 和 state](https://docs.discord.com/developers/topics/oauth2)。启用身份组鉴权时申请 `identify guilds.members.read` 两个 scope：通过 `/users/@me` 获取用户 ID，通过 `/users/@me/guilds/{guildId}/member` 只读取**这一个服务器**里的身份组。不索取邮箱、完整服务器列表、bot 权限或用户客户端 token；Discord access token 用完即弃，不落盘。

## 配置答疑身份组

在 `/etc/answer-qr/contributions.json` 中填写（打开 Discord「开发者模式」后右键服务器 / 身份组即可复制 ID）：

- `guildId`：答疑服务器 ID。
- `libraryRoleIds`：答疑身份组 ID 列表，拥有其中任意一个即可读取云端库和投稿。
- `botToken`（可选，推荐）：同一应用下 Bot 的 token。Bot 以**零权限**邀请进该服务器即可，不需要特权 Intent。配置后服务每 15 分钟用它复查一次身份组（无身份组的结果 5 分钟复查），撤销身份组后最迟 15 分钟失去访问权限。不配置时，一次登录对身份组的证明有效 24 小时，之后要求重新登录。
- `libraryReadsPerHour`：每个账号每小时最多整库下载次数，默认 60。

`guildId` 和 `libraryRoleIds` 必须同时填写。含 `clientSecret` 或 `botToken` 的配置文件不得对其他用户可读，也不得组可写，否则服务拒绝启动。没有身份组的账号在 OAuth 回调页会看到说明，拿不到登录码。审核员（`reviewerIds`）不受身份组限制。

每次整库下载都会在 SQLite 的 `library_reads` 表记录用户 ID 与时间，保留 30 天。怀疑内容外泄时可查询：

```sh
sqlite3 /var/lib/answer-qr/contributions.sqlite3 "SELECT user_id, count(*), datetime(max(at)/1000,'unixepoch') FROM library_reads GROUP BY user_id ORDER BY 2 DESC;"
```

身份组只能挡住外部人员，挡不住有身份组的成员自行转存。限频和审计用于发现与追责，不能防止一次性下载。

## 用户和审核员的操作

没有身份组的使用者只能使用本地 QR。答疑成员从插件点「Discord 登录 / 投稿」，在浏览器完成 Discord 授权。回调页面显示一个随机的一次性登录码；复制回插件完成登录。登录码 5 分钟有效，使用后失效。插件获得本服务自己的随机会话，最多有效 7 天，可主动退出；不是 Discord access token。

普通账号提交的 QR 进入待审队列。审核员可查看详情，批准追加到共享库，或驳回并填写最多 500 字的原因。免审名单里的账号提交后直接追加；其身份仍必须通过同一个 OAuth 验证。服务器重建 QR ID、图片 ID 和更新时间，用户提交已有 ID 不能覆盖公共库里的旧 QR。

管理员在 root 管理的 `/etc/answer-qr/contributions.json` 中维护角色：

- `reviewerIds`：可以查看全部待审、批准或驳回。
- `autoPublishIds`：自己提交时直接发布。

两份名单填写 Discord **用户 ID**（不是身份组 ID）。改变后重启服务；已有会话的权限由当前配置重新计算。没有公开修改名单的 API。

## 部署配置

配置样例是 `deploy/contributions.example.json`，把其中 `YOUR_…` 占位符换成实际值；OAuth 两个字段用上面的 `configure_oauth.py` 填写，不要手动粘贴到聊天或仓库里。配置文件属主为 `root:answerqr`、权限 `0640`，父目录应允许该服务组读取，但不允许该组改配置。

贡献服务需要把发布结果写入库，以及保存本服务会话、待审队列和审核记录。因此启用时新增 SQLite（仅标准库 `sqlite3`，动态值全部用参数绑定），并允许服务账号写**数据目录**。这与纯读取部署不同：

```sh
# root 执行，先备份旧 unit、Nginx 片段和库；不覆盖已有贡献配置。
chown answerqr:answerqr /var/lib/answer-qr
chmod 0700 /var/lib/answer-qr
chown answerqr:answerqr /var/lib/answer-qr/library.json
# 如果锁文件由旧的 root 更新脚本创建，需转交它；不是删除锁。
test ! -f /var/lib/answer-qr/library.json.lock || chown answerqr:answerqr /var/lib/answer-qr/library.json.lock
```

`deploy/answer-qr.service` 已包含 `--contributions-config /etc/answer-qr/contributions.json` 和 `ReadWritePaths=/var/lib/answer-qr`，不带 `--public`；其他系统目录继续只读。可选的 `deploy/contributions.conf` drop-in 只设 384 MiB 内存、32 任务和 128 文件句柄上限。不要把服务改成 root。

仅给本功能增加 `deploy/nginx-contributions.conf` 的三个匹配位置及其公共代理片段；原 `/answer-qr/library.json` 的只读 location 和其他站点保持。贡献请求必须保留 JSON body，不能复用原读取 location 中 `proxy_pass_request_body off` 的设置。OAuth callback 必须转发 Cookie 与 query；其 access log 关闭。申请新的独立限流 zone，模板为每 IP 每分钟 10 次、突发 10 次；同一 NAT 的使用者共用配额，按实际情况调整。应用 CORS 接受 Discord 正式/Canary/PTB、配置的 HTTPS 站点 Origin，以及没有 Origin 的原生客户端；不向浏览器开放携带跨域 Cookie。

依次运行完整测试、`systemctl daemon-reload`、仅重启 answer-qr、`nginx -t`、仅在成功后 reload Nginx。上线后应确认：未登录读取库为 401，答疑成员登录后为 200，非成员在回调页被拒绝，旧首页仍可用。

## API 协议

外部地址统一带 `/answer-qr`；下表列出 Nginx 去掉此前缀后的路径。除浏览器打开的 `/auth/login` 跳转 Discord 外，其他 API 不重定向。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /contributions/status` | `{enabled, loginUrl}`；免登录 |
| `GET /library.json` | 同一 Bearer；需要答疑身份组。401 未登录或需重新登录复查，403 无身份组，429 下载过于频繁 |
| `GET /auth/login` | 浏览器进入 Discord OAuth，随机 state 绑定 HttpOnly/Secure/SameSite=Lax cookie |
| `GET /auth/callback` | 校验 state/cookie，经服务端交换 code，读取 `/users/@me` 与本服务器身份组；有身份组才在 HTML 中显示一次性登录码，否则 403 |
| `POST /auth/exchange` | 必须单个 `Authorization: LoginCode <一次性码>`，JSON body 为 `{}`；返回 `{token,expiresAt,user:{id,username},canReview,canAutoPublish,libraryAccess}`；`libraryAccess` 为 `open`/`ok`/`denied`/`recheck` |
| `GET /contributions/me` | `Authorization: Bearer <本服务会话>`，返回上述资料但不含 token |
| `POST /auth/logout` | 同一 Bearer、body `{}`；删除会话 |
| `POST /contributions` | 同一 Bearer、需要答疑身份组、body `{entry,requestId:UUID}`；返回 `{id,status:"pending"或"published"}` |
| `GET /contributions/mine` | 返回自己最近 100 条摘要 `{submissions:[...]}` |
| `GET /contributions/pending` | 审核员读取最多 100 条待审摘要 |
| `GET /contributions/<uuid>` | 作者或审核员读取 `{submission:{id,title,status,createdAt,updatedAt,reason?,submitterId,entry}}` |
| `POST /contributions/<uuid>/review` | 审核员、body `{decision:"approve"或"reject",reason?:string}`，返回 `{id,status}` |

摘要包含 `id,title,status,createdAt,updatedAt,submitterId`，驳回时可带 `reason`。所有时间都是毫秒。错误格式为 `{error:固定代码,message:安全中文}`。已清理的驳回详情、或管理员手动整库替换后不存在的已发布详情返回 **410 `submission_archived`**，摘要仍在。发布正在恢复时列表暂以 `pending` 显示并带恢复提示，不能驳回；稍后重试原 requestId 或批准动作。

客户端须固定 HTTPS 目标、拒绝意外重定向、不给请求附带 Discord token 或 Cookie。一次性码仅在 Authorization 中发送，**不支持 body.code**。同一 UUID 重试相同内容幂等；同一账号以相同 UUID 改成不同内容返回 409。网络报错后应保留 requestId 重试，不能换一个 UUID 盲目重发。

## 发布、恢复和容量

发布先在 SQLite 提交 `publishing` 意图，随后取得与 root 更新脚本相同的库文件锁，在原库上追加并原子替换，最后标记 `published`。每个提交的公共 entry ID 由服务端生成并持久化。重启恢复遇到已写入且完全相同的 entry ID 时只补记完成；尚未写入时追加一次，不用客户端 ID 覆盖旧内容。`publishing` 或 `published` 状态都不能驳回。

如果发布前库已满，保持待审并返回上限错误。如果发布意图已经存在但文件权限、磁盘或库冲突导致恢复失败，会保留意图供修复后重试；不会把不确定的发布误记成驳回。管理员不要在服务运行时直接修改 SQLite 或绕开锁覆盖 JSON。手动整库导入、回滚继续使用 `update_library.py`，操作前应核对正在发布的记录；整库替换本来就会替换当前共享库全部条目。

容量是固定且有界的：

- 待审全站最多 100 条、每人最多 10 条；所有保留的提交图片/文字 payload 合计最多 64 MiB。
- 最多 5000 条摘要/幂等记录；满额拒绝新提交，需要管理员后续安排归档维护，不会无限累积。
- 已发布 payload 从队列清除，详情复用共享库；驳回 payload 保存 7 天后按请求/启动清理，原因与幂等摘要保留。
- SQLite 文件上限 128 MiB，WAL 按写入检查点回收，日志保留目标 8 MiB；大事务期间 WAL 可暂时大于这个保留目标。不会将 Discord access/refresh token 落盘；会话、登录码和 state 只存 SHA-256 哈希。
- 单账号最多 20 个会话、全站最多 2000 会话；待完成 OAuth state 和登录码各最多 1000 个，过期后清理。
- 自动发布备份独立写入 `publish-backups/`，最多最近 10 份、合计不超过 256 MiB，并至少保留最新一份。**不清理或接管原来的管理员 `backups/`。**
- 图库本身继续遵守 300 QR、图片合计 16 MiB、JSON 小于 32 MiB 的共同上限；大提交/详情一次只处理一份，避免多份图片并发占满内存。

旧的 root 手动备份目录可以继续保持 root 私有。备份数据目录时包含 `library.json`、贡献 SQLite 与自动发布备份；备份 SQLite 应使用其在线 backup 功能，或先仅停止 answer-qr 再复制数据库文件，避免漏掉 WAL 中尚未检查点的数据。

## 验证范围

本机模拟了 Discord identity provider，测试了身份组鉴权（scope 校验、无身份组拒发登录码、24 小时复查、Bot 复查撤销、限频与审计）、state/cookie、一次性码、过期/退出、权限隔离、幂等与服务器生成 ID、免审发布、拒绝/批准、并发批准、图片和配额限制、自动备份，以及原子替换前后两种崩溃恢复。这些测试没有创建 Discord 应用、没有使用真实用户 Discord token，也不能替代配置完成后的真实 OAuth 验证。

真实 OAuth、身份组读取和投稿流程需要在配置好 Discord 应用后实测。

运行：`python3 -B -m unittest discover -s tests -v`。Windows 会跳过一项 POSIX 并发文件替换测试；正式 Debian 部署需执行全部测试。
