import { defineConfig } from "vitepress";

export default defineConfig({
  title: "木牛 Agent OS 0.2",
  description: "共用内核、受控执行与成果导向的 Agent OS",
  srcExclude: ["upstream-provenance/**"],
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "快速开始", link: "/quickstart" },
      { text: "架构", link: "/architecture" },
      { text: "API", link: "/reference/api-routes" },
      { text: "插件", link: "/plugin-authoring" },
    ],
    sidebar: [
      {
        text: "使用木牛",
        items: [
          { text: "概览", link: "/" },
          { text: "快速开始", link: "/quickstart" },
          { text: "故障排查", link: "/troubleshooting" },
        ],
      },
      {
        text: "设计与开发",
        items: [
          { text: "架构", link: "/architecture" },
          { text: "架构决策", link: "/adr/0011-agent-os-v2-hard-cutover" },
          { text: "插件开发", link: "/plugin-authoring" },
          { text: "API 路由", link: "/reference/api-routes" },
          { text: "OpenAPI", link: "/reference/openapi" },
          { text: "CLI", link: "/reference/cli" },
          { text: "事件", link: "/reference/events" },
          { text: "工具与审批", link: "/reference/tools" },
          { text: "插件运维", link: "/reference/plugins" },
          { text: "配置", link: "/reference/configuration" },
        ],
      },
      {
        text: "运维与发布",
        items: [
          { text: "企业运维", link: "/enterprise-operations" },
          { text: "安全边界", link: "/security/overview" },
          { text: "日志脱敏", link: "/security/redaction-policy" },
          { text: "密钥扫描", link: "/security/secret-scanning" },
          { text: "macOS 发布", link: "/release/macos" },
          { text: "签名与公证", link: "/release/apple-developer-id" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/muniu-ai/muniu" }],
  },
});
