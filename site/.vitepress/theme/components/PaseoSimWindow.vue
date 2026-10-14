<script setup lang="ts">
import { ref } from "vue";

const activeStep = ref(0);

const steps = [
  {
    title: "1. 澄清需求",
    userMsg: "/req 登录页增加短信验证码登录",
    aiReply: "收到。我理解您希望用户能够使用手机短信验证码登录。在生成需求说明前，我有 1 个关键细节需要和您确认：\n\n• 验证码有效期设置多长合适？\n  A. 5 分钟 (推荐：兼顾安全性与用户输入时间)\n  B. 10 分钟\n  C. 15 分钟",
    statusBadge: "需求访谈中",
    pipelineState: "准备中",
    agentName: "req-alignment",
    filePreview: "alignment.md: 访谈记录已保存",
  },
  {
    title: "2. 独立审阅与确认",
    userMsg: "选择 A，按推荐的 5 分钟",
    aiReply: "已记录。已生成初始需求说明 spec.md。\n正在由独立的审阅模型进行需求完备性检查...\n\n✓ 独立审阅已通过：验收标准明确，包含频次限制及异常重试规则。\n请您核对验收标准，输入确认以启动后台开发。",
    statusBadge: "待用户确认",
    pipelineState: "spec.md 就绪",
    agentName: "spec-reviewer",
    filePreview: "spec.md: 包含 6 条验收标准与非功能要求",
  },
  {
    title: "3. 后台流水线并行作业",
    userMsg: "确认，开始开发",
    aiReply: "已为您启动后台流水线引擎！\n\n子 Agent 已挂载到当前对话：\n• [方案设计] Claude Code 正在设计系统架构与表结构\n• [方案审核] Codex 独立交叉审查\n• [代码实现] 编写短信网关接入并运行 TDD 测试\n\n您可以随时切换子 Agent 查看执行日志。",
    statusBadge: "流水线运行中",
    pipelineState: "阶段 1/2: 研发进行中",
    agentName: "builder & reviewer",
    filePreview: "design.md, implementation.md, code-review.md",
  },
  {
    title: "4. 从严验证与完工报告",
    userMsg: "查看最新进展",
    aiReply: "流水线全部步骤已完成！\n\n【验收结论】全部完成，可以验收。\n• 验收标准 1-6：全部通过并附带 curl 证据与终端录屏\n• 代码变更：已在本地提交 3 个 commit，无多余未暂存改动\n• 完整报告已生成：docs/features/20261012-sms-login/report.md",
    statusBadge: "可验收",
    pipelineState: "阶段 2/2: 验证完毕",
    agentName: "report-summarizer",
    filePreview: "report.md: 交付报告，支持人工最终核对",
  },
];
</script>

<template>
  <div class="sim-wrapper">
    <div class="sim-container">
      <!-- Window Titlebar -->
      <div class="sim-titlebar">
        <div class="sim-traffic-lights">
          <span class="light red"></span>
          <span class="light yellow"></span>
          <span class="light green"></span>
        </div>
        <div class="sim-window-title">
          <span class="app-icon">⚡</span> Paseo 会话体验：从一句话到完整功能交付
        </div>
        <div class="sim-step-tabs">
          <button
            v-for="(s, idx) in steps"
            :key="idx"
            :class="{ active: activeStep === idx }"
            @click="activeStep = idx"
          >
            {{ s.title }}
          </button>
        </div>
      </div>

      <!-- Main Window Body -->
      <div class="sim-body">
        <!-- Left: Chat View -->
        <div class="sim-chat-pane">
          <div class="chat-header">
            <div class="chat-meta">
              <span class="dot-live"></span>
              <strong># 对话会话</strong> · <code>[20261012-sms-login]</code>
            </div>
            <span class="badge-status">{{ steps[activeStep].statusBadge }}</span>
          </div>

          <div class="chat-messages">
            <!-- User Bubble -->
            <div class="msg-row user">
              <div class="avatar">你</div>
              <div class="bubble user-bubble">
                {{ steps[activeStep].userMsg }}
              </div>
            </div>

            <!-- AI Bubble -->
            <div class="msg-row ai">
              <div class="avatar ai-avatar">AI</div>
              <div class="bubble ai-bubble">
                <pre class="bubble-text">{{ steps[activeStep].aiReply }}</pre>
              </div>
            </div>
          </div>

          <div class="chat-input-bar">
            <span class="prompt-icon">▸</span>
            <input type="text" placeholder="在 Paseo 中输入回复或指令..." disabled />
            <button class="send-btn" disabled>发送</button>
          </div>
        </div>

        <!-- Right: Pipeline Inspector -->
        <div class="sim-inspector-pane">
          <div class="inspector-header">
            <strong>后台 Agent 流水线树</strong>
            <span class="inspector-state">{{ steps[activeStep].pipelineState }}</span>
          </div>

          <div class="inspector-tree">
            <div class="tree-root">
              📁 docs/features/20261012-sms-login/
            </div>
            <ul class="tree-nodes">
              <li :class="{ highlight: activeStep >= 0 }">
                <span class="node-icon">{{ activeStep >= 0 ? '✓' : '○' }}</span>
                <span class="node-text">访谈与规格 (spec.md)</span>
              </li>
              <li :class="{ highlight: activeStep >= 1 }">
                <span class="node-icon">{{ activeStep >= 1 ? '✓' : '○' }}</span>
                <span class="node-text">独立模型审阅 (review)</span>
              </li>
              <li :class="{ highlight: activeStep >= 2 }">
                <span class="node-icon">{{ activeStep >= 2 ? '✓' : '○' }}</span>
                <span class="node-text">方案设计 & 审核 (design)</span>
              </li>
              <li :class="{ highlight: activeStep >= 2 }">
                <span class="node-icon">{{ activeStep >= 2 ? '✓' : '○' }}</span>
                <span class="node-text">代码实现 & 评审 (code)</span>
              </li>
              <li :class="{ highlight: activeStep >= 3 }">
                <span class="node-icon">{{ activeStep >= 3 ? '✓' : '○' }}</span>
                <span class="node-text">逐条功能验证 (verify)</span>
              </li>
              <li :class="{ highlight: activeStep >= 3 }">
                <span class="node-icon">{{ activeStep >= 3 ? '✓' : '○' }}</span>
                <span class="node-text">交付报告 (report.md)</span>
              </li>
            </ul>
          </div>

          <div class="file-card">
            <div class="file-card-label">当前活跃产物：</div>
            <code>{{ steps[activeStep].filePreview }}</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sim-wrapper {
  margin: 36px 0 48px;
}

.sim-container {
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
}

.sim-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-divider);
  flex-wrap: wrap;
  gap: 12px;
}

.sim-traffic-lights {
  display: flex;
  gap: 6px;
}

.light {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.light.red { background-color: #ff5f56; }
.light.yellow { background-color: #ffbd2e; }
.light.green { background-color: #27c93f; }

.sim-window-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  display: flex;
  align-items: center;
  gap: 6px;
}

.sim-step-tabs {
  display: flex;
  gap: 4px;
}

.sim-step-tabs button {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.2s ease;
}

.sim-step-tabs button:hover {
  color: var(--vp-c-text-1);
  background: rgba(125, 125, 125, 0.08);
}

.sim-step-tabs button.active {
  background: var(--vp-c-brand-1);
  color: #fff;
  font-weight: 600;
}

.sim-body {
  display: grid;
  grid-template-columns: 1fr;
}

@media (min-width: 900px) {
  .sim-body {
    grid-template-columns: 1.5fr 1fr;
  }
}

.sim-chat-pane {
  padding: 20px;
  border-bottom: 1px solid var(--vp-c-divider);
  display: flex;
  flex-direction: column;
}

@media (min-width: 900px) {
  .sim-chat-pane {
    border-bottom: none;
    border-right: 1px solid var(--vp-c-divider);
  }
}

.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.chat-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.dot-live {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 8px #10b981;
}

.badge-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.chat-messages {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 260px;
}

.msg-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  background: var(--vp-c-divider);
  color: var(--vp-c-text-1);
  flex-shrink: 0;
}

.ai-avatar {
  background: linear-gradient(135deg, var(--vp-c-brand-1), #06b6d4);
  color: #fff;
}

.bubble {
  border-radius: 12px;
  padding: 12px 16px;
  max-width: 88%;
}

.user-bubble {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-text-1);
  font-weight: 600;
  border: 1px solid rgba(37, 99, 235, 0.2);
}

.ai-bubble {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
}

.bubble-text {
  margin: 0;
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
}

.chat-input-bar {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
}

.prompt-icon {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.chat-input-bar input {
  flex: 1;
  background: transparent;
  border: none;
  font-size: 13px;
  color: var(--vp-c-text-1);
  outline: none;
}

.send-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--vp-c-divider);
  color: var(--vp-c-text-2);
}

/* Right Inspector Pane */
.sim-inspector-pane {
  padding: 20px;
  background: var(--vp-c-bg-soft);
  display: flex;
  flex-direction: column;
}

.inspector-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  margin-bottom: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.inspector-state {
  font-size: 11px;
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.inspector-tree {
  flex: 1;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}

.tree-root {
  font-weight: 700;
  margin-bottom: 10px;
  color: var(--vp-c-text-1);
}

.tree-nodes {
  list-style: none;
  padding-left: 18px;
  margin: 0;
  border-left: 1px dashed var(--vp-c-divider);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tree-nodes li {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vp-c-text-3);
  transition: all 0.2s ease;
}

.tree-nodes li.highlight {
  color: var(--vp-c-text-1);
  font-weight: 600;
}

.tree-nodes li.highlight .node-icon {
  color: #10b981;
}

.file-card {
  margin-top: 18px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
}

.file-card-label {
  font-size: 11px;
  color: var(--vp-c-text-3);
  margin-bottom: 4px;
}

.file-card code {
  font-size: 12px;
  color: var(--vp-c-brand-1);
  word-break: break-all;
}
</style>
