declare const __ACTL_AGENT_BUILD_FLAVOR__: "development" | "release" | undefined;

export type BuildFlavor = "development" | "release";

export const BUILD_FLAVOR: BuildFlavor = typeof __ACTL_AGENT_BUILD_FLAVOR__ === "undefined"
  ? "development"
  : __ACTL_AGENT_BUILD_FLAVOR__;
