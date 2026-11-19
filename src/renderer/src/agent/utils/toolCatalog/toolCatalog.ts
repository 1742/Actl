import {
  Activity,
  BookOpen,
  Cable,
  CircleStop,
  ContactRound,
  Diff,
  Download,
  FilePenLine,
  FilePlay,
  FileText,
  FolderOpen,
  FolderSearch,
  FolderSymlink,
  FolderTree,
  GitFork,
  Globe,
  Hand,
  Hourglass,
  Image,
  LibraryBig,
  ListChecks,
  ListOrdered,
  Mail,
  NotebookText,
  Paperclip,
  Plug,
  SearchCode,
  Terminal,
  TextSearch,
  Trash2,
  Users,
  Wrench,
} from '@lucide/vue';
import type { AgentToolPresentation } from '../../components/conversation/types';

interface ToolDisplay {
  presentation: AgentToolPresentation;
  title: string;
  icon: typeof Wrench;
}

const tools: Readonly<Record<string, ToolDisplay>> = {
  // Files and attachments
  read_file: { presentation: 'read', title: 'Read', icon: FileText },
  read_uploaded_file: { presentation: 'read', title: 'Read Attachment', icon: Paperclip },
  read_image: { presentation: 'read', title: 'View Image', icon: Image },
  write_file: { presentation: 'write', title: 'Write', icon: FilePenLine },
  apply_patch: { presentation: 'edit', title: 'Edit', icon: Diff },
  list_directory: { presentation: 'list', title: 'List', icon: FolderOpen },
  search_files: { presentation: 'glob', title: 'Glob', icon: FolderSearch },
  search_content: { presentation: 'grep', title: 'Grep', icon: TextSearch },
  move_path: { presentation: 'move', title: 'Move', icon: FolderSymlink },
  delete_path: { presentation: 'delete', title: 'Delete', icon: Trash2 },

  // Shell and processes
  shell: { presentation: 'shell', title: 'Shell', icon: Terminal },
  shell_poll: { presentation: 'process', title: 'Poll Process', icon: Activity },
  shell_stop: { presentation: 'process', title: 'Stop Process', icon: CircleStop },

  // Skills
  search_skills: { presentation: 'skill', title: 'Find Skills', icon: LibraryBig },
  get_skill_instructions: { presentation: 'skill', title: 'Skill Instructions', icon: BookOpen },
  list_skill_files: { presentation: 'skill', title: 'Skill Files', icon: FolderTree },

  // Web
  web_search: { presentation: 'web_search', title: 'Web Search', icon: Globe },
  web_fetch: { presentation: 'web_fetch', title: 'Web Fetch', icon: Download },

  // Agent coordination
  list_agent_profiles: { presentation: 'agent_team', title: 'Roles', icon: ContactRound },
  tasks: { presentation: 'agent_team', title: 'Tasks', icon: ListChecks },
  delegate_task: { presentation: 'agent_team', title: 'Delegate', icon: GitFork },
  agents: { presentation: 'agent_team', title: 'Agents', icon: Users },
  mail: { presentation: 'agent_team', title: 'Mail', icon: Mail },
  wait: { presentation: 'agent_team', title: 'Wait', icon: Hourglass },
  interrupt_agent: { presentation: 'agent_team', title: 'Interrupt', icon: Hand },
  plan: { presentation: 'agent_team', title: 'Plan', icon: ListOrdered },

  // MCP
  search_mcp_tools: { presentation: 'mcp', title: 'Find MCP Tools', icon: SearchCode },
  call_mcp_tool: { presentation: 'mcp', title: 'Call MCP Tool', icon: Cable },

  // Older transcripts
  read_skill_resource: { presentation: 'skill', title: 'Read Skill Resource', icon: NotebookText },
  run_skill_script: { presentation: 'skill', title: 'Run Skill Script', icon: FilePlay },
};

export function toolDisplay(name: string): ToolDisplay {
  if (Object.hasOwn(tools, name)) return tools[name]!;
  if (name.startsWith('mcp__')) return { presentation: 'mcp', title: 'MCP', icon: Plug };
  return { presentation: 'generic', title: 'Tool', icon: Wrench };
}
