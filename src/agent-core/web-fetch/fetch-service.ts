import { lookup } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch, type Response } from "undici";
import { extractPage } from "./page-content.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

class BlockedAddressError extends Error {}

// Resolve at connect time and hand only the validated addresses back to Node.
const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, "", 0);
        const first = addresses[0];
        if (!first || addresses.some(({ address }) => !isPublicAddress(address))) {
          return callback(new BlockedAddressError("Target resolves to a non-public address."), "", 0);
        }
        if (options.all) return callback(null, addresses);
        return callback(null, first.address, first.family);
      });
    },
  },
});

function isPublicAddress(address: string): boolean {
  const ip = ipaddr.parse(address);
  if (ip instanceof ipaddr.IPv4) return ip.range() === "unicast";
  if (ip.isIPv4MappedAddress()) return ip.toIPv4Address().range() === "unicast";
  // Restrict IPv6 to global unicast, excluding special-use ranges within it.
  return ip.range() === "unicast" && (ip.parts[0]! & 0xe000) === 0x2000;
}

export function parsePageUrl(input: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new Error("invalid_url: Expected an absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("invalid_url: Only HTTP and HTTPS URLs without credentials are supported.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) ? !isPublicAddress(hostname) : !hostname.replace(/\.$/, "").includes(".")) {
    throw new Error("blocked_address: Expected a public web address.");
  }
  return url;
}

export function pageHostname(url: URL): string {
  return url.hostname.replace(/\.$/, "");
}

export async function fetchPage(requestedUrl: string, maxChars: number, callerSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  let url = parsePageUrl(requestedUrl);
  const hostname = pageHostname(url);
  for (let redirects = 0; ; redirects++) {
    const response = await requestPage(url, signal, callerSignal, timeout);
    if (redirectStatuses.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("invalid_redirect: The redirect has no Location header.");
      if (redirects >= MAX_REDIRECTS) throw new Error("too_many_redirects: The page exceeded five redirects.");
      url = parsePageUrl(location, url);
      if (pageHostname(url) !== hostname) {
        throw new Error(`cross_domain_redirect: Open the new URL with a separate web_fetch call: ${url.href}`);
      }
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const mimeType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (!response.ok || (mimeType !== "text/html" && mimeType !== "text/plain")) {
      await response.body?.cancel();
      if (!response.ok) throw new Error(`http_${response.status}: The website returned HTTP ${response.status}.`);
      throw new Error("unsupported_content_type: Expected text/html or text/plain.");
    }
    let bytes: Buffer;
    try {
      bytes = await readBody(response);
    } catch (error) {
      callerSignal?.throwIfAborted();
      if (timeout.aborted) throw timeoutError();
      if (error instanceof ResponseTooLargeError) throw error;
      throw new Error("network_error: Failed to read the page response.");
    }
    signal.throwIfAborted();
    const page = extractPage(bytes, url, contentType, mimeType, maxChars);
    return { requestedUrl, finalUrl: url.href, contentType, ...page };
  }
}

async function requestPage(url: URL, signal: AbortSignal, callerSignal: AbortSignal | undefined, timeout: AbortSignal) {
  try {
    return await fetch(url, {
      dispatcher,
      signal,
      redirect: "manual",
      headers: { accept: "text/html, text/plain", "user-agent": "Actl-WebFetch/1.0" },
    });
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (timeout.aborted) throw timeoutError();
    if (error instanceof Error && error.cause instanceof BlockedAddressError) {
      throw new Error("blocked_address: Target resolves to a non-public address.");
    }
    throw new Error("network_error: Failed to connect to the website.");
  }
}

function timeoutError(): Error {
  return new Error("fetch_timeout: The webpage request exceeded 15 seconds.");
}

class ResponseTooLargeError extends Error {
  constructor() {
    super("response_too_large: The decoded webpage exceeds 2 MiB.");
  }
}

async function readBody(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
