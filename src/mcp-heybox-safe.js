// 小黑盒 MCP server 的独立入口（stdio）。**日常运行不走这个文件。**
//
// DSH 的 MCP server 清单在 DSH 启动时就固定了，新加一个独立 server 必须重启 DSH 才生效，
// 而重启会打断正在跑的会话。所以日常运行时 heybox_* 工具注册在已有的 snowluma server 里
// （src/mcp-snowluma-safe.js 调用 registerHeyboxTools），工具实现全在 src/heybox-tools.js；
// 这个入口只保留「手动拉起 / 调试」的用法：
//   node src/mcp-heybox-safe.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHeyboxTools } from './heybox-tools.js';

const server = new McpServer({ name: 'heybox-safe', version: '0.1.0' });
registerHeyboxTools(server);

await server.connect(new StdioServerTransport());
