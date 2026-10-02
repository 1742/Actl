import { Router } from "express";
import { AGENT_TOKEN_HEADER, loadLocalAgentToken, validateLocalToken } from "../auth/runtime-auth.js";

/** Desktop-managed Agents use the same local token as business requests. */
export function createDesktopLifecycle(
  onShutdown: (reason: string) => void,
  environment: NodeJS.ProcessEnv = process.env,
): { router: Router; start: () => void; stop: () => void } {
  const managed = environment.ACTL_AGENT_HEARTBEAT_TIMEOUT_MS !== undefined;
  const token = managed ? loadLocalAgentToken(environment) : undefined;
  const timeoutMs = Number(environment.ACTL_AGENT_HEARTBEAT_TIMEOUT_MS ?? 20_000);
  if (managed && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000)) {
    throw new Error("Invalid ACTL_AGENT_HEARTBEAT_TIMEOUT_MS");
  }
  const router = Router();
  let timer: NodeJS.Timeout | undefined;
  let deadline = 0;
  let stopping = false;
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
  };
  const renew = () => {
    clearTimeout(timer);
    deadline = performance.now() + timeoutMs;
    timer = setTimeout(() => {
      stop();
      onShutdown("heartbeat_timeout");
    }, timeoutMs);
    timer.unref();
  };
  // This public response contains no session identifiers or credentials.
  router.get("/status", (_req, res) => {
    res.json({ 
      protocol: 1, 
      managed, 
      stopping,
      remainingMs: managed ? Math.max(0, Math.ceil(deadline - performance.now())) : 0 
    });
  });
  router.post(["/heartbeat", "/shutdown"], (req, res) => {
    if (!token || !validateLocalToken(req.get(AGENT_TOKEN_HEADER), token)) {
      res.sendStatus(403);
      return;
    }
    if (stopping) {
      res.sendStatus(409);
      return;
    }
    if (req.path === "/shutdown") {
      stop();
      res.sendStatus(202);
      onShutdown("client_shutdown");
    } else {
      renew();
      res.sendStatus(204);
    }
  });
  return { 
    router, 
    start: () => { 
      // not set timeout, not start timer
      if (managed && !stopping) renew(); 
    }, 
    stop 
  };
}
