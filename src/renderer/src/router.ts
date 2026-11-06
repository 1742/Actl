import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { aiRoutes } from './agent/router';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/ai' },
  { path: '/index.html', redirect: '/ai' },
  aiRoutes,
  { path: '/compatibility', component: () => import('./CompatibilityView.vue') },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
