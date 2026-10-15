<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";
import PaseoSimWindow from "./PaseoSimWindow.vue";
import PipelineFlow from "./PipelineFlow.vue";
import ProblemCompare from "./ProblemCompare.vue";

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
    text: "在 Paseo 中输入 /req 和一句话。AI 先复述理解，结构化访谈明确细节与异常，独立审阅后生成规范需求说明（spec.md）。",
  },
  {
    no: "02",
    title: "后台 Agent 开发",
    icon: "⚡",
    text: "方案设计、方案审核、代码实现、交叉评审与修复由独立 Agent 协作完成。每一步作为子 Agent 挂载在主对话中，实时透明可见。",
  },
  {
    no: "03",
    title: "提测与独立验证",
    icon: "🛡️",
    text: "研发完成自动生成 handoff.md 提测说明。可自动拉起服务执行验证，也可在闸口停下通知测试同事接手或部署指定测试环境。",
  },
  {
    no: "04",
    title: "如实报告与逐条验收",
    icon: "📋",
    text: "生成附带完整执行证据的验收报告。AI 带你按验收标准逐条核对确认。只做本地安全提交，合并与上线由人最终把控。",
  },
];
</script>

<template>
  <div class="rk-home">
    <!-- Live Interactive Experience Preview -->
    <section class="rk-section">
      <div class="section-badge">实时交互演示</div>
      <h2 class="rk-title">不仅是对话，更是端到端交付工作台</h2>
      <p class="rk-lead">体验非专职开发同事如何在 Paseo 中通过一句简单指令，驱动后台多 Agent 流水线协同作业：</p>
      <PaseoSimWindow />
    </section>

    <!-- Four Stages with visual flair -->
    <section class="rk-section">
      <div class="section-badge">端到端闭环</div>
      <h2 class="rk-title">一个需求，四个阶段</h2>
      <p class="rk-lead">你负责把需求讲清楚并做最后验收，中间所有繁琐的方案、编码、代码审查与证据收集全部交给 Agent：</p>
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
      <div class="section-badge">多 Agent 严谨分工</div>
      <h2 class="rk-title">做检分离的后台流水线</h2>
      <p class="rk-lead">
        实现（Builder）与评审（Reviewer）各司其职，步骤之间只通过功能目录中的规范文件交接，不依赖模糊上下文；任何审核不通过均触发受控返工：
      </p>
      <PipelineFlow />
      <p class="rk-more"><a :href="withBase('/guide/how-it-works')">深入了解流水线工作原理 →</a></p>
    </section>

    <!-- Problem & Solution Comparison -->
    <section class="rk-section">
      <div class="section-badge">为什么需要体系</div>
      <h2 class="rk-title">告别单 Agent 的偷懒与失控</h2>
      <p class="rk-lead">直接让单一编码模型“去写个功能”，往往面临理解偏差、自圆其说、虚假通过等隐患。req-kit 从机制上彻底解决这些痛点：</p>
      <ProblemCompare />
    </section>

    <!-- Installation Terminal -->
    <section class="rk-section">
      <div class="section-badge">一键起步</div>
      <h2 class="rk-title">一键安装与升级</h2>
      <p class="rk-lead">在运行 Paseo daemon 的机器上执行对应命令，自动完成环境检测、核心引擎安装与 Agent Skill 注册：</p>
      
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
      
      <p class="rk-more"><a :href="withBase('/guide/getting-started')">查阅详细 15 分钟快速入门指南 →</a></p>
    </section>

    <!-- Final Call to Action -->
    <section class="rk-section rk-cta">
      <div class="cta-card">
        <h2 class="cta-title">给测试、产品、项目经理用的需求开发体系</h2>
        <p class="cta-desc">不用读深奥的代码，也能把一个想法从“我想要……”扎实推进到“通过全部验收并交付”。所有成果物公开透明留在你的仓库中。</p>
        <div class="rk-cta-actions">
          <a class="rk-button brand" :href="withBase('/guide/getting-started')">立即开始使用</a>
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
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 3px 10px;
  border-radius: 9999px;
  margin-bottom: 12px;
}

.rk-title {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.3;
  margin: 0;
  border: none;
}
@media (min-width: 640px) {
  .rk-title { font-size: 32px; }
}

.rk-lead {
  margin: 12px 0 0;
  max-width: 780px;
  font-size: 15px;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}

/* Four Stages Grid */
.rk-stages {
  display: grid;
  gap: 18px;
  margin-top: 28px;
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
  border-radius: 14px;
  padding: 24px 20px;
  background: var(--vp-c-bg-soft);
  transition: all 0.25s ease;
  display: flex;
  flex-direction: column;
}

.rk-stage:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.06);
}

.rk-stage-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.rk-stage-icon {
  font-size: 24px;
}

.rk-no {
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  font-weight: 800;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 2px 8px;
  border-radius: 6px;
}

.rk-stage h3 {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 700;
}

.rk-stage p {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.rk-more {
  margin-top: 18px;
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
  margin-top: 24px;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  background: #18181b;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
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
  width: 11px;
  height: 11px;
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
  padding: 20px;
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
  padding: 6px 14px;
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
  margin: 12px 0 0;
  font-size: 12px;
  color: #a1a1aa;
}

/* Call to Action */
.rk-cta {
  padding-top: 80px;
}

.cta-card {
  padding: 48px 32px;
  border-radius: 20px;
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.08) 0%, rgba(6, 182, 212, 0.08) 100%);
  border: 1px solid var(--vp-c-brand-soft);
  text-align: center;
}

.cta-title {
  font-size: 26px;
  font-weight: 800;
  margin: 0;
}
@media (min-width: 640px) {
  .cta-title { font-size: 30px; }
}

.cta-desc {
  max-width: 680px;
  margin: 14px auto 28px;
  font-size: 15px;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}

.rk-cta-actions {
  display: flex;
  justify-content: center;
  gap: 16px;
  flex-wrap: wrap;
}

.rk-button {
  padding: 10px 22px;
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
