<script setup lang="ts">
import { ref } from "vue";

const activeMode = ref<"continuous" | "gated" | "develop-only">("continuous");

const modes = [
  {
    id: "continuous",
    name: "连续执行 (默认)",
    badge: "默认模式",
    tagline: "研发完成后不等待，直接启动本地服务并跑通自动化验证",
    fit: "适合本地能够完全闭环验证的前后端小需求或工具链开发",
    flow: [
      { name: "研发阶段", desc: "方案 ➜ 实现 ➜ 评审", state: "done" },
      { name: "闸口", desc: "自动放行", state: "auto" },
      { name: "测试验证", desc: "启动服务 ➜ 证据验证 ➜ 修复", state: "done" },
      { name: "完成报告", desc: "生成 report.md", state: "done" },
    ],
  },
  {
    id: "gated",
    name: "分阶段提测",
    badge: "测试环境/人工接手",
    tagline: "研发完成后停在闸口，生成提测说明，通知测试同事或等待测试环境准备",
    fit: "适合有专门测试人员、需要先部署测试环境、或需要准备特定测试数据的项目",
    flow: [
      { name: "研发阶段", desc: "方案 ➜ 实现 ➜ 提测说明", state: "done" },
      { name: "闸口", desc: "通知使用者/测试同事", state: "gate" },
      { name: "指定环境验证", desc: "本地服务 或 已部署环境", state: "done" },
      { name: "逐条验收", desc: "缺陷退回研发 或 闭环完成", state: "done" },
    ],
  },
  {
    id: "develop-only",
    name: "只做研发",
    badge: "测试由人完成",
    tagline: "写完提测说明和研发报告后结束，测试由人完成",
    fit: "适合测试必须完全由人工完成的场景",
    flow: [
      { name: "方案与评审", desc: "方案设计 ➜ 交叉评审", state: "done" },
      { name: "代码实现", desc: "代码落地 ➜ 单元测试", state: "done" },
      { name: "提测交付", desc: "详细 handoff.md 说明", state: "done" },
      { name: "线下测试", desc: "测试同事人工跟进", state: "manual" },
    ],
  },
];
</script>

<template>
  <div class="pm-box">
    <div class="pm-selector">
      <button
        v-for="m in modes"
        :key="m.id"
        class="pm-tab"
        :class="{ active: activeMode === m.id }"
        @click="activeMode = m.id as any"
      >
        <div class="tab-title">{{ m.name }}</div>
        <span class="tab-badge">{{ m.badge }}</span>
      </button>
    </div>

    <div v-for="m in modes" :key="m.id" v-show="activeMode === m.id" class="pm-content">
      <p class="pm-tagline">{{ m.tagline }}</p>
      
      <!-- Flow Diagram -->
      <div class="pm-track">
        <template v-for="(step, idx) in m.flow" :key="idx">
          <div class="pm-node" :class="step.state">
            <div class="node-title">{{ step.name }}</div>
            <div class="node-desc">{{ step.desc }}</div>
          </div>
          <div v-if="idx < m.flow.length - 1" class="pm-arrow">➜</div>
        </template>
      </div>

      <div class="pm-fit">
        <strong>💡 适用场景：</strong>{{ m.fit }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm-box {
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  padding: 20px;
  margin: 24px 0;
}

.pm-selector {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
  margin-bottom: 20px;
}

@media (min-width: 640px) {
  .pm-selector {
    grid-template-columns: repeat(3, 1fr);
  }
}

.pm-tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.pm-tab:hover {
  border-color: var(--vp-c-brand-1);
}

.pm-tab.active {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.tab-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.tab-badge {
  font-size: 11px;
  color: var(--vp-c-brand-1);
  margin-top: 4px;
  font-weight: 500;
}

.pm-content {
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 20px;
}

.pm-tagline {
  font-size: 14px;
  color: var(--vp-c-text-1);
  font-weight: 600;
  margin: 0 0 16px;
}

.pm-track {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 18px 0;
}

@media (min-width: 768px) {
  .pm-track {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

.pm-node {
  flex: 1;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  text-align: center;
}

.pm-node.done {
  border-color: var(--rk-builder);
  background: var(--rk-builder-bg);
}

.pm-node.gate {
  border-color: var(--rk-warn);
  background: var(--rk-warn-bg);
}

.pm-node.auto {
  border-color: var(--rk-gate);
  background: var(--rk-gate-bg);
}

.pm-node.manual {
  border-color: var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
}

.node-title {
  font-size: 13px;
  font-weight: 700;
}

.node-desc {
  font-size: 11px;
  color: var(--vp-c-text-2);
  margin-top: 4px;
}

.pm-arrow {
  display: none;
  color: var(--vp-c-text-3);
  font-size: 14px;
}

@media (min-width: 768px) {
  .pm-arrow {
    display: block;
  }
}

.pm-fit {
  margin-top: 14px;
  font-size: 13px;
  color: var(--vp-c-text-2);
  line-height: 1.6;
  border-top: 1px dashed var(--vp-c-divider);
  padding-top: 12px;
}
</style>
