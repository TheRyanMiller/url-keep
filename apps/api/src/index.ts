import { createApp } from "./app";
import { runMaintenance } from "./maintenance";
import type { Bindings } from "./types";

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(runMaintenance(env));
  },
};
