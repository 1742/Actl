import { app, dialog, ipcMain, Notification, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AgentProcessHost } from './agent-process-host';
import { agentRoutes, type AgentCommand, type DesktopSettings } from '../shared/agent-ipc';
import { writeJson } from '../agent-core/utils';

const operations = [...new Set(agentRoutes.map((route) => route[2]))] as [string, ...string[]];
const commandSchema = z.object({
  operation: z.enum(operations), params: z.record(z.string(), z.string().max(4_096)).optional(),
  query: z.record(z.string(), z.string().max(4_096)).optional(), body: z.unknown().optional(),
}).strict();
const subscriptionSchema = z.string().uuid();
const settingsSchema = z.object({ storageDirectory: z.string().trim().min(1).refine(path.isAbsolute, 'An absolute storage directory is required.') }).strict();

export class DesktopAgent {
  private host: AgentProcessHost | undefined;
  private starting: Promise<AgentProcessHost> | undefined;
  private restarting: Promise<void> | undefined;
  private stopping = false;
  private subscriptions = new Set<string>();
  private notifications = new Set<Notification>();
  private readonly settingsFile = path.join(app.getPath('userData'), 'desktop-settings.json');

  constructor(private readonly getWindow: () => BrowserWindow | undefined, private readonly validateSender: (event: IpcMainInvokeEvent) => void) {}

  async getSettings(): Promise<DesktopSettings> {
    try { return settingsSchema.parse(JSON.parse(await readFile(this.settingsFile, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { storageDirectory: path.join(app.getPath('userData'), 'data') };
    }
  }

  async ready() { return (await this.ensureHost()).ready(); }

  register(): void {
    const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => { this.validateSender(event); return handler(...args); });
    };
    handle('agent:ready', () => this.ready());
    handle('agent:request', async (value) => (await this.ensureHost()).request(commandSchema.parse(value) as AgentCommand));
    handle('agent:stream', async (subscription, value) => {
      const id = subscriptionSchema.parse(subscription);
      const command = commandSchema.parse(value) as AgentCommand;
      if (!['responses.create', 'responses.permissions'].includes(command.operation)) throw new Error('This operation is not a stream.');
      if (this.subscriptions.has(id)) throw new Error('Duplicate stream subscription.');
      this.subscriptions.add(id);
      try {
        const host = await this.ensureHost();
        return await host.request(command, (events) => {
          const window = this.getWindow();
          if (this.subscriptions.has(id) && window && !window.webContents.isDestroyed()) window.webContents.send('agent:events', { subscriptionId: id, events });
        }, id);
      } finally { this.subscriptions.delete(id); }
    });
    ipcMain.on('agent:detach', (event, value: unknown) => {
      try { this.validateSender(event as unknown as IpcMainInvokeEvent); } catch { return; }
      const parsed = subscriptionSchema.safeParse(value);
      if (parsed.success) { this.subscriptions.delete(parsed.data); this.host?.detach(parsed.data); }
    });
    handle('desktop:settings:get', () => this.getSettings());
    handle('desktop:settings:save', async (value) => { await writeJson(this.settingsFile, settingsSchema.parse(value)); });
    handle('desktop:restart', () => this.restart());
    handle('desktop:pick-directory', async () => {
      const window = this.getWindow();
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    handle('desktop:open-directory', async (value) => {
      const kind = z.enum(['storage', 'logs', 'skills', 'config']).parse(value);
      const settings = await this.getSettings();
      const directory = kind === 'config' ? app.getPath('userData') : kind === 'storage' ? settings.storageDirectory : path.join(settings.storageDirectory, kind);
      await mkdir(directory, { recursive: true });
      const error = await shell.openPath(directory);
      if (error) throw new Error(error);
    });
    handle('desktop:notify', (kindValue, titleValue, detailValue) => {
      const kind = z.enum(['completed', 'permission_requested']).parse(kindValue);
      const title = z.string().parse(titleValue).slice(0, 80);
      const detail = z.string().parse(detailValue).slice(0, 160);
      const window = this.getWindow();
      if (!Notification.isSupported() || window?.isFocused()) return;
      const notification = new Notification({ title: kind === 'completed' ? 'Actl · 任务完成' : 'Actl · 等待审批', body: `${title}\n${detail}` });
      this.notifications.add(notification);
      notification.once('close', () => this.notifications.delete(notification));
      notification.once('click', () => { const current = this.getWindow(); current?.restore(); current?.show(); current?.focus(); });
      notification.show();
    });
  }

  detachAll(): void {
    for (const id of this.subscriptions) this.host?.detach(id);
    this.subscriptions.clear();
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.detachAll();
    if (this.starting) await this.starting.catch(() => undefined);
    await this.host?.close();
    for (const notification of this.notifications) notification.close();
    this.notifications.clear();
  }

  private async ensureHost(): Promise<AgentProcessHost> {
    if (this.stopping) throw new Error('Application is shutting down.');
    if (this.restarting) await this.restarting;
    if (this.host) return this.host;
    return this.starting ??= (async () => {
      const settings = await this.getSettings();
      const host = new AgentProcessHost({ homeDirectory: settings.storageDirectory, mode: app.isPackaged ? 'release' : 'development' });
      await host.ready();
      this.host = host;
      return host;
    })().finally(() => { this.starting = undefined; });
  }

  private restart(): Promise<void> {
    return this.restarting ??= (async () => {
      this.detachAll();
      if (this.starting) await this.starting.catch(() => undefined);
      await this.host?.close();
      this.host = undefined;
    })().finally(() => { this.restarting = undefined; });
  }
}
