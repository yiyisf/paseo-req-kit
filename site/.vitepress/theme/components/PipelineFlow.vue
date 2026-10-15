<script setup lang="ts">
import { ref } from "vue";

const activeTab = ref<"all" | "dev" | "verify">("all");

interface StepItem {
  id: string;
  name: string;
  role: "builder" | "reviewer" | "gate";
  roleName: string;
  output: string;
  desc: string;
  extra?: string;
}

const devSteps: StepItem[] = [
  {
    id: "design",
    name: "方案设计",
    role: "builder",
    roleName: "实现者 (builder)",
    output: "design.md",
    desc: "分析需求，编写技术方案；开启方案提案时先由几个 agent 各提一份",
  },
  {
    id: "design-review",
    name: "方案审核 ⇄ 确认",
    role: "reviewer",
    roleName: "检查者 ⇄ 需求方",
    output: "design-review.md, preview.md",
    desc: "独立模型审核方案；界面变动时生成 preview.md，写代码之前请你确认",
    extra: "界面改动开工前确认",
  },
  {
    id: "implement",
    name: "代码实现 (切片)",
    role: "builder",
    roleName: "实现者 (builder)",
    output: "代码、implementation.md",
    desc: "编写代码；适合时用 TDD；标准档方案若拆分了切片则逐片实现，每片一个新的 agent",
  },
  {
    id: "code-review",
    name: "代码评审 ⇄ 修复",
    role: "reviewer",
    roleName: "检查者 (reviewer)",
    output: "code-review.md",
    desc: "规格评审和规范评审并行，再汇总；开启评审小组时由小组成员并行，发现问题返工修复",
    extra: "双轴并行评审",
  },
  {
    id: "handoff",
    name: "提测说明",
    role: "builder",
    roleName: "实现者 (builder)",
    output: "handoff.md",
    desc: "研发阶段最后一步：列出改动范围、启动方法、自测证据、测试建议与准备",
  },
];

const verifySteps: StepItem[] = [
  {
    id: "service-start",
    name: "服务启动",
    role: "builder",
    roleName: "实现者 (builder)",
    output: "service-start.md",
    desc: "项目有常驻服务、档位开启时，按配置启动依赖服务与端口并检查状态",
  },
  {
    id: "verify",
    name: "功能验证",
    role: "reviewer",
    roleName: "检查者 (reviewer)",
    output: "verification.md",
    desc: "按验收标准逐条核对，给出真实命令输出或截图等证据，不改产品代码",
  },
  {
    id: "defect-fix",
    name: "缺陷修复 ⇄ 复验",
    role: "builder",
    roleName: "实现者 ⇄ 检查者",
    output: "verification.md",
    desc: "验证发现缺陷时原地修复并复验；或记录缺陷退回研发阶段，最多 3 轮",
    extra: "最多 3 轮",
  },
  {
    id: "report",
    name: "完成报告",
    role: "builder",
    roleName: "总结输出",
    output: "report.md",
    desc: "从严判定：所有验收标准都有通过证据才能判定完成，遗留问题如实记录",
  },
];

const selectedStep = ref<StepItem>(devSteps[0]);
</script>

<template>
  <div class="pf-container">
    <!-- Header Controls -->
    <div class="pf-header">
      <div class="pf-legend">
        <span class="pf-legend-item"><span class="dot builder"></span> 实现者 (builder)</span>
        <span class="pf-legend-item"><span class="dot reviewer"></span> 检查者 (reviewer)</span>
        <span class="pf-legend-item"><span class="dot gate"></span> 阶段闸口</span>
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
          <span class="tag">方案设计到提测说明</span>
        </div>
        <div class="pf-steps">
          <div
            v-for="s in devSteps"
            :key="s.id"
            class="pf-step-card"
            :class="[s.role, { active: selectedStep.id === s.id }]"
            @click="selectedStep = s"
          >
            <div class="pf-card-head">
              <span class="pf-card-badge">{{ s.roleName.split(' ')[0] }}</span>
              <span v-if="s.extra" class="pf-card-extra">{{ s.extra }}</span>
            </div>
            <div class="pf-card-name">{{ s.name }}</div>
            <div class="pf-card-file">📄 {{ s.output }}</div>
          </div>
        </div>
      </div>

      <!-- Stage Gate -->
      <div v-if="activeTab === 'all'" class="pf-gate-node">
        <div class="gate-icon">⚖️</div>
        <div class="gate-title">阶段闸口</div>
        <div class="gate-desc">分阶段模式停下<br>等待提测与验证</div>
      </div>

      <!-- Verify Phase -->
      <div v-if="activeTab === 'all' || activeTab === 'verify'" class="pf-group verify-group">
        <div class="pf-group-title">
          <span class="title-text">测试验证阶段</span>
          <span class="tag">独立验证到完成报告</span>
        </div>
        <div class="pf-steps">
          <div
            v-for="s in verifySteps"
            :key="s.id"
            class="pf-step-card"
            :class="[s.role, { active: selectedStep.id === s.id }]"
            @click="selectedStep = s"
          >
            <div class="pf-card-head">
              <span class="pf-card-badge">{{ s.roleName.split(' ')[0] }}</span>
              <span v-if="s.extra" class="pf-card-extra">{{ s.extra }}</span>
            </div>
            <div class="pf-card-name">{{ s.name }}</div>
            <div class="pf-card-file">📄 {{ s.output }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Active Step Detail Preview -->
    <div class="pf-detail">
      <div class="pf-detail-title">
        <span class="name">{{ selectedStep.name }}</span>
        <span class="role-chip" :class="selectedStep.role">{{ selectedStep.roleName }}</span>
      </div>
      <p class="pf-detail-desc">{{ selectedStep.desc }}</p>
      <div class="pf-detail-meta">
        <div class="meta-item"><strong>产物：</strong><code>{{ selectedStep.output }}</code></div>
        <div v-if="selectedStep.extra" class="meta-item"><strong>特点：</strong>{{ selectedStep.extra }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pf-container {
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  padding: 20px;
  margin: 24px 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.03);
}

.pf-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 18px;
  padding-bottom: 14px;
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
  gap: 4px;
  background: var(--vp-c-bg);
  padding: 3px;
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
  gap: 14px;
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
  padding: 14px;
}

.pf-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.title-text {
  font-weight: 700;
  font-size: 14px;
}

.tag {
  font-size: 11px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  padding: 2px 6px;
  border-radius: 4px;
}

.pf-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pf-step-card {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  cursor: pointer;
  transition: all 0.2s ease;
}

.pf-step-card:hover {
  transform: translateY(-1px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.04);
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
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}

.pf-card-file {
  font-size: 12px;
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
}

.pf-card-extra {
  font-size: 10px;
  color: var(--rk-warn);
}

.pf-gate-node {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  background: var(--rk-gate-bg);
  border: 1px dashed var(--rk-gate);
  border-radius: 10px;
  padding: 14px 12px;
}

.gate-icon {
  font-size: 22px;
  margin-bottom: 4px;
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
  margin-top: 16px;
  padding: 14px 18px;
  background: var(--vp-c-bg);
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
}

.pf-detail-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.pf-detail-title .name {
  font-size: 15px;
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
  font-size: 13px;
  color: var(--vp-c-text-1);
  margin: 0 0 8px;
  line-height: 1.6;
}

.pf-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.pf-detail-meta code {
  font-size: 12px;
  color: var(--vp-c-brand-1);
}
</style>
