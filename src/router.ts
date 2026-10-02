import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { aiRoutes } from './agent/router';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/ai' },
  { path: '/index.html', redirect: '/ai' },
  aiRoutes,
];

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});
