<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CompatibilityReport } from '../../shared/compatibility';

const report = ref<CompatibilityReport>();
const running = ref(false);
const error = ref('');
const count = computed(() => report.value?.checks.filter((check) => check.status === 'passed').length ?? 0);

async function run() {
  if (running.value) return;
  running.value = true;
  error.value = '';
  try { report.value = await window.actl.runChecks(); }
  catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { running.value = false; }
}
</script>

<template>
  <main>
    <header><div class="brand"><span class="logo">A</span><strong>Actl</strong><span class="tag">Electron</span></div><span class="phase">迁移验证 · 01</span></header>
    <section class="intro">
      <div class="eyebrow">RUNTIME COMPATIBILITY</div>
      <h1>让核心能力，先跑起来。</h1>
      <p>验证 Electron 内部运行时能否承载旧版 Agent。所有操作使用独立测试数据。</p>
    </section>
    <section class="summary">
      <div><span class="status-dot" :class="{ passed: report?.passed && !error, failed: error || (report && !report.passed) }"></span><strong>{{ running ? '正在验证运行时…' : error ? '验证未完成' : report ? report.passed ? '运行时验证通过' : '发现兼容性问题' : '准备就绪' }}</strong><p>{{ report ? `${count} / ${report.checks.length} 项检查通过` : 'SQLite · 文件与凭据 · 日志 · Shell · MCP' }}</p></div>
      <button :disabled="running" @click="run">{{ running ? '验证中…' : report ? '重新验证' : '运行兼容性验证' }}<span v-if="!running">↗</span></button>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <section v-if="report" class="results" aria-live="polite">
      <article v-for="check in report.checks" :key="check.id">
        <span class="check-icon" :class="check.status">{{ check.status === 'passed' ? '✓' : '!' }}</span>
        <div><h2>{{ check.name }}</h2><p>{{ check.details }}</p></div>
        <span class="duration">{{ check.durationMs }} ms</span>
      </article>
      <article><span class="check-icon" :class="report.shutdown.acknowledged && report.shutdown.exitCode === 0 ? 'passed' : 'failed'">{{ report.shutdown.acknowledged && report.shutdown.exitCode === 0 ? '✓' : '!' }}</span><div><h2>运行时正常退出</h2><p>关闭确认 {{ report.shutdown.acknowledged ? '已收到' : '未收到' }} · 退出码 {{ report.shutdown.exitCode }}</p></div></article>
    </section>
    <section v-else class="architecture"><span>Vue 界面</span><i>↔</i><span>受限 Preload</span><i>↔</i><span>Electron 主进程</span><i>↔</i><span class="accent">Agent 内部进程</span></section>
    <footer v-if="report"><div>Electron {{ report.versions.electron }}<span>·</span>Node {{ report.versions.node }}<span>·</span>{{ report.versions.platform }} / {{ report.versions.arch }}<span>·</span>{{ report.packaged ? '安装包运行环境' : '源码构建运行环境' }}</div><p>{{ report.dataDirectory }}</p></footer>
    <footer v-else><div>一个安装包。独立进程。无业务服务端口。</div><p>这是迁移验证工程，完整聊天功能将在后续阶段接入。</p></footer>
  </main>
</template>
