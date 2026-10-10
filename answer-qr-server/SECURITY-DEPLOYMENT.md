# 鉴权安全修复的发布与回滚

这次发布只升级代码和本项目的 Nginx 片段，不改 QR 正文、ID 或库内顺序。现有 OAuth、`guildId`、`libraryRoleIds`、`reviewerIds`、`autoPublishIds`、Bot 和 `roleProofHours` 的值保持不变；新增配置省略时使用安全默认值。

## 部署前确认

完成新分支实现、Linux 全部测试和隔离 Nginx 检查后，向用户展示结果并确认正式部署。明确告知：仅 `answer-qr` 会重启；旧插件自动登录需要更新或改用一次性登录码；本次会撤销所有旧会话，**所有人都需要重新登录**。在获得确认前，不切换 release、不重启、不 reload Nginx、不撤销线上会话，不推送到公开仓库。

下面三项必须由用户决定，不与安全代码升级捆绑修改：

- 是否拆分审核员和免审账号；
- 是否具备邀请零权限 Bot 的权限、是否配置 Bot；
- 未配置 Bot 时 `roleProofHours` 设为多少（保留当前值；旧配置默认 24）。

## Linux 验证门槛

在独立 Linux 工作目录使用 Python 3.10+ 和 Node 18+ 运行测试，不连接真实 Discord；后端发现测试已包含两份改为断言安全结果的威胁测试。

```sh
cd answer-qr-server
python3 -X utf8 -B -m unittest discover -s tests -p 'test_*.py' -v
python3 -B deploy/validate_nginx.py
```

回到仓库根目录运行客户端自动登录、会话注销、修改对比、云端编辑和模型测试。`VENCORD_DIR` 指向装好依赖的 Vencord 源码（或复查环境的 `frontend` 依赖目录）：

```sh
node tests/automatic-login.cjs "$VENCORD_DIR"
node tests/contribution-security.cjs "$VENCORD_DIR"
VENCORD_DIR="$VENCORD_DIR" node answerQuickReply/tests/cloud-edit.cjs
node tests/run-model.cjs "$VENCORD_DIR"
```

这些命令编译并测试当前工作树的 `model.test.ts`，不能用冻结复查副本替代。依赖必须适配 Linux 架构。记录编译工具与全部命令，Linux 必须零失败、零跳过。`deploy/validate_nginx.py` 只在临时目录生成配置并执行 `nginx -t`，不加载现有站点或启动端口；正式配置仍要再次检查。

实际浏览器的 Cookie/CSP 回归也使用临时目录及模拟 Discord，所有外部请求都会拦截。依赖目录需要 `puppeteer-core`，`CHROME_FOR_TESTING` 指向 Linux Chrome for Testing 可执行文件；无需安装或启动系统服务：

```sh
node tests/pairing-browser.cjs "$VENCORD_DIR" python3 "$CHROME_FOR_TESTING"
```

仅此隔离 headless 测试在 root 环境使用 `--no-sandbox`，不连接真实 Discord、不读取用户浏览器资料，也不用于生产浏览器。它验证正确配对的 Cookie/授权回调和错误配对被拒绝，不能替代上线后用户本人授权。

保存测试记录和待发代码 SHA-256。不得把复查环境、私有 QR、数据库、配置、会话或 SSH 密钥提交 Git。

## 备份（确认部署后，发布前）

先核对实际 unit、数据路径和本项目所用的 Nginx include；以下默认路径须与线上一致。root 在 `/var/backups/answer-qr/` 下新建唯一 UTC 时间戳目录，权限 `0700`，备份不打印内容：

1. 保存 `readlink -f /opt/answer-qr/current` 的结果和 `current` 链接本身；把当前 release 原样复制到私有备份目录。
2. 原样复制 `/etc/answer-qr/contributions.json`，保存其属主/权限和 SHA-256。禁止 `cat`、输出 JSON、上传 Git 或把密钥作为参数。
3. 备份 SQLite 必须使用 `Connection.backup` 或 sqlite3 `.backup`；**不能直接复制正在使用的 DB/WAL**。下面示例在 root 私有备份目录中运行，来源为只读连接，写入新的备份文件：

   ```sh
   # 先 cd 到本次新建且已核对的 /var/backups/answer-qr/<UTC_TIMESTAMP>/。
   python3 -B - <<'PY'
   from contextlib import closing
   import sqlite3
   with closing(sqlite3.connect('file:/var/lib/answer-qr/contributions.sqlite3?mode=ro', uri=True)) as source:
       with closing(sqlite3.connect('contributions.sqlite3')) as backup:
           source.backup(backup)
           if backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
               raise SystemExit('Database backup integrity check failed.')
   print('Database backup verified; no rows printed.')
   PY
   ```

4. 原样复制 `library.json`，记录 SHA-256；需要完整灾备时也复制自动发布和手动备份目录。
5. 复制实际将修改的 Nginx 文件，以及 unit（即使预计不改）。只备份本次范围，不输出全站配置中的私密内容。
6. 对这些备份生成校验记录。在线 backup 和库复制之间仍可能有正常投稿；切换前核对库哈希。如果在维护期间变化，先保存新的库备份和基线，不覆盖合法新投稿。

## 发布

1. 上传经过测试的代码到新目录 `/opt/answer-qr/releases/<UTC_TIMESTAMP>-auth-security/`，代码 root 管理、其他用户不可写。不要覆盖已有 release，不初始化库，不覆盖贡献配置。
2. 在新 release 用服务账号再运行后端测试。库、锁、SQLite/WAL 仍由 `answerqr` 写入；服务绝不改成 root。`configure_oauth.py` / `configure_bot.py` 不在本次部署中自动执行。
3. 为已核对的现有 HTTPS server 安装 `nginx-auth-entry-proxy.conf`，增加两个精确 location（`/answer-qr/auth/auto/start`、`/answer-qr/auth/login`），仅这两个使用 `answer_qr_login` 的 3r/m、burst 5 限流。
4. 在 `http {}` 内只新增未定义的 `answer_qr_login` zone；不要重复现有 zone。已有投稿、轮询、库读取限流、其他服务/站点及 TLS 配置保持原值。运行 `nginx -t`，失败就恢复本次片段，不能 reload。
5. 使用同目录临时链接 `current.new` 加原子重命名切换 `current`，切换目标必须是刚核对的新 release。只有 unit 文件确实改变才 `systemctl daemon-reload`；仅 `systemctl restart answer-qr`。
6. 服务本机健康检查通过后，仅在 Nginx 检查成功的前提下 `systemctl reload nginx`。服务异常立即走回滚；不要停其他站点。
7. 用户已确认所有人需要重新登录后，撤销全部旧会话：

   ```sh
   sudo -u answerqr python3 -B /opt/answer-qr/current/revoke_sessions.py --all
   ```

   脚本必须以 `answerqr` 运行，只打印删除数量；数据库自定义路径时加 `--database`。不要用 root 手动删除 SQL 行。

## 线上验证

只记录状态码、安全错误代码、布尔值、时间差、数量和哈希，不记录任何 Cookie、配对码、OAuth code、verifier 或会话 token。

- `systemctl is-active answer-qr` 为 active，回环 `/readyz` 正常。
- 公网和回环匿名读库 401；伪造用户 ID 请求头、查询或 Bearer 不能读库，返回 401/403（非法固定路径可为 404）。响应 no-store，不出现 QR 正文。
- `/contributions/status` 有 `pairing: true`；不带 `pairing: 1` 的旧自动登录请求返回 400 `client_outdated`。
- 用户用自己的账号从更新后的插件发起登录，浏览器输入插件显示的配对码，再完成 Discord 授权，插件成功登录；另起一次故意输错，尝试立即作废，重新打开/提交不能复用。
- 本人审核/免审账号登录后有效期不超过 24 小时；退出所有设备后原设备读库、投稿、详情均为 401。
- 无答疑身份组的账号拿不到会话；合法作者能读有权限的详情；审核员的修改详情能显示现有内容对比；实际审核/发布若会改库，必须另行明确授权，不能为了验证修改库。
- 库 SHA-256 与部署基线一致，ID/顺序无变化；贡献配置 SHA-256 不变。源码实际部署 SHA-256 与新分支一致，旧 release 和备份存在。
- 新 Nginx 两入口限流生效，轮询/投稿额度和其他既有站点不受影响。IP 限流测试只用本人的少量请求，记录 429 后等待配额恢复，不占满全站登录表。

真实 OAuth 成功和输错配对码必须由用户实际完成，不能用模拟测试冒充。尚未完成这些验证时，不推送修复到公开仓库。

## 回滚

1. `current` 原子切回已记录的旧 release；恢复**本次改动的** Nginx 片段。只有 unit 改动才恢复并 `daemon-reload`。`nginx -t` 成功后才 reload；仅重启 `answer-qr`。
2. 数据库只增加列和表，旧代码通常能忽略；优先保留现有数据库、QR 和配置。先验证兼容性，不无条件恢复数据库或库。
3. 如果确需恢复 SQLite：仅停止 `answer-qr`；保存故障数据库及它的 WAL/SHM 到新私有目录，再用一致性备份原子恢复主文件，属主 `answerqr:answerqr`、权限 `0600`。旧 WAL/SHM 不得与恢复的主文件混用。用备份副本检查 `PRAGMA integrity_check`，确认后再启动。
4. 恢复旧 DB 会带回被撤销的会话。为防止恢复可疑 token，使用保留在**新 release** 的 `revoke_sessions.py`，仍以 `answerqr` 对恢复的 DB 撤销全部会话，再启动。告知用户仍需重新登录；不恢复攻击前会话作为便利措施。
5. 本次不改库，不需要库回滚。如果库另外损坏，经用户确认后才使用 `sudo -u answerqr python3 -B update_library.py` 的校验、备份和原子替换流程，不能直接覆盖；不清除合法投稿。
6. 回滚到旧代码会重新暴露原认证风险，应暂停自动登录或限制云端访问并安排修正，不能把旧状态当作修复完成；不要推送未上线的修复细节。

## 交付记录

逐项给出 F1–F10 的实现文件、测试名称和结果；附部署前后源码和库 SHA-256、无敏感信息的线上验证输出，以及备份/旧 release/回滚路径。单独列出用户待决定的账号拆分、Bot 权限、`roleProofHours`；提醒答疑组更新插件，不使用他人发来的登录链接。线上验证完成后再推送公开仓库，提交说明概括最终安全修复。

交付时逐项勾选下面清单，未部署或尚待用户验证的项目须明确标记「未执行/待验证」，不能用本地通过代替线上成功：

| 项目 | 必须附上的证据 |
| --- | --- |
| F1 | 配对码、浏览器绑定、重放/并发/错误输入/旧客户端拒绝测试；真实 Linux Cookie/CSP 回归；Kettu 已配对或明确手动登录降级 |
| F2 | 已有高权限会话 24 小时过期、发布和审核共用限额及幂等/崩溃恢复测试 |
| F3 | 所有设备注销和服务账号撤销；旧 token 的库、投稿、详情均 401 |
| F4 | 拒绝重登的撤权记录已经提交，旧会话失效 |
| F5 | 缓存正文/已发布正文/获批修改详情均执行当前权限检查 |
| F6 | `roleProofHours=1` 用例，配置工具保留其他字段/属主/0640；未擅改线上 Bot 或时长 |
| F7 | 当天首份、同毫秒顺序、30 UTC 日、容量优先级及最新备份留存 |
| F8 | 仅审核员返回当前版本，界面各字段及逐行增删回归 |
| F9 | 5000 容量不挤旧请求，隔离 Nginx 语法结果；上线后的配置检查及两入口 IP 限流 |
| F10 | 锁/备份目录符号链接无写入、POSIX 路径替换防护、root 警告 |
| 发布 | 确认记录、备份位置、部署前后源码/库哈希、脱敏线上验证、旧会话撤销数量、回滚位置 |
| 用户事项 | 账号是否拆分、Bot 权限、证明时长、通知答疑组更新和登录防转发提醒 |
