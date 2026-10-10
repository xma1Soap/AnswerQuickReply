# AnswerQuickReply · 答疑 QR

Discord 的图文答疑工具：保存常用答复、配置关键词，在消息右键菜单搜索并引用回复；也可以用本机 OCR 从报错截图查找相关答复。

本仓库包含 Vencord 桌面／网页插件，以及可选的云端答疑库服务端。首次使用本地库为空，不内置答疑内容。

## 功能

- 本地文字与图片 QR：收录消息、新建、编辑、收藏、删除和撤销、JSON 导入导出。
- 消息右键二级菜单顶部搜索，选择面板预览图文、匹配依据与引用目标；发送需手动操作。
- 本地与云端 QR 均可右键收藏，消息右键菜单可直接发送两种来源的收藏；云端收藏仅保存在本机。
- Windows OCR 与浏览器内置 Tesseract OCR，图片在本机识别。
- 云端库批量导入本地；Discord OAuth 配对登录、答疑身份组鉴权、投稿审核和管理员免审名单；可退出所有设备。
- 直接编辑社区云端 QR：保存后替换原条目，免审名单即时发布，其他成员的修改经审核生效；版本冲突时阻止覆盖。
- 来源消息在 Discord 内跳转，引用目标固定到最初选择的消息。

## 目录与安装

| 目录 | 用途 |
| --- | --- |
| [`answerQuickReply/`](answerQuickReply/README.md) | Vencord 桌面／网页共用插件，含离线 OCR 资源及第三方许可。 |
| [`answer-qr-server/`](answer-qr-server/README.md) | Python 3.10+ 云端库服务、systemd／Nginx 模板与测试。 |

将整个 `answerQuickReply` 文件夹放进 Vencord 源码的 `src/userplugins/`，连同 `vendor/` 一起复制，然后按插件文档编译。它不是可直接导入官方扩展的 ZIP；网页端需要包含本插件的自编译 Vencord 扩展。升级桌面版后，从系统托盘完全退出 Discord 再启动。

本地库无需登录。社区云端库要求 Discord 登录及指定答疑身份组；未获授权仍可使用本地功能。自建服务按 [部署文档](answer-qr-server/README.md) 与 [OAuth／身份组配置](answer-qr-server/CONTRIBUTIONS.md) 操作，真实凭据仅保存在服务器配置中。

登录时只使用自己插件打开的页面，在浏览器输入插件面板显示的配对码。旧版自动登录需更新插件，或使用一次性登录码。安全升级的部署、验证与回滚见 [发布手册](answer-qr-server/SECURITY-DEPLOYMENT.md)。

Kettu Android 移植尚未同步本次云端登录协议，不包含在本次公开版本中。

## 验证

服务端：

```sh
cd answer-qr-server
python -B -m unittest discover -s tests -v
```

测试覆盖身份组、登录、投稿审核、下载限频及数据校验，使用模拟 Discord 身份服务，不替代真实账号授权验证。Vencord 客户端测试范围及宿主接口限制见插件 README。

收藏回归测试使用真实客户端模块及模拟存储／Discord 宿主；在装好依赖的 Vencord 源码旁运行：

```sh
node tests/favorites.cjs /path/to/Vencord
node tests/favorites-menu.cjs /path/to/Vencord
```

覆盖本地与云端收藏、账号／库隔离、保存失败、过期／退出、旧菜单、引用目标及云端编辑隔离；不会连接真实 Discord 或发送消息。

## 隐私与许可

插件不读取 Discord 客户端 token；OCR 不上传到外部识别服务；QR 只有手动提交才会上传到云端。不要向仓库提交配置凭据、数据库、QR 私人备份或部署记录。

本项目采用 **GPL-3.0-or-later**，见 [LICENSE](LICENSE)。OCR 引擎及语言数据的许可单独保留在 `answerQuickReply/vendor/`。
