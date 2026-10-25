<script setup lang="ts">
// The home page (design/guidelines/docs-site.md, mockup design/examples/home.html):
// hero on the aurora, the step track, the bento of capabilities, numbers, and the latest release.
import { computed, onMounted, ref } from "vue";
import { useData, withBase } from "vitepress";
import RkIcon from "./RkIcon.vue";

type Numbers = { version: string; beta: boolean; releases: number; stable: number; adrs: number };
const { theme } = useData();
const n = computed(() => theme.value.rk as Numbers);

// The scripts are served by whichever site this is (the public one, or a copy inside a company
// network), so the commands use its own address once the page is open.
const SITE = "https://paseo-req-kit.vercel.app";
const installs = ref([
  {
    id: "npx",
    label: "npx",
    command: "npx -y paseo-req-kit@latest install",
    note: "只需要 Node.js 22+。公司内网只有 npm 镜像时加 --registry=<镜像地址>（会保存为本机的 npm 源）；beta 版把 latest 换成 beta。",
  },
  {
    id: "unix",
    label: "macOS / Linux",
    command: `curl -fsSL ${SITE}/install.sh | sh`,
    note: "也适用于 Windows 的 Git Bash、WSL。加 -s -- --beta 安装 beta 版。",
  },
  {
    id: "windows",
    label: "Windows PowerShell",
    command: `irm ${SITE}/install.ps1 | iex`,
    note: "不受脚本执行策略限制。",
  },
]);
onMounted(() => {
  const here = `${window.location.origin}${withBase("/").replace(/\/$/, "")}`;
  if (here === SITE || !/^https?:/.test(here)) return;
  installs.value = installs.value.map((i) => ({ ...i, command: i.command.replace(SITE, here) }));
});
const active = ref("npx");
const current = computed(() => installs.value.find((i) => i.id === active.value) ?? installs.value[0]);
const copied = ref(false);
function copy() {
  navigator.clipboard?.writeText(current.value.command).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  });
}

// Lime marks the two steps where a person decides; the AI steps are indigo.
const track = [
  { icon: "messages-square", name: "对齐", who: "你和 AI 对话", person: true },
  { icon: "pen-tool", name: "方案", who: "AI 写，你确认" },
  { icon: "file-code", name: "实现", who: "AI，质量门把关" },
  { icon: "sparkles", name: "评审", who: "另一个模型" },
  { icon: "shield-check", name: "验证", who: "按验收标准" },
  { icon: "clipboard-check", name: "验收", who: "你逐条核对", person: true },
];
</script>

<template>
  <div class="rk-home">
    <div class="rk-aurora">
      <header class="wrap hero">
        <a class="rk-version" :href="withBase('/changelog')"><b>{{ n.version }}</b>{{ n.beta ? "beta" : "最新" }}</a>
        <h1>一句需求，到<span class="rk-grad">可验收的功能</span></h1>
        <p class="lead">在 Paseo 里用对话把需求谈清楚；一组 AI agent 在后台完成方案、实现、评审和验证；每个要拍板的地方都停下来等你。</p>
        <div class="rk-term">
          <div class="rk-term__tabs" role="tablist">
            <button
              v-for="i in installs"
              :key="i.id"
              type="button"
              role="tab"
              :aria-selected="active === i.id"
              :class="{ 'is-on': active === i.id }"
              @click="active = i.id"
            >
              {{ i.label }}
            </button>
          </div>
          <div class="rk-term__body">
            <i>$</i><code>{{ current.command }}</code>
            <button class="rk-btn rk-btn--ghost rk-btn--sm" type="button" :aria-label="copied ? '已复制' : '复制命令'" :title="copied ? '已复制' : '复制命令'" @click="copy">
              <RkIcon :name="copied ? 'check' : 'copy'" />
            </button>
          </div>
        </div>
        <p class="rk-cap note">{{ current.note }}</p>
        <div class="actions">
          <a class="rk-btn rk-btn--primary rk-btn--lg rk-btn--cta" :href="withBase('/guide/getting-started')">快速开始<RkIcon name="arrow-right" /></a>
          <a class="rk-btn rk-btn--lg" :href="withBase('/guide/')">req-kit 是什么</a>
        </div>
      </header>
    </div>

    <div class="wrap">
      <section class="flow" aria-label="一个需求怎么走">
        <ol class="rk-track">
          <li v-for="s in track" :key="s.name" :class="{ 'is-needs': s.person }">
            <span class="rk-track__dot" :class="{ ai: !s.person }"><RkIcon class="ic-sm" :name="s.icon" /></span>
            <b>{{ s.name }}</b>
            <span>{{ s.who }}</span>
          </li>
        </ol>
      </section>

      <section class="blk">
        <div class="rk-section">
          <span class="rk-eyebrow">Built for people who own the requirement</span>
          <h2>每一步都有人把关</h2>
          <p>测试、产品、项目经理不用写代码，也能把需求做到可验收：AI 做的事看得见，要你决定的事一目了然。</p>
        </div>
        <div class="rk-bento">
          <article class="rk-card rk-span-8">
            <span class="rk-card__label"><RkIcon class="ic-sm" name="messages-square" />对齐需求</span>
            <h3>一次一个问题，带选项和推荐</h3>
            <p>异常情况、权限、测试数据都会问到；确认前另一个模型独立审阅需求说明。</p>
            <div class="shot">
              <div class="bub">
                没有数据时，导出按钮怎么处理？
                <div class="opt"><span class="rk-chip">A 按钮置灰（推荐）</span><span class="rk-chip">B 导出空表</span><span class="rk-chip">C 隐藏按钮</span></div>
              </div>
              <div class="bub bub--me">A，置灰，鼠标放上去说明原因</div>
            </div>
          </article>
          <article class="rk-card rk-span-4">
            <span class="rk-card__label"><RkIcon class="ic-sm" name="pen-tool" />审查原型</span>
            <h3>在原型上点一点就能提意见</h3>
            <p>点要改的地方，选"大一点、换颜色、删掉"，用自己的话补一句，自动整理成修改清单。</p>
            <div class="rk-dots canvas">
              <span class="target">导出 Excel<span class="rk-pin">1</span></span>
            </div>
          </article>
          <article class="rk-card rk-span-4">
            <span class="rk-card__label rk-card__label--data"><RkIcon class="ic-sm" name="shield-check" />质量门</span>
            <h3>检查由程序来跑</h3>
            <p>lint、测试、构建在改动前后各跑一次，只拦新出现的失败，发回给写代码的 agent 修。</p>
          </article>
          <article class="rk-card rk-span-4">
            <span class="rk-card__label rk-card__label--ai"><RkIcon class="ic-sm" name="git-pull-request" />代码审查</span>
            <h3>AI 意见放在对应的行旁边</h3>
            <p>评审人标"要改 / 不用改"、写自己的意见；退回后流水线按意见修改，再评审、再验证。</p>
          </article>
          <article class="rk-card rk-span-4">
            <span class="rk-card__label"><RkIcon class="ic-sm" name="clipboard-check" />验收清单</span>
            <h3>逐条核对，一键试用</h3>
            <p>每条写着怎么操作、应该看到什么；在需求自己的工作区里把它跑起来再验。</p>
          </article>
          <article class="rk-card rk-span-12">
            <div class="row">
              <span class="rk-card__label danger"><RkIcon class="ic-sm" name="octagon-alert" />边界清楚</span>
              <span class="rk-cap">1.14 起默认打开</span>
            </div>
            <h3>推送、发布、连生产，都会被拦下来告诉你</h3>
            <p>流水线只做本地提交；agent 推送代码、发布制品、改集群、连其他机器的数据库时立即打断，并在对话里通知你。每个改代码的步骤之后扫描密钥，有疑似密钥的分支不会推送。</p>
            <div class="notice">【需求开发流水线通知】「实现」步骤里，agent 开始运行一条不允许的命令（推送到远程仓库），流水线已经打断了它：<br />git push origin HEAD:main</div>
          </article>
        </div>
      </section>

      <section class="blk" aria-label="数字">
        <div class="rk-bento">
          <div class="rk-stat rk-span-3"><b>{{ n.releases }}</b><strong>个版本</strong><span>{{ n.stable }} 个正式版，其余是 beta；每版写明升级须知</span></div>
          <div class="rk-stat rk-span-3"><b>240+</b><strong>项自动化测试</strong><span>Linux 和 Windows 都通过才发布</span></div>
          <div class="rk-stat rk-span-3"><b>{{ n.adrs }}</b><strong>份设计决定记录</strong><span>每个关键取舍都写明原因</span></div>
          <div class="rk-stat rk-span-3"><b>5</b><strong>种需求类型</strong><span>新需求、小改动、缺陷、重构、评估</span></div>
        </div>
      </section>

      <section class="blk latest">
        <span class="rk-eyebrow">Latest</span>
        <p>
          最新版本 <code>{{ n.version }}</code>：审查网页、Paseo 插件和这个文档站换上了 req-kit 的新设计。
          <a :href="withBase('/changelog')">看更新记录 →</a>
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.rk-home {
  --ground: var(--rk-canvas);
}
.wrap {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 24px;
}
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 20px;
  padding-top: 72px;
  padding-bottom: 64px;
}
.rk-version {
  text-decoration: none;
}
.hero h1 {
  margin: 0;
  font: var(--rk-type-display-xl);
  letter-spacing: -0.02em;
  text-wrap: balance;
  max-width: 880px;
  color: var(--rk-text-primary);
}
.lead {
  margin: 0;
  font: var(--rk-type-prose);
  color: var(--rk-text-secondary);
  max-width: 640px;
}
.rk-term__tabs {
  overflow-x: auto;
}
.rk-term__body code {
  background: none;
  padding: 0;
  font-size: inherit;
}
.note {
  margin: -8px 0 0;
  max-width: 600px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
}
.actions a {
  text-decoration: none;
}
.flow {
  padding: 8px 0 24px;
}
.flow .rk-track li {
  min-width: 110px;
}
/* An explanation, not progress: the line between the steps stays neutral. */
.flow .rk-track li::before {
  background: var(--rk-border-default) !important;
}
.rk-track__dot.ai {
  color: var(--rk-ai);
}
.blk {
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding-top: 72px;
}
.rk-section h2 {
  border: none;
  padding: 0;
}
.shot {
  border-radius: var(--rk-radius-lg);
  background: var(--rk-surface-1);
  border: 1px solid var(--rk-border-default);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
  line-height: 21px;
}
.bub {
  max-width: 88%;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--rk-surface-3);
}
.bub--me {
  align-self: flex-end;
  background: var(--rk-brand-tint);
}
.opt {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.canvas {
  border-radius: var(--rk-radius-lg);
  border: 1px solid var(--rk-border-default);
  padding: 28px 20px;
  display: grid;
  place-items: center;
  margin-top: auto;
}
.target {
  position: relative;
  padding: 6px 14px;
  border-radius: 6px;
  background: var(--rk-surface-3);
  font-size: 13px;
  font-weight: 600;
}
.target .rk-pin {
  top: -14px;
  right: -14px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rk-card__label.danger {
  background: var(--rk-failed-tint);
  color: var(--rk-status-failed);
}
.notice {
  font: 12.5px/20px var(--rk-font-mono);
  color: var(--rk-text-secondary);
  background: var(--rk-surface-1);
  border: 1px solid var(--rk-border-default);
  border-radius: var(--rk-radius-md);
  padding: 12px 14px;
  overflow-wrap: anywhere;
}
.latest {
  align-items: center;
  text-align: center;
  gap: 8px;
  padding-bottom: 24px;
}
.latest p {
  margin: 0;
  color: var(--rk-text-secondary);
}
.latest code {
  font-family: var(--rk-font-mono);
  color: var(--rk-text-primary);
}
.latest a {
  color: var(--rk-brand-text);
  font-weight: 600;
  text-decoration: none;
}
@media (max-width: 720px) {
  .hero {
    padding-top: 40px;
    padding-bottom: 40px;
  }
  .hero h1 {
    font-size: 36px;
    line-height: 44px;
  }
  .rk-section h2 {
    font-size: 28px;
    line-height: 36px;
  }
}
</style>
