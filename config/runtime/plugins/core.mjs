// SPDX-License-Identifier: Apache-2.0

export default function coreRuntimePlugin(context, config) {
  const descriptor = Object.freeze({
    schemaVersion: 1,
    scope: config.scope,
    profileId: config.profileId,
    components: Object.freeze([...(config.components ?? [])])
  });
  const serviceName = config.serviceName ?? "muniuRuntimeDescriptor";
  context.provide(serviceName, descriptor);
  context.effect(() => () => context.set(serviceName, undefined));
}
