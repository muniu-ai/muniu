# 插件开发

Cordis 插件导出一个函数、类或对象。最小 ESM 插件：

```js
export default function plugin(ctx, config) {
  ctx.provide("exampleService", Object.freeze({ value: config.value }))
  ctx.effect(() => () => ctx.set("exampleService", undefined))
}
```

配置：

```yaml
- id: example
  name: /absolute/path/example.mjs
  config:
    value: 1
```

要求：

1. 使用稳定、唯一的 entry id。
2. 用显式 `inject` 描述依赖。
3. 所有监听器、计时器、文件句柄和服务都通过 effect 返回清理函数。
4. 配置必须可摘要；不要把 secret 放入插件配置。
5. 安装 npm 插件必须使用精确 semver，禁止 tag 和范围。
6. reload 失败必须保留旧 runtime，插件不能假设只加载一次。

```bash
mn plugin install ./example.mjs
mn plugin reload
mn plugin list
```

插件拥有宿主进程权限，不得把它描述为权限隔离或安全沙箱。
