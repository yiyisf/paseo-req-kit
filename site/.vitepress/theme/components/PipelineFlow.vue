<script setup lang="ts">
import { ref } from "vue";

const activeTab = ref<"all" | "dev" | "verify">("all");

interface StepItem {
  no: string;
  name: string;
  role: "builder" | "reviewer" | "gate";
  roleName: string;
  output: string;
  desc: string;
  extra?: string;
}

const devSteps: StepItem[] = [
  {
    no: "01",
    name: "方案设计",
    role: "builder",
    roleName: "Builder (实现者)",
    output: "design.md",
    desc: "深入分析需求，制定技术方案与模块拆解；可配置多个模型并行提案对比",
  },
  {
    no: "02",
    name: "方案审核 ⇄ 确认",
    role: "reviewer",
    roleName: "Reviewer ⇄ 你",
    output: "design-review.md, preview.md",
    desc: "独立模型审核方案；界面变动时生成 preview.md，请你在编码前确认预期效果",
    extra: "界面改动提前确认",
  },
  {
    no: "03",
    name: "代码实现 (切片)",
    role: "builder",
    roleName: "Builder (实现者)",
    output: "代码、implementation.md",
    desc: "按方案编写代码；支持 TDD 驱动；标准档大方案自动拆分切片（slices）逐片实现",
  },
  {
    no: "04",
    name: "双轴代码评审 ⇄ 修复",
    role: "reviewer",
    roleName: "Reviewer (检查者)",
    output: "code-review.md",
    desc: "规格评审与规范评审双轴并行；支持专家评审小组会审，发现缺陷闭环修复",
    extra: "双轴并行评审",
  },
  {
    no: "05",
    name: "提测说明",
    role: "builder",
    roleName: "Builder (实现者)",
    output: "handoff.md",
    desc: "研发完成交付：明确改动范围、启动方法、自测证据、测试建议与注意事项",
  },
];

const verifySteps: StepItem[] = [
  {
    no: "06",
    name: "服务启动",
    role: "builder",
    roleName: "Builder (实现者)",
    output: "service-start.md",
    desc: "按项目配置拉起依赖服务与前后台端口，并进行健康探测",
  },
  {
    no: "07",
    name: "功能验证",
    role: "reviewer",
    roleName: "Reviewer (检查者)",
    output: "verification.md",
    desc: "由独立检查者按需求说明中的验收标准逐条执行，必须提供执行证据，不改产品代码",
  },
  {
    no: "08",
    name: "缺陷修复 ⇄ 复验",
    role: "builder",
    roleName: "Builder ⇄ Reviewer",
    output: "verification.md",
    desc: "验证发现问题当场修复并复验；或记录为缺陷退回研发，保证闭环",
    extra: "最多 3 轮",
  },
  {
    no: "09",
    name: "完成报告",
    role: "builder",
    roleName: "总结输出",
    output: "report.md",
    desc: "从严汇总：所有验收标准必须有证据支持才能判定完成，遗留问题如实披露",
  },
];

const selectedStep = ref<StepItem>(devSteps[0]);
</script>

<template>
  <div class="pf-container">
    <!-- Header Controls -->
    <div class="pf-header">
      <div class="pf-legend">
        <span class="pf-legend-item"><span class="dot builder"></span> Builder (做事/实现)</span>
        <span class="pf-legend-item"><span class="dot reviewer"></span> Reviewer (独立检查/把关)</span>
        <span class="pf-legend-item"><span class="dot gate"></span> 闸口 (阶段交接)</span>
      </div>
      <div class="pf-tabs">
        <button :class="{ active: activeTab === 'all' }" @click="activeTab = 'all'">全流程</button>
        <button :class="{ active: activeTab === 'dev' }" @click="activeTab = 'dev'">研发阶段</button>
        <button :class="{ active: activeTab === 'verify' }" @click="activeTab = 'verify'">测试验证阶段</button>
      </div>
    </div>

    <!-- Pipeline Visual Track -->
    <div class="pf-flow">
      <!-- Dev Phase -->
      <div v-if="activeTab === 'all' || activeTab === 'dev'" class="pf-group dev-group">
        <div class="pf-group-title">
          <span class="title-text">研发阶段</span>
          <span class="tag">方案设计到交付提测</span>
        </div>
        <div class="pf-steps">
          <div
            v-for="s in devSteps"
            :key="s.no"
            class="pf-step-card"
            :class="[s.role, { active: selectedStep.no === s.no }]"
            @click="selectedStep = s"
          >
            <div class="pf-card-head">
              <span class="pf-card-no">{{ s.no }}</span>
              <span class="pf-card-badge">{{ s.roleName.split(' ')[0] }}</span>
            </div>
            <div class="pf-card-name">{{ s.name }}</div>
            <div class="pf-card-file">📄 {{ s.output }}</div>
            <div v-if="s.extra" class="pf-card-extra">{{ s.extra }}</div>
          </div>
        </div>
      </div>

      <!-- Stage Gate -->
      <div v-if="activeTab === 'all'" class="pf-gate-node">
        <div class="gate-icon">⚖️</div>
        <div class="gate-title">阶段闸口</div>
        <div class="gate-desc">分阶段模式停下<br>等待提测确认</div>
      </div>

      <!-- Verify Phase -->
      <div v-if="activeTab === 'all' || activeTab === 'verify'" class="pf-group verify-group">
        <div class="pf-group-title">
          <span class="title-text">测试验证阶段</span>
          <span class="tag">独立验证与结论报告</span>
        </div>
        <div class="pf-steps">
          <div
            v-for="s in verifySteps"
            :key="s.no"
            class="pf-step-card"
            :class="[s.role, { active: selectedStep.no === s.no }]"
            @click="selectedStep = s"
          >
            <div class="pf-card-head">
              <span class="pf-card-no">{{ s.no }}</span>
              <span class="pf-card-badge">{{ s.roleName.split(' ')[0] }}</span>
            </div>
            <div class="pf-card-name">{{ s.name }}</div>
            <div class="pf-card-file">📄 {{ s.output }}</div>
            <div v-if="s.extra" class="pf-card-extra">{{ s.extra }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Active Step Detail Preview -->
    <div class="pf-detail">
      <div class="pf-detail-title">
        <span class="no">{{ selectedStep.no }}</span>
        <span class="name">{{ selectedStep.name }}</span>
        <span class="role-chip" :class="selectedStep.role">{{ selectedStep.roleName }}</span>
      </div>
      <p class="pf-detail-desc">{{ selectedStep.desc }}</p>
      <div class="pf-detail-meta">
        <div class="meta-item"><strong>产物交付：</strong><code>{{ selectedStep.output }}</code></div>
        <div v-if="selectedStep.extra" class="meta-item"><strong>执行限制：</strong>{{ selectedStep.extra }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pf-container {
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
  padding: 24px;
  margin: 28px 0;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
}

.pf-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.pf-legend {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.pf-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.dot.builder { background-color: var(--rk-builder); }
.dot.reviewer { background-color: var(--rk-reviewer); }
.dot.gate { background-color: var(--rk-gate); }

.pf-tabs {
  display: flex;
  gap: 6px;
  background: var(--vp-c-bg);
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
}

.pf-tabs button {
  padding: 4px 12px;
  font-size: 13px;
  border-radius: 6px;
  color: var(--vp-c-text-2);
  transition: all 0.2s ease;
}

.pf-tabs button.active {
  background: var(--vp-c-brand-1);
  color: #fff;
  font-weight: 600;
}

.pf-flow {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

@media (min-width: 960px) {
  .pf-flow {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: stretch;
  }
}

.pf-group {
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 16px;
}

.pf-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.title-text {
  font-weight: 700;
  font-size: 15px;
}

.tag {
  font-size: 11px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  padding: 2px 8px;
  border-radius: 4px;
}

.pf-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pf-step-card {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  cursor: pointer;
  transition: all 0.2s ease;
}

.pf-step-card:hover {
  transform: translateY(-2px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.pf-step-card.active {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.pf-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  margin-bottom: 4px;
}

.pf-card-no {
  font-family: var(--vp-font-family-mono);
  font-weight: 700;
  color: var(--vp-c-text-3);
}

.pf-card-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
}

.builder .pf-card-badge {
  color: var(--rk-builder);
  background: var(--rk-builder-bg);
}

.reviewer .pf-card-badge {
  color: var(--rk-reviewer);
  background: var(--rk-reviewer-bg);
}

.pf-card-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.pf-card-file {
  font-size: 12px;
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
}

.pf-card-extra {
  font-size: 11px;
  color: var(--rk-warn);
  margin-top: 4px;
}

.pf-gate-node {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  background: var(--rk-gate-bg);
  border: 1px dashed var(--rk-gate);
  border-radius: 12px;
  padding: 16px 14px;
}

.gate-icon {
  font-size: 24px;
  margin-bottom: 6px;
}

.gate-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--rk-gate);
}

.gate-desc {
  font-size: 11px;
  color: var(--vp-c-text-2);
  margin-top: 4px;
  line-height: 1.4;
}

.pf-detail {
  margin-top: 18px;
  padding: 16px 20px;
  background: var(--vp-c-bg);
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
}

.pf-detail-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.pf-detail-title .no {
  font-family: var(--vp-font-family-mono);
  font-weight: 800;
  color: var(--vp-c-brand-1);
}

.pf-detail-title .name {
  font-size: 16px;
  font-weight: 700;
}

.role-chip {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-weight: 600;
}

.role-chip.builder {
  color: var(--rk-builder);
  background: var(--rk-builder-bg);
}

.role-chip.reviewer {
  color: var(--rk-reviewer);
  background: var(--rk-reviewer-bg);
}

.pf-detail-desc {
  font-size: 14px;
  color: var(--vp-c-text-1);
  margin: 0 0 10px;
  line-height: 1.6;
}

.pf-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.pf-detail-meta code {
  font-size: 12px;
  color: var(--vp-c-brand-1);
}
</style>
