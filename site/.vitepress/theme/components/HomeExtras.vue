<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";

const installs = [
  {
    id: "unix",
    label: "macOS / Linux",
    command: "curl -fsSL https://raw.githubusercontent.com/yiyisf/paseo-req-kit/main/install.sh | sh",
    note: "也适用于 Windows 的 Git Bash、WSL。加 -s -- --beta 安装 beta 版。",
  },
  {
    id: "windows",
    label: "Windows PowerShell",
    command: "irm https://raw.githubusercontent.com/yiyisf/paseo-req-kit/main/install.ps1 | iex",
    note: "不受脚本执行策略限制。",
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
    text: "输入 /req 和一句话。AI 先复述理解，再一次问一个问题、给出选项和推荐，最后写成一份需求说明请你确认。",
  },
  {
    no: "02",
    title: "后台开发",
    text: "方案设计、方案审核、代码实现、代码评审、修复，由一组 agent 在后台完成。每一步都挂在你的对话下，可以随时点开看。",
  },
  {
    no: "03",
    title: "提测与验证",
    text: "研发完成写好提测说明。可以接着自动验证，也可以停下来交给测试同事，在测试环境里验证。",
  },
  {
    no: "04",
    title: "逐条验收",
    text: "收到结论和报告后，AI 按验收标准一条一条带你核对，记录结果。合并上线仍然由人决定。",
  },
];

const develop = ["方案设计", "方案审核 ⇄ 修订", "代码实现", "代码评审 ⇄ 修复", "提测说明"];
const verify = ["服务启动", "功能验证", "缺陷修复 ⇄ 复验", "完成报告"];
</script>

<template>
  <div class="rk-home">
    <section class="rk-section">
      <h2 class="rk-title">一个需求，四个阶段</h2>
      <p class="rk-lead">你负责把需求讲清楚和最后验收，中间的工作交给 agent。</p>
      <div class="rk-stages">
        <div v-for="s in stages" :key="s.no" class="rk-stage">
          <div class="rk-no">{{ s.no }}</div>
          <h3>{{ s.title }}</h3>
          <p>{{ s.text }}</p>
        </div>
      </div>
    </section>

    <section class="rk-section">
      <h2 class="rk-title">流水线</h2>
      <p class="rk-lead">
        做事的和检查的是不同的 agent，每一步只看文件、不靠记忆；审核、评审、验证不通过就返工，轮数有上限，遗留问题如实写进报告。
      </p>
      <div class="rk-flow">
        <div class="rk-phase">
          <div class="rk-phase-name">研发阶段</div>
          <div class="rk-chips">
            <span v-for="s in develop" :key="s" class="rk-chip">{{ s }}</span>
          </div>
        </div>
        <div class="rk-gate" title="执行方式为“分阶段”时在这里停下，等待提测">
          <span>闸口</span>
          <small>连续 / 分阶段 / 只做研发</small>
        </div>
        <div class="rk-phase">
          <div class="rk-phase-name">测试验证阶段</div>
          <div class="rk-chips">
            <span v-for="s in verify" :key="s" class="rk-chip">{{ s }}</span>
          </div>
        </div>
      </div>
      <p class="rk-more"><a :href="withBase('/guide/how-it-works')">了解工作原理 →</a></p>
    </section>

    <section class="rk-section">
      <h2 class="rk-title">安装</h2>
      <p class="rk-lead">在运行 Paseo daemon 的机器上执行一条命令：检查环境、安装、装好 /req 等 skill、引导你选择 agent。再次运行即升级。</p>
      <div class="rk-install-box">
        <div class="rk-tabs" role="tablist">
          <button
            v-for="i in installs"
            :key="i.id"
            role="tab"
            :aria-selected="active === i.id"
            :class="{ active: active === i.id }"
            @click="active = i.id"
          >
            {{ i.label }}
          </button>
        </div>
        <template v-for="i in installs" :key="i.id">
          <div v-if="active === i.id" class="rk-command">
            <code>{{ i.command }}</code>
            <button class="rk-copy" :aria-label="copied ? '已复制' : '复制命令'" @click="copy(i.command)">{{ copied ? "已复制" : "复制" }}</button>
          </div>
          <p v-if="active === i.id" class="rk-note">{{ i.note }}</p>
        </template>
      </div>
      <p class="rk-more"><a :href="withBase('/guide/getting-started')">快速开始 →</a></p>
    </section>

    <section class="rk-section rk-cta">
      <h2 class="rk-title">给测试、产品、项目经理用的需求开发体系</h2>
      <p class="rk-lead">不用读代码，也能把一个需求从“我想要……”推进到“可以验收”。每一步的产物都在仓库里，可以随时查看、亲自核对。</p>
      <div class="rk-cta-actions">
        <a class="rk-button brand" :href="withBase('/guide/getting-started')">开始使用</a>
        <a class="rk-button" :href="withBase('/guide/user')">阅读使用者指南</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Same width as VitePress's feature grid above: a 1152px container inside the page padding. */
.rk-home {
  margin: 0 auto;
  max-width: 1280px;
  padding: 0 24px 96px;
}
@media (min-width: 640px) {
  .rk-home { padding: 0 48px 96px; }
}
@media (min-width: 960px) {
  .rk-home { padding: 0 64px 128px; }
}
.rk-section {
  padding-top: 72px;
}
.rk-title {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
  margin: 0;
  border: none;
}
.rk-lead {
  margin: 10px 0 0;
  max-width: 720px;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}
.rk-stages {
  display: grid;
  gap: 16px;
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
  border-radius: 12px;
  padding: 22px 22px 18px;
  background: var(--vp-c-bg-soft);
}
.rk-stage h3 {
  margin: 10px 0 6px;
  font-size: 17px;
  font-weight: 600;
}
.rk-stage p {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}
.rk-no {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}
.rk-flow {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 28px;
}
@media (min-width: 960px) {
  .rk-flow { flex-direction: row; align-items: stretch; }
}
.rk-phase {
  flex: 1;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 18px;
  background: var(--vp-c-bg-soft);
}
.rk-phase-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  margin-bottom: 12px;
}
.rk-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.rk-chip {
  font-size: 13px;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  white-space: nowrap;
}
.rk-gate {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px 18px;
  border-radius: 12px;
  border: 1px dashed var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  font-weight: 600;
  text-align: center;
}
.rk-gate small {
  font-weight: 400;
  font-size: 12px;
  color: var(--vp-c-text-2);
}
.rk-more {
  margin-top: 16px;
  font-size: 14px;
}
.rk-more a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}
.rk-install-box {
  margin-top: 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}
.rk-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 8px 0;
  border-bottom: 1px solid var(--vp-c-divider);
  overflow-x: auto;
}
.rk-tabs button {
  padding: 8px 14px;
  font-size: 14px;
  color: var(--vp-c-text-2);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.rk-tabs button.active {
  color: var(--vp-c-text-1);
  border-bottom-color: var(--vp-c-brand-1);
  font-weight: 600;
}
.rk-command {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 16px 4px;
}
.rk-command code {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font-size: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  color: var(--vp-c-text-1);
}
.rk-copy {
  flex-shrink: 0;
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}
.rk-copy:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.rk-note {
  margin: 8px 16px 16px;
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.rk-cta {
  text-align: center;
}
.rk-cta .rk-lead {
  margin-left: auto;
  margin-right: auto;
}
.rk-cta-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  margin-top: 24px;
}
.rk-button {
  display: inline-block;
  padding: 0 20px;
  line-height: 40px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--vp-button-alt-border);
  background: var(--vp-button-alt-bg);
  color: var(--vp-button-alt-text);
  text-decoration: none;
}
.rk-button.brand {
  border-color: var(--vp-button-brand-border);
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
}
</style>
