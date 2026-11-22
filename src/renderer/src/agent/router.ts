import type { RouteRecordRaw, Router } from 'vue-router';
import { tr } from '../i18n';
import type { ActionResult } from '../types/common';
import { runtimeResourceKey, selectAgentSession } from './composables/useAgent';
import { useAgentStore } from './stores/agent';

export async function enterAgentConversation(router: Router) {
  if (router.currentRoute.value.name !== 'aiAgentRightSidebarHome') {
    await router.push({ name: 'aiAgent' });
  }
}

export async function openAgentSubagent(router: Router, sessionId: string) {
  const store = useAgentStore();
  if (!store.currentTree?.members[sessionId]?.session.parentSessionId) return;
  if (router.currentRoute.value.name !== 'aiAgentRightSidebarHome') {
    await router.push({ name: 'aiAgentRightSidebarHome' });
  }
  if (router.currentRoute.value.name === 'aiAgentRightSidebarHome' &&
      store.currentTree?.members[sessionId]?.session.parentSessionId) {
    store.requestedSubagentId = sessionId;
  }
}

export async function openAgentSearchResult(router: Router, sessionId: string): Promise<ActionResult> {
  const store = useAgentStore();
  const session = store.sessionById(sessionId);
  if (!session || store.isSessionArchived(sessionId))
    return { status: 'error', message: tr('ui.conversationDoesNotExistOrHas') };

  const parentId = session.parentSessionId
    ? runtimeResourceKey(session.runtimeKind, session.parentSessionId)
    : undefined;
  const conversationId = parentId ?? session.id;
  if (store.selectedSessionId !== conversationId) {
    const result = await selectAgentSession(conversationId);
    if (result.status === 'error') return result;
  }
  if (store.selectedSessionId !== conversationId) return { status: 'success' };
  if (parentId) await openAgentSubagent(router, session.id);
  else await enterAgentConversation(router);
  return { status: 'success' };
}

const agentRoutes: RouteRecordRaw = {
  path: "agent",
  component: () => import("./components/layout/AIView.vue"),
  children: [
    {
      path: "",
      name: "aiAgent",
      component: () => import("./components/layout/Agent.vue"),
      children: [
        {
          path: "sidebars",
          name: "aiAgentRightSidebarHome",
          component: () => import("./components/right-sidebar/AgentSidebarTabs.vue"),
        },
        {
          path: "sidebars/files",
          name: "aiAgentRightSidebarFiles",
          redirect: { name: "aiAgentRightSidebarHome" },
        },
      ],
    },
    {
      path: "settings",
      name: "aiAgentSettings",
      component: () => import("./components/settings/Settings.vue"),
    },
    {
      path: "skills",
      name: "aiSkills",
      component: () => import("./components/skills/SkillLibraryView.vue"),
    },
    {
      path: "mcp",
      name: "aiMcp",
      component: () => import("./components/mcp/McpLibraryView.vue"),
    },
    {
      path: "skills/:skillId",
      name: "aiSkillDetail",
      component: () => import("./components/skills/SkillDetailView.vue"),
      props: true,
    },
  ],
};

export const aiRoutes: RouteRecordRaw = {
  path: '/ai',
  component: () => import('./components/layout/View.vue'),
  children: [
    {
      path: '',
      name: 'aiEntry',
      redirect: { name: 'aiAgent' },
    },
    agentRoutes,
  ]
};
