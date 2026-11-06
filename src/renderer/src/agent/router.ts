import type { RouteRecordRaw } from 'vue-router';

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
          component: () => import("./components/layout/AgentSidebarHome.vue"),
        },
        {
          path: "sidebars/files",
          name: "aiAgentRightSidebarFiles",
          component: () => import("./components/layout/AgentWorkspacePanel.vue"),
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
