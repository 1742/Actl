import type { PermissionMode } from "../../permissions/engine.js";
import type { Session } from "../workspace-store.js";

const CHILD_TOOLS = new Set([
  'read_file', 'list_directory', 'search_files', 'search_content', 'read_image',
  'read_uploaded_file', 'search_skills', 'get_skill_instructions', 'list_skill_files',
  'web_search', 'web_fetch', 'mail', 'wait', 'agents', 'tasks', 'plan',
  'shell', 'shell_poll', 'shell_stop',
]);

const EDIT_TOOLS = new Set(['write_file', 'apply_patch']);

export function childPermissionMode(session: Session, parentMode: PermissionMode, taskMode = parentMode): PermissionMode {
  if (session.profile?.access !== 'edit' || parentMode === 'plan' || taskMode === 'plan') return 'plan';
  if (parentMode === 'ask' || taskMode === 'ask') return 'ask';
  return 'accept_edits';
}

export function allowedAgentTool(name: string, isChild: boolean, mode: PermissionMode): boolean {
  return !isChild || CHILD_TOOLS.has(name) || (mode !== 'plan' && EDIT_TOOLS.has(name));
}
