# 第三方组件

部署压缩包附带锁定版本的 `ws`，其 MIT 许可证保留在 `node_modules/ws/LICENSE` 中；源代码与依赖版本见 `package-lock.json`。

部署程序从官方地址下载 Node.js 和 NapCatQQ，并校验 SHA-256。它们不包含在本发布压缩包内，各自适用其官方发布的许可证。QQ 客户端需用户从腾讯官网下载并安装。

- Node.js：https://nodejs.org/
- NapCatQQ：https://github.com/NapNeko/NapCatQQ
- ws：https://github.com/websockets/ws

## 人格卡文本

`personas/characters/鲸鱼娘.md` 改写自 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的 `roles/小鲸鱼.md`，按 MIT 许可证使用：

```
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

本项目的改动，仅为去掉与上游运行时相关的句子（上游的 `qq-chat` / `qq-chat-v2` 预设名、`mcp__web-search-safe__web_search` 工具调用、以及"按桥接在当前模式下的潜水方式处理"这类说明），因为本项目没有工具循环，分条与何时开口由本项目的仿真层负责。人物设定、语气、梗与示例未改。
