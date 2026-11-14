const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_directory', 'search_files', 'search_content', 'read_image',
  'read_uploaded_file', 'search_skills', 'get_skill_instructions', 'list_skill_files',
  'web_search', 'web_fetch', 'send_message', 'wait_for_message', 'list_agents',
]);

/** Enforced at execution as well as schema exposure; shell/MCP cannot bypass child read-only policy. */
export function allowedAgentTool(name: string, isChild: boolean): boolean {
  return !isChild || READ_ONLY_TOOLS.has(name);
}
