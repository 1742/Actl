export interface RuntimeMcpServerConfig {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  enabled: boolean;
}

export interface RuntimeMcpServer {
  name: string;
  config: RuntimeMcpServerConfig;
  connected: boolean;
  error: string | null;
  tools: Array<{ name: string; description: string }>;
}

export interface RuntimeMcpCatalogServer {
  name: string;
  connected: boolean;
  toolCount: number;
}
