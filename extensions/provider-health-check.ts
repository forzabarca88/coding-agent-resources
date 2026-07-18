import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

async function checkProviderHealth(
  providerId: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ name: string; status: string; isUp: boolean }> {
  const registry = ctx.modelRegistry;
  const name = registry.getProviderDisplayName(providerId) || providerId;
  const authStatus = registry.getProviderAuthStatus(providerId);

  if (!authStatus.configured) {
    return { name, status: "Missing Configuration", isUp: false };
  }

  const availableModels = registry.getAvailable();
  const modelWithUrl = availableModels.find(
    (m) => m.provider === providerId && m.baseUrl,
  );

  if (!modelWithUrl) {
    return { name, status: "Ready (No Models)", isUp: true };
  }

  try {
    const url = new URL(modelWithUrl.baseUrl);
    url.pathname = "/v1/models";

    const res = await fetch(url.toString(), {
      method: "GET",
      signal: signal,
      headers: { "User-Agent": "Pi-Health-Check" },
    });

    if (!res.ok) {
      // HTTP 401/403 means the endpoint is connectable but unauthorized/forbidden
      // — the service is up, just restricted for this particular endpoint.
      // Actual chat/completions endpoints may work fine (e.g., Google Gemini
      // returns 403 on /v1/models but chat works normally).
      if (res.status === 401 || res.status === 403) {
        return { name, status: "Ready", isUp: true };
      }
      return { name, status: `HTTP ${res.status}`, isUp: false };
    }

    return { name, status: "Ready", isUp: true };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { name, status: "Timeout", isUp: false };
    }

    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("ENOTFOUND")) {
      return { name, status: "Connection Refused", isUp: false };
    }

    return { name, status: "Error", isUp: false };
  }
}

async function runHealthCheck(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!ctx.hasUI) return [];

  const registry = ctx.modelRegistry;
  const availableModels = registry.getAvailable();

  // Collect only providers that have a baseUrl to check
  const providerIds = new Set<string>();
  availableModels.forEach((m) => {
    if (m.baseUrl) providerIds.add(m.provider);
  });

  // Also include unconfigured providers (they have no baseUrl but we still want to show them)
  availableModels.forEach((m) => {
    const authStatus = registry.getProviderAuthStatus(m.provider);
    if (!authStatus.configured) providerIds.add(m.provider);
  });

  // Run all checks concurrently — independent HTTP calls don't need to be sequential
  const checkPromises = Array.from(providerIds).map((id) =>
    checkProviderHealth(id, ctx, signal),
  );
  const results = await Promise.allSettled(checkPromises);

  return results.map((r) => {
    const s = r.status === "fulfilled"
      ? r.value
      : { name: "unknown", status: "Error", isUp: false };
    const icon = s.isUp ? "✅" : "❌";
    return `${icon} ${s.name}: ${s.status}`;
  });
}

// Register the command once at module scope (not per session_start)
function registerCheckCommand(pi: ExtensionAPI) {
  pi.registerCommand("check-providers", {
    description: "Check the health of all configured providers",
    handler: async (_args, cmdCtx) => {
      const lines = await runHealthCheck(cmdCtx, cmdCtx.signal);
      cmdCtx.ui.setWidget("provider-health", lines);
      const up = lines.filter((l) => l.startsWith("✅")).length;
      const total = lines.length;
      cmdCtx.ui.notify(
        `Providers: ${up}/${total} up`,
        up < total ? "warn" : "info",
      );
    },
  });
}

export default function (pi: ExtensionAPI) {
  const IDLE_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

  // Health checks get their own AbortController so they are not cancelled
  // when the agent turn is aborted by the user.
  const healthAbort = new AbortController();

  // Idle periodic check timer — only active while pi is idle
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let isIdle = false;

  // Register command once at load time
  registerCheckCommand(pi);

  function startIdleTimer(ctx: ExtensionContext) {
    if (idleTimer) return; // already running
    isIdle = true;

    idleTimer = setInterval(async () => {
      if (!isIdle) return; // agent started working, skip this tick

      try {
        const lines = await runHealthCheck(ctx, healthAbort.signal);
        ctx.ui.setWidget("provider-health", lines);
      } catch {
        // Silently ignore — don't disrupt the session
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  function stopIdleTimer() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    isIdle = false;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const lines = await runHealthCheck(ctx, healthAbort.signal);

    ctx.ui.setWidget("provider-health", lines);

    const up = lines.filter((l) => l.startsWith("✅")).length;
    const down = lines.length - up;
    ctx.ui.notify(
      `Providers: ${up} up, ${down} down`,
      down > 0 ? "warn" : "info",
    );

    // Start periodic idle checks (every 30s) until the agent starts
    startIdleTimer(ctx);
  });

  // Agent is about to start working — stop the idle timer so health
  // checks do not fire during active agent turns.
  pi.on("before_agent_start", async (_event, ctx) => {
    stopIdleTimer();
  });

  // Agent just finished — run health check immediately, then restart
  // periodic idle checks while waiting for the next user prompt.
  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    try {
      const lines = await runHealthCheck(ctx, healthAbort.signal);
      ctx.ui.setWidget("provider-health", lines);
    } catch {
      // Silently ignore — don't disrupt the session
    }

    startIdleTimer(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopIdleTimer();
    healthAbort.abort();
    (_ctx as ExtensionContext).ui.setWidget("provider-health", []);
  });
}
