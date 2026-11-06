import { createApp } from 'vue';
import FloatingVue from 'floating-vue';
import 'floating-vue/dist/style.css';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';
import { router } from './router';
import { initializeTheme } from './composables/theme';
import { i18n, initializeLanguage } from './i18n';

async function startApp(): Promise<void> {
  initializeTheme();
  initializeLanguage();
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);
  app.use(i18n);

  app.use(router);
  app.use(FloatingVue);
  app.mount('#app');
}

void startApp();
