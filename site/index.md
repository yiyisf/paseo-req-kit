---
layout: home
title: req-kit
titleTemplate: 从一句需求，到可验收的功能

hero:
  name: req-kit
  text: 从一句需求，到可验收的功能
  tagline: 在 Paseo 中用对话把需求谈清楚，由一组 AI agent 在后台完成方案设计、代码实现、评审和验证，结果发回同一个对话。
  image:
    src: /logo.svg
    alt: req-kit
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: req-kit 是什么
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/yiyisf/paseo-req-kit

features:
  - icon:
      src: /icons/chat.svg
    title: 对话对齐需求
    details: 一次一个问题，给出选项和推荐；把异常情况、权限、测试数据都问到。确认前还会请另一个模型独立审阅需求说明。
  - icon:
      src: /icons/agents.svg
    title: 后台 agent 流水线
    details: 方案设计、实现、评审、验证、报告依次由不同的 agent 完成；缺陷先复现再修、重构先锁住行为、评估只调研不写代码，大需求按切片逐片实现。
  - icon:
      src: /icons/review.svg
    title: 质量门，如实报告
    details: 流水线自己运行项目的 lint、测试、构建，改坏了发回修复；做事的和检查的分开，结论只看结果文件和证据，遗留问题如实写进报告。
  - icon:
      src: /icons/phases.svg
    title: 分阶段提测
    details: 研发完成写好提测说明，可以停下来交给测试同事，在测试环境中验证；发现缺陷可以退回研发，修完再提测。
  - icon:
      src: /icons/paseo.svg
    title: 用好 Paseo
    details: 复用 Paseo 的 agent profile、paseo.json 服务和 worktree、定时任务与内置浏览器；几个需求可以并行，前后端分仓的需求可以作为联合需求，每个仓库一个工作区同时开发。
  - icon:
      src: /icons/safe.svg
    title: 安全边界清楚
    details: 只做本地提交，不合并、不推送、不上线；不连接生产环境，测试环境说明里只写口令在哪里取。
---
