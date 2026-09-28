import { defineConfig } from "vitepress";

export default defineConfig({
  title: "木牛 Agent OS 0.2",
  description: "木牛的使用、开发、Agent 协作与企业运维指南",
  lang: "zh-CN",
  srcExclude: ["upstream-provenance/**"],
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "开始使用", link: "/quickstart" },
      { text: "开发", link: "/development" },
      { text: "Agent 指南", link: "/agent-guide" },
      { text: "接口参考", link: "/reference/api-routes" },
    ],
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
              modal: {
                noResultsText: "没有找到相关文档",
                resetButtonTitle: "清除搜索",
                footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
              },
            },
          },
        },
      },
    },
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一篇", next: "下一篇" },
    sidebar: [
      {
        text: "开始使用",
        items: [
          { text: "文档导航", link: "/" },
          { text: "快速开始", link: "/quickstart" },
          { text: "核心概念", link: "/concepts" },
          { text: "能力与验证状态", link: "/status" },
          { text: "OPC 机会验证", link: "/guides/opc" },
          { text: "Coding 研发任务", link: "/guides/coding" },
          { text: "CLI 使用", link: "/guides/cli" },
          { text: "故障排查", link: "/troubleshooting" },
        ],
      },
      {
        text: "开发与扩展",
        items: [
          { text: "开发指南", link: "/development" },
          { text: "Agent 工作指南", link: "/agent-guide" },
          { text: "架构", link: "/architecture" },
          { text: "插件开发", link: "/plugin-authoring" },
          { text: "架构决策", link: "/adr/" },
        ],
      },
      {
        text: "接口与配置",
        collapsed: true,
        items: [
          { text: "CLI 命令", link: "/reference/cli" },
          { text: "API 路由", link: "/reference/api-routes" },
          { text: "OpenAPI", link: "/reference/openapi" },
          { text: "事件与恢复", link: "/reference/events" },
          { text: "工具与审批", link: "/reference/tools" },
          { text: "插件运维", link: "/reference/plugins" },
          { text: "配置", link: "/reference/configuration" },
        ],
      },
      {
        text: "运维与发布",
        collapsed: true,
        items: [
          { text: "企业运维", link: "/enterprise-operations" },
          { text: "安全边界", link: "/security/overview" },
          { text: "日志脱敏", link: "/security/redaction-policy" },
          { text: "密钥扫描", link: "/security/secret-scanning" },
          { text: "技术与发布契约", link: "/TECHNICAL_DESIGN" },
          { text: "macOS 发布", link: "/release/macos" },
          { text: "签名与公证", link: "/release/apple-developer-id" },
          { text: "工程验收记录", link: "/verification/application-boundaries-2026-09-28" },
        ],
      },
      {
        text: "专项资料",
        collapsed: true,
        items: [
          { text: "工业询价参考应用", link: "/industry-delivery/README" },
          { text: "双仓库集成", link: "/industry-delivery/integration" },
          { text: "历史交付状态", link: "/industry-delivery/delivery-status" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/muniu-ai/muniu" }],
  },
});
