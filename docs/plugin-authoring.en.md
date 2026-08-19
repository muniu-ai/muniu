# Plugin authoring

```js
export default function plugin(ctx, config) {
  ctx.provide("exampleService", Object.freeze({ value: config.value }))
  ctx.effect(() => () => ctx.set("exampleService", undefined))
}
```

Use stable entry IDs, explicit injections, and effects that clean every listener, timer, handle, and service. Keep secrets out of digestible configuration. npm installs require an exact semver. A failed reload must leave the previous runtime usable.

Plugins have host-process authority and are not a security sandbox.
