<script setup lang="ts">
const items = [
  {
    title: "需求理解与对齐",
    problem: "直接给一句话就开工，AI 自行脑补细节，做出来的功能货不对板，大量返工",
    solution: "结构化访谈：一次一个问题，带选项与推荐；生成 spec.md 后由独立模型审阅，人核对后才开工",
  },
  {
    title: "代码实现与自检",
    problem: "同一个 Agent 既写代码又自己检查，自圆其说，严重的边界漏洞和业务缺陷被忽略",
    solution: "做检分离：Builder 编写代码，Reviewer 独立交叉评审；支持专家评审小组并行会审",
  },
  {
    title: "验收与验证标准",
    problem: "宣称“已全部做完”，实际上连服务都没跑起来，只写了几个空测试应付",
    solution: "从严验证：按验收标准逐条提供真实执行证据与终端输出，未验证的坚决标注“未验证”",
  },
  {
    title: "执行过程透明度",
    problem: "黑盒运行，一问到底卡在哪里毫无头绪，出了问题既无日志也无法追溯",
    solution: "会话透明挂载：每个步骤作为子 Agent 挂在主对话下，所有方案、评审、记录以文件形式留存",
  },
  {
    title: "长时间中断与恢复",
    problem: "运行中途断网或超时报错后前功尽弃，必须从第一步重新全量执行",
    solution: "状态持久化与断点续跑：运行状态落地 state.json，支持暂停、需求局部变更时仅增量重跑",
  },
];
</script>

<template>
  <div class="cmp-grid">
    <div v-for="(it, idx) in items" :key="idx" class="cmp-card">
      <div class="cmp-head">
        <span class="cmp-idx">0{{ idx + 1 }}</span>
        <h4 class="cmp-title">{{ it.title }}</h4>
      </div>
      <div class="cmp-body">
        <div class="cmp-col problem">
          <div class="cmp-label">
            <span class="icon">⚠️</span> 传统单 Agent 困境
          </div>
          <p class="cmp-text">{{ it.problem }}</p>
        </div>
        <div class="cmp-divider">
          <span class="arrow">➜</span>
        </div>
        <div class="cmp-col solution">
          <div class="cmp-label">
            <span class="icon">✨</span> req-kit 体系解法
          </div>
          <p class="cmp-text">{{ it.solution }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cmp-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 24px 0;
}

.cmp-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  padding: 18px 20px;
  transition: all 0.2s ease;
}

.cmp-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
}

.cmp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.cmp-idx {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.cmp-title {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  color: var(--vp-c-text-1);
}

.cmp-body {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

@media (min-width: 768px) {
  .cmp-body {
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 16px;
  }
}

.cmp-col {
  padding: 14px 16px;
  border-radius: 10px;
  height: 100%;
}

.cmp-col.problem {
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.cmp-col.solution {
  background: var(--vp-c-brand-soft);
  border: 1px solid var(--vp-c-brand-1);
}

.cmp-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
}

.cmp-col.problem .cmp-label {
  color: #ef4444;
}

.cmp-col.solution .cmp-label {
  color: var(--vp-c-brand-1);
}

.cmp-text {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  color: var(--vp-c-text-1);
}

.cmp-divider {
  display: none;
  justify-content: center;
  align-items: center;
  color: var(--vp-c-text-3);
  font-size: 16px;
}

@media (min-width: 768px) {
  .cmp-divider {
    display: flex;
  }
}
</style>
