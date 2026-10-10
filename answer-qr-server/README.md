# Answer QR 共享库服务

给桌面、网页与 Android 答疑插件提供同一个 ArchiveV1 JSON。`/library.json` 接口只读，图片作为 Base64 数据包含在库文件中。初始文件 `initial-library.json` 是空库，没有内置 QR。

**默认部署按 Discord 身份组控制读取**：用户用 Discord OAuth 登录后，服务端查询他在指定服务器里的身份组，只有拥有答疑身份组的成员才能下载云端库和投稿；其他人只能使用插件的本地 QR。登录、投稿、审核与身份组配置见 [CONTRIBUTIONS.md](CONTRIBUTIONS.md)。所有权限都在服务端判断，修改插件代码无法绕过。

需要 Python 3.10 或以上，无第三方 Python 依赖。部署目标是 Linux/systemd，服务固定监听 `127.0.0.1:8765`，由已有的 HTTPS Nginx/Caddy 转发，例如对外地址 `https://YOUR_DOMAIN/answer-qr/library.json`。本仓库不含任何密钥、真实读密钥或 Discord token。不要用 `python -m http.server` 暴露整个目录。[Python 官方说明](https://docs.python.org/3/library/http.server.html)指出标准库 HTTP 服务只做基础安全检查，因此这里固定少量接口并放在反向代理后，不能直接开放 8765 到公网。

## 接口与鉴权

| 请求 | 结果 |
| --- | --- |
| `GET /library.json` | 经校验的原始 ArchiveV1 JSON；默认需要 `Authorization: Bearer <登录会话>` 且该账号拥有答疑身份组 |
| `GET /readyz` | 本机健康检查；库可读且有效时返回 `{"ready":true}`，不返回 QR 内容 |
| `OPTIONS /library.json` | 浏览器预检；允许 `GET` 和 `Authorization, Accept` 请求头 |
| 其他路径 | `404`；不解析目录、查询参数、文件名或重定向 |
| POST/PUT/PATCH/DELETE 等 | `405`；不会改动库 |

所有响应带 `Cache-Control: private, no-store`。有效库损坏或消失后响应 `503`，不会发送损坏内容。文件变动后自动重新读取，无需重启。`/readyz` 不需要公开代理，直接从 VPS 本机检查即可。

`/library.json` 有三种访问模式，启动时必须明确其一，配置矛盾时服务拒绝启动：

1. **Discord 身份组（默认，`deploy/answer-qr.service`）**：只传 `--contributions-config`，并在配置中填写 `guildId`、`libraryRoleIds` 和 OAuth 凭据。未登录返回 401，没有身份组返回 403，超过每小时下载次数返回 429。每次下载都记录用户 ID 与时间，保留 30 天，便于追查泄露。
2. **静态读密钥**：`--token-file /etc/answer-qr/read-token` 或环境变量 `QR_READ_TOKEN`，二选一。文件权限须为 `0600` 或更严格，密钥为 32–512 个非空白 ASCII 字符，使用 `hmac.compare_digest` 比较。适合不需要 Discord 登录的私有部署。
3. **公开读取**：显式加 `--public`。**任何人都能下载整库，包括全部文字和图片**，CORS、Host 和客户端名称都不是身份认证。配置了身份组鉴权时不能同时使用 `--public`。

服务不读取 Cookie 作为凭据，也不读取或使用 Discord 账号 token。

CORS 只允许以下完整 Origin，未知 Origin 返回 `403` 且不反射：

- `https://discord.com`
- `https://canary.discord.com`
- `https://ptb.discord.com`

没有 Origin 的桌面/原生客户端同样必须通过上面的鉴权。浏览器插件应使用 `credentials: "omit"`，不附带 Cookie；凭据只放在 `Authorization` 请求头。

## 数据校验和限制

顶层只允许 `{"version":1,"entries":[...]}`，字段与现有插件导出格式一致。库保持原始内容，不添加默认 QR。服务和本地更新脚本都执行相同校验：

- 文件为有效 UTF-8 JSON，原始字节数严格小于 **32 MiB**；预读有上限，不先读无限文件再计算大小。
- 最多 300 条 QR，每条最多 10 张图，单图最多 10 MiB，图库合计最多 16 MiB，采用 Android 与桌面的共同上限。
- 名称最多 120、回复文字最多 4000；两类关键词分别最多 100 项、每项最多 120。文字计数与 JavaScript UTF-16 字符计数一致。
- 紧凑 JSON 的文字和元数据合计最多 2 Mi 个 UTF-16 单元；统计包含所有 QR 与标签，图片 `dataUrl` 留空。服务保守按原始词项计数，插件导入时会去重或去空白的部分也计算在内。
- 图片仅允许内嵌 PNG/JPEG/GIF/WebP，校验规范 Base64、padding、类型签名与大小；不接受远程图片地址或 SVG。
- 拒绝未知字段、重复 JSON 字段、重复 QR/同条图片 ID、非法布尔/时间戳、含登录信息的来源地址。

图片签名校验不是完整的图像解码；图片仍由各客户端解码显示。管理员从插件导出后发布，或通过贡献扩展审核发布。HTTP 服务不会把 QR 文本当作代码或 SQL 执行，最多 8 个请求线程，每个连接读写超时 10 秒，超出并发返回 `503`。错误响应与服务请求日志不打印密钥、URL 参数、图库内容或异常堆栈。TLS、外部连接限流和平台更新仍由现有反向代理/系统承担。

## 首次部署模板（仅供另一台服务器参考）

下面是 Debian/systemd 模板。先确认现有站点、端口和目录，**只新增 answer-qr 服务及一个 Nginx location**，不替换现有站点、不停其他服务。命令假设本目录已由管理员上传到 `/tmp/answer-qr-server`；如果目录已存在，复用专用账号和已有有效库，不重新初始化。

```sh
# 只在账号不存在时创建；这不是 root 运行的服务。
id answerqr >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/answer-qr --shell /usr/sbin/nologin answerqr
sudo install -d -m 0755 /opt/answer-qr/releases
sudo install -d -m 0700 -o answerqr -g answerqr /var/lib/answer-qr

# 每个版本放独立目录，保留旧版本。RELEASE 由管理员选择唯一名称。
RELEASE=2026-10-09-01
sudo install -d -m 0755 "/opt/answer-qr/releases/$RELEASE"
sudo cp -a /tmp/answer-qr-server/. "/opt/answer-qr/releases/$RELEASE/"
sudo chown -R root:root "/opt/answer-qr/releases/$RELEASE"
sudo chmod -R go-w "/opt/answer-qr/releases/$RELEASE"
cd "/opt/answer-qr/releases/$RELEASE"
python3 -B -m unittest discover -s tests -v

# 初始化拒绝覆盖已有文件；有库时跳过这一条。
sudo -u answerqr python3 -B update_library.py initial-library.json --destination /var/lib/answer-qr/library.json --initial-only
sudo chown answerqr:answerqr /var/lib/answer-qr/library.json
sudo chmod 0600 /var/lib/answer-qr/library.json

# 模板默认按 Discord 身份组鉴权：先按 CONTRIBUTIONS.md 准备 /etc/answer-qr/contributions.json，
# 再启动服务；未配置鉴权时服务会拒绝启动，不会意外公开。

sudo ln -s "/opt/answer-qr/releases/$RELEASE" /opt/answer-qr/current.new
sudo mv -Tf /opt/answer-qr/current.new /opt/answer-qr/current
sudo install -m 0644 deploy/answer-qr.service /etc/systemd/system/answer-qr.service
sudo systemctl daemon-reload
sudo systemctl enable --now answer-qr.service
curl --fail http://127.0.0.1:8765/readyz
```

账号 `answerqr` 读取服务代码与库，并写入数据目录中的 SQLite（会话、身份组缓存、下载审计、投稿队列）。systemd 模板将其余文件系统设为只读，只开放 `ReadWritePaths=/var/lib/answer-qr`；整库更新和会话撤销也统一以 `sudo -u answerqr` 执行。OAuth/Bot 配置工具须由 root 管理配置文件，token 只通过隐藏输入录入。

把 `deploy/nginx-location.conf` 的**单个 location** 放进现有 HTTPS `server` 内，或者通过该 `server` 内的独立 `include` 引用。不要新建同域名冲突 server，也不要覆盖证书配置。CORS 与认证由 Python 处理，不要在该 location 再加 `Access-Control-Allow-Origin: *`。修改前备份站点配置，并确认改的是实际生效的 HTTPS server。

```sh
# 管理员完成单独 location/include 后：
sudo nginx -t
# 仅在上一步成功时执行；不需要停止现有站点。
sudo systemctl reload nginx
```

对外地址返回 JSON，不要从 HTTP 地址跳转到 HTTPS，也不要把任何凭据放进 URL 查询参数。已有 Caddy 站点可做等价的精确路径反向代理到 `127.0.0.1:8765/library.json`；使用现有 TLS，不在本目录创建第二套证书服务。[Nginx 官方 proxy_pass 文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)说明了带 URI 的反向代理替换行为。

如果需要按 IP 限制请求速率，可在确认无命名冲突后额外添加以下可选配置。共享 NAT 下多个答疑员会共享配额，按实际用量调整；不要放进现有全站 location。

```nginx
# 在 http {} 内单独声明一次：
limit_req_zone $binary_remote_addr zone=answer_qr_reads:1m rate=2r/s;

# 只在 /answer-qr/library.json 的那个 location 内添加：
limit_req zone=answer_qr_reads burst=5 nodelay;
limit_req_status 429;
```

## 更新共享库

1. 在桌面或手机插件里管理自己的 QR，并点“导出备份”。服务器初始库为空，**不会自动收集或上传本地 QR**。
2. 管理员把准备发布的导出 JSON，通过自己使用的 SCP/SFTP 上传到 VPS 暂存目录。读取接口没有上传能力；上传使用已有管理通道的权限。
3. 在当前 VPS 的 SSH 终端以服务账号运行下面的更新脚本。脚本保留库文件原来的属主。不要直接覆盖正在服务的 `library.json`。

```sh
# 假设管理员上传到了 /tmp/answer-qr-upload.json；先核对文件来源。
chmod 600 /tmp/answer-qr-upload.json
sudo chown answerqr:answerqr /tmp/answer-qr-upload.json
sudo -u answerqr python3 -B /opt/answer-qr/current/update_library.py /tmp/answer-qr-upload.json --destination /var/lib/answer-qr/library.json
curl --fail http://127.0.0.1:8765/readyz
```

脚本先校验新文件，通过后取得更新锁，把旧文件备份到 `/var/lib/answer-qr/backups/`，再在目标文件同一目录创建临时文件、同步内容并原子替换。锁文件以 `O_NOFOLLOW` 打开，备份目录以 `lstat` 检查；符号链接或非普通目录会被拒绝，Linux 上还固定目录描述符以防检查后的路径替换。新文件无效时不碰旧库或备份；替换失败时保留旧库和已成功写下的备份。多次更新自动保留各自备份，不自动删除历史库。更新时间文件名采用 UTC。root 直接执行时会打印改用服务账号的警告。

若已有 `backups/` 是 root 私有目录，不改变旧备份权限；给更新命令加 `--backup-dir /var/lib/answer-qr/service-backups`，让服务账号在自己的数据目录创建新的普通备份目录。恢复 root 私有历史备份时，先由管理员把选定文件复制到 `answerqr` 可读的暂存文件，再用同一更新脚本恢复。

更新后各客户端需手动刷新共享源。修改本地 QR 不会自动上传；贡献扩展只有用户主动提交后才进入审核或免审发布流程。管理员的备份与上传暂存文件由管理员决定保留策略，更新脚本不代删；贡献扩展自己的自动发布备份另有容量限制。

## 回滚和升级

数据回滚也使用同一个校验和原子更新脚本；把下例文件名替换成已检查的备份。回滚前的当前库会再生成一份备份：

```sh
sudo -u answerqr python3 -B /opt/answer-qr/current/update_library.py /var/lib/answer-qr/backups/CHOSEN_BACKUP.json --destination /var/lib/answer-qr/library.json
curl --fail http://127.0.0.1:8765/readyz
```

每次更新代码之前记下 `readlink /opt/answer-qr/current`，保留旧 release、旧 systemd unit 和将要修改的 Nginx 配置副本。新代码上传到另一个 release 目录，先运行测试，然后以 `current.new` + `mv -Tf` 切换链接并 `sudo systemctl restart answer-qr`。**不要重新初始化库**。若服务检查失败，把链接切回旧 release，再重启此服务；若修改了 unit，恢复对应旧副本后 `daemon-reload`，并核对库的访问模式（身份组 / 读密钥 / 公开）是否符合当前要求；Nginx 仅在恢复所改片段且 `nginx -t` 成功后 reload。代码升级/回滚不改 `/var/lib/answer-qr/library.json`。

数据替换依赖同一文件系统上的 `os.replace`，不是先删旧文件再写入；参见 [Python 原子替换说明](https://docs.python.org/3/library/os.html#os.replace)。Windows 可运行多数本地测试，但正被其他进程打开的文件可能导致替换失败；实际部署与并发读取保证面向 Linux/POSIX。

本次鉴权安全升级的配对登录、旧会话撤销、SQLite 一致性备份、仅针对本项目的 Nginx 限流与部署前确认，见 [SECURITY-DEPLOYMENT.md](SECURITY-DEPLOYMENT.md)。线上验证通过前不要把安全修复推送到公开仓库。

## 测试

```sh
python3 -B -m unittest discover -s tests -v
```

覆盖健康检查、Discord 身份组鉴权（无身份组拿不到登录码、复查过期、Bot 复查撤销、下载限频与审计、矛盾配置拒绝启动）、默认鉴权/显式公开、Cookie 不作为凭据、允许/拒绝 Origin 与预检、只读方法和固定路径、大小和 schema、规范 Base64/图片签名、缓存重载及损坏关闭、日志不含秘密、并发限额恢复、无效新库不覆盖、备份与回滚、模拟替换失败、POSIX 并发读者只见完整快照。测试只用临时目录和本机临时端口，不访问外网、不含真实用户 QR。
