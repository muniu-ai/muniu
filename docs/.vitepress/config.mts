import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Muniu",
  description: "Evidence-first coding agent control plane",
  srcExclude: ["plans/**", "archive/**"],
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "快速开始", link: "/quickstart" },
      { text: "架构", link: "/architecture" },
      { text: "插件", link: "/plugin-authoring" }
    ],
    sidebar: [
      { text: "首页", link: "/" },
      { text: "快速开始", link: "/quickstart" },
      { text: "架构", link: "/architecture" },
      { text: "插件开发", link: "/plugin-authoring" },
      { text: "企业运维", link: "/enterprise-operations" },
      { text: "故障排查", link: "/troubleshooting" },
      { text: "迁移", link: "/migration-v0.1" }
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/muniu-ai/muniu" }]
  }
});
