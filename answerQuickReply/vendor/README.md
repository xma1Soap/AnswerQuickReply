# AnswerQuickReply 本地网页 OCR 资源

此目录资源随插件源码、Vencord 网页扩展一起分发。`webOcr.ts` 通过 Vencord 的 `file://` 编译器把脚本与语言数据编入最终 JavaScript，不需要另外部署资源服务器。

- `worker.min.js`：官方 Tesseract.js **6.0.1** 浏览器 worker；保留原文件、许可证声明与源码映射。
- `tesseract-core-lstm.wasm.js`、`tesseract-core-simd-lstm.wasm.js`：官方 Tesseract.js core **6.0.0**，均包含完整的 Base64 WebAssembly 程序。支持 SIMD 的浏览器优先使用 SIMD 版本，其余使用标量版本。
- `eng.traineddata.gz`、`chi_sim.traineddata.gz`：官方 **tessdata_fast 4.1.0** 英文、简体中文 LSTM 模型；由原始 traineddata 用 gzip level 9、mtime 0 压缩，无模型内容修改。
- `provenance.json`：固定下载来源、版本、实际文件长度与 SHA-256，可核验本目录文件。下载只发生在维护和打包时。

运行时在 Discord 当前网页内创建 Blob Worker，预先载入 core，直接传入模型字节。Worker 禁止 `fetch` 和 `importScripts` 下载外部资源；不会上传图片、调用在线识图服务、下载 CDN 引擎或打开新浏览器页面。Discord 图片附件本身仍需从 Discord CDN 读取，这由插件附件读取模块负责。

图片在浏览器解码为单帧 PNG，最大长边 4000 像素、最多 1200 万像素。OCR 请求依次执行；初始化阶段单步超时 45 秒、识图超时 90 秒，出错销毁 worker 后可重试。闲置 60 秒或插件停止时释放 worker、Blob URL 和待处理任务。

许可：Tesseract.js、Tesseract.js core、tessdata_fast 均为 Apache-2.0，对应全文为 `tesseract-js.LICENSE`、`tesseract-core.LICENSE`、`tessdata.LICENSE`。`worker.min.js.LICENSE.txt` 保留上游 bundle 的原始声明，`licenses/` 收录其中依赖的许可全文，包括 buffer、base64-js、bmp-js、idb-keyval、ieee754、is-url、regenerator-runtime、wasm-feature-detect 和 zlibjs。SIMD 探测字节来自 wasm-feature-detect，使用其 Apache-2.0 许可。

源码与许可来源：

- <https://github.com/naptha/tesseract.js/tree/v6.0.1>
- <https://github.com/naptha/tesseract.js-core/tree/v6.0.0>
- <https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0>
- <https://github.com/feross/buffer/blob/v6.0.3/LICENSE>
- <https://github.com/beatgammit/base64-js/blob/v1.5.1/LICENSE>
- <https://github.com/shaozilee/bmp-js/blob/master/LICENSE>
- <https://github.com/jakearchibald/idb-keyval/blob/v6.2.1/LICENCE>
- <https://github.com/feross/ieee754/blob/v1.2.1/LICENSE>
- <https://registry.npmjs.org/is-url/-/is-url-1.2.4.tgz> (`package/LICENSE-MIT`)
- <https://github.com/facebook/regenerator/blob/main/LICENSE>
- <https://github.com/GoogleChromeLabs/wasm-feature-detect/blob/v1.8.0/LICENSE>
- <https://github.com/imaya/zlib.js/blob/0.3.1/LICENSE>
