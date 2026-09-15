// SPDX-License-Identifier: Apache-2.0

import type { Context, Fiber } from "@deepseek-ai/cordis";
import type { PluginActivationLifecycle, PluginDefinitionV1 } from "@mn/plugin-sdk";

export class CordisPluginActivationLifecycle implements PluginActivationLifecycle {
  readonly #workspaces = new Map<string, Promise<Fiber>>();
  readonly #plugins = new Map<string, Promise<Fiber>>();

  constructor(readonly context: Context) {}

  async activate(workspaceId: string, definition: PluginDefinitionV1): Promise<void> {
    const key = JSON.stringify([workspaceId, definition.id]);
    const existing = this.#plugins.get(key);
    if (existing) { await existing; return; }
    const pending = (async () => {
      let workspace = this.#workspaces.get(workspaceId);
      if (!workspace) {
        const fiber = this.context.isolate("productWorkspace").plugin({
          name: "agent-os.workspace",
          apply(scope) { scope.provide("productWorkspace", workspaceId); },
        });
        workspace = Promise.resolve(fiber).then(() => fiber);
        this.#workspaces.set(workspaceId, workspace);
      }
      const owner = await workspace;
      const fiber = owner.ctx.isolate("productPlugin").plugin({
        name: `product:${definition.id}`,
        async apply(scope) {
          scope.provide("productPlugin", definition);
          scope.effect(() => () => definition.deactivate?.({ workspaceId }));
          await definition.activate?.({
            workspaceId,
            onDispose(cleanup) { scope.effect(() => cleanup); },
          });
        },
      });
      try { await fiber; return fiber; }
      catch (error) { await fiber.dispose(); throw error; }
    })();
    this.#plugins.set(key, pending);
    try { await pending; } catch (error) { this.#plugins.delete(key); throw error; }
  }

  async deactivate(workspaceId: string, pluginId: string): Promise<void> {
    const key = JSON.stringify([workspaceId, pluginId]);
    const pending = this.#plugins.get(key);
    if (!pending) return;
    try { await (await pending).dispose(); }
    finally { this.#plugins.delete(key); }
  }
}
