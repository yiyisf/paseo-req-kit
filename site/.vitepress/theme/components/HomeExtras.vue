<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";
import PaseoSimWindow from "./PaseoSimWindow.vue";
import PipelineFlow from "./PipelineFlow.vue";

const installs = [
  {
    id: "unix",
    label: "macOS / Linux",
    command: "curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh",
    note: "也适用于 Windows 的 Git Bash、WSL。加 -s -- --beta 可安装 beta 版。",
  },
  {
    id: "windows",
    label: "Windows PowerShell",
    command: "irm https://paseo-req-kit.vercel.app/install.ps1 | iex",
    note: "不受 Windows 脚本执行策略拦截限制。",
  },
];
const active = ref(installs[0].id);
const copied = ref(false);
function copy(text: string) {
  navigator.clipboard?.writeText(text).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  });
}

const stages = [
  {
    no: "01",
    title: "对话对齐需求",
    icon: "💬",
    text: "在 Paseo 中输入 /req 和一句话。AI 先复述理解，一次问一个问题、给出选项和推荐，最后写成一份需求说明（spec.md）请你确认。",
  },
  {
    no: "02",
    title: "后台开发",
    icon: "⚡",
    text: "方案设计、方案审核、代码实现、代码评审、修复，由一组 agent 在后台完成。每一步都挂在你的对话下，可以随时点开看。",
  },
  {
    no: "03",
    title: "提测与验证",
    icon: "🛡️",
    text: "研发完成写好提测说明。可以接着自动验证，也可以停下来交给测试同事，在测试环境里验证。",
  },
  {
    no: "04",
    title: "逐条验收",
    icon: "📋",
    text: "收到结论和报告后，AI 按验收标准一条一条带你核对，记录结果。合并上线仍然由人决定。",
  },
];
</script>

<template>
  <div class="rk-home">
    <!-- Live Interactive Experience Preview -->
    <section class="rk-section">
      <div class="section-badge">流程示意</div>
      <h2 class="rk-title">对话与后台流水线协同示意</h2>
      <p class="rk-lead">在 Paseo 中用对话把需求谈清楚，后台由一组 agent 完成方案设计、实现、评审和验证：</p>
      <PaseoSimWindow />
    </section>

    <!-- Four Stages with visual flair -->
    <section class="rk-section">
      <div class="section-badge">四个阶段</div>
      <h2 class="rk-title">一个需求，四个阶段</h2>
      <p class="rk-lead">你负责把需求讲清楚和最后验收，中间的工作交给 agent：</p>
      <div class="rk-stages">
        <div v-for="s in stages" :key="s.no" class="rk-stage">
          <div class="rk-stage-top">
            <span class="rk-stage-icon">{{ s.icon }}</span>
            <span class="rk-no">{{ s.no }}</span>
          </div>
          <h3>{{ s.title }}</h3>
          <p>{{ s.text }}</p>
        </div>
      </div>
    </section>

    <!-- Comprehensive Pipeline Flow -->
    <section class="rk-section">
      <div class="section-badge">流水线</div>
      <h2 class="rk-title">后台流水线</h2>
      <p class="rk-lead">
        做事的和检查的是不同的 agent，每一步只看文件、不靠记忆；审核、评审、验证不通过就返工，遗留问题如实写进报告：
      </p>
      <PipelineFlow />
      <p class="rk-more"><a :href="withBase('/guide/how-it-works')">了解工作原理 →</a></p>
    </section>

    <!-- Installation Terminal -->
    <section class="rk-section">
      <div class="section-badge">安装</div>
      <h2 class="rk-title">安装与升级</h2>
      <p class="rk-lead">在运行 Paseo daemon 的机器上执行对应命令，自动检查环境、安装并配置 skill：</p>
      
      <div class="rk-terminal-box">
        <div class="terminal-bar">
          <div class="terminal-dots">
            <span class="t-dot t-red"></span>
            <span class="t-dot t-yellow"></span>
            <span class="t-dot t-green"></span>
          </div>
          <div class="terminal-tabs">
            <button
              v-for="i in installs"
              :key="i.id"
              :class="{ active: active === i.id }"
              @click="active = i.id"
            >
              {{ i.label }}
            </button>
          </div>
        </div>
        
        <div class="terminal-body">
          <template v-for="i in installs" :key="i.id">
            <div v-if="active === i.id" class="terminal-code-row">
              <span class="terminal-prompt">$</span>
              <code class="terminal-cmd">{{ i.command }}</code>
              <button class="rk-copy-btn" :class="{ copied }" @click="copy(i.command)">
                {{ copied ? "✓ 已复制" : "复制命令" }}
              </button>
            </div>
            <p v-if="active === i.id" class="terminal-note">💡 {{ i.note }}</p>
          </template>
        </div>
      </div>
      
      <p class="rk-more"><a :href="withBase('/guide/getting-started')">快速开始 →</a></p>
    </section>

    <!-- Final Call to Action -->
    <section class="rk-section rk-cta">
      <div class="cta-card">
        <h2 class="cta-title">给测试、产品、项目经理用的需求开发体系</h2>
        <p class="cta-desc">不用读代码，也能把一个需求从“我想要……”推进到“可以验收”。每一步的产物都在仓库里，可以随时查看、亲自核对。</p>
        <div class="rk-cta-actions">
          <a class="rk-button brand" :href="withBase('/guide/getting-started')">开始使用</a>
          <a class="rk-button" :href="withBase('/guide/user')">阅读使用者指南</a>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rk-home {
  margin: 0 auto;
  max-width: 1200px;
  padding: 0 24px 120px;
}
@media (min-width: 640px) {
  .rk-home { padding: 0 36px 120px; }
}
@media (min-width: 960px) {
  .rk-home { padding: 0 48px 140px; }
}

.rk-section {
  padding-top: 72px;
}

.section-badge {
  display: inline-block;
  font-size: 12px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 3px 10px;
  border-radius: 9999px;
  margin-bottom: 12px;
}

.rk-title {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
  margin: 0;
  border: none;
}
@media (min-width: 640px) {
  .rk-title { font-size: 30px; }
}

.rk-lead {
  margin: 10px 0 0;
  max-width: 780px;
  font-size: 15px;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}

/* Four Stages Grid */
.rk-stages {
  display: grid;
  gap: 16px;
  margin-top: 24px;
  grid-template-columns: 1fr;
}
@media (min-width: 640px) {
  .rk-stages { grid-template-columns: repeat(2, 1fr); }
}
@media (min-width: 960px) {
  .rk-stages { grid-template-columns: repeat(4, 1fr); }
}

.rk-stage {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 22px 18px;
  background: var(--vp-c-bg-soft);
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
}

.rk-stage:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.05);
}

.rk-stage-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.rk-stage-icon {
  font-size: 22px;
}

.rk-no {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 2px 8px;
  border-radius: 6px;
}

.rk-stage h3 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}

.rk-stage p {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.rk-more {
  margin-top: 16px;
  font-size: 14px;
  font-weight: 600;
}
.rk-more a {
  color: var(--vp-c-brand-1);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: gap 0.2s ease;
}
.rk-more a:hover {
  gap: 8px;
}

/* Terminal Box */
.rk-terminal-box {
  margin-top: 20px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  background: #18181b;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.1);
}

.terminal-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  background: #27272a;
  border-bottom: 1px solid #3f3f46;
}

.terminal-dots {
  display: flex;
  gap: 6px;
}

.t-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.t-red { background: #ef4444; }
.t-yellow { background: #f59e0b; }
.t-green { background: #10b981; }

.terminal-tabs {
  display: flex;
  gap: 4px;
}

.terminal-tabs button {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  color: #a1a1aa;
  cursor: pointer;
  transition: all 0.2s ease;
}

.terminal-tabs button.active {
  background: #3f3f46;
  color: #fff;
  font-weight: 600;
}

.terminal-body {
  padding: 18px;
}

.terminal-code-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.terminal-prompt {
  color: #10b981;
  font-family: var(--vp-font-family-mono);
  font-weight: 700;
}

.terminal-cmd {
  flex: 1;
  color: #f4f4f5;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  word-break: break-all;
}

.rk-copy-btn {
  padding: 5px 12px;
  border-radius: 6px;
  background: #3b82f6;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.rk-copy-btn:hover {
  background: #2563eb;
}

.rk-copy-btn.copied {
  background: #10b981;
}

.terminal-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: #a1a1aa;
}

/* Call to Action */
.rk-cta {
  padding-top: 72px;
}

.cta-card {
  padding: 40px 28px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.06) 0%, rgba(6, 182, 212, 0.06) 100%);
  border: 1px solid var(--vp-c-brand-soft);
  text-align: center;
}

.cta-title {
  font-size: 24px;
  font-weight: 700;
  margin: 0;
}
@media (min-width: 640px) {
  .cta-title { font-size: 28px; }
}

.cta-desc {
  max-width: 680px;
  margin: 12px auto 24px;
  font-size: 14px;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}

.rk-cta-actions {
  display: flex;
  justify-content: center;
  gap: 14px;
  flex-wrap: wrap;
}

.rk-button {
  padding: 9px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  transition: all 0.2s ease;
}

.rk-button:hover {
  border-color: var(--vp-c-brand-1);
}

.rk-button.brand {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: #fff;
}

.rk-button.brand:hover {
  background: var(--vp-c-brand-2);
}
</style>
