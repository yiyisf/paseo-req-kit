// The prototype review page (req-kit 1.13). Plain JavaScript, no build step. The prototype is
// shown in a same-origin iframe in which nothing of its own runs (the server sends it with
// script-src 'none'); this page reads and marks it from outside.
(() => {
  "use strict";

  const WIDTHS = [
    { px: 1280, label: "电脑" },
    { px: 768, label: "平板" },
    { px: 390, label: "手机" },
  ];
  const KINDS = [
    { id: "text", label: "文字改成…" },
    { id: "bigger", label: "大一点" },
    { id: "smaller", label: "小一点" },
    { id: "color", label: "换颜色" },
    { id: "move", label: "换位置" },
    { id: "remove", label: "删掉" },
    { id: "add", label: "这里加东西" },
    { id: "other", label: "其他" },
  ];
  const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label.replace("…", "")]));
  const NOTE_HINT = {
    text: "为什么这样改（可以不写）",
    bigger: "大多少、为什么（可以不写）",
    smaller: "小多少、为什么（可以不写）",
    color: "想要什么颜色，例如：和旁边的“取消”按钮一样的灰色",
    move: "挪到哪里，例如：放到表格右上角",
    remove: "为什么不要（可以不写）",
    add: "要加什么，例如：在这里加一个“导出”按钮",
    other: "想怎么改",
  };
  const STATUS = {
    waiting_for_approval: ["等你确认方案", true],
    waiting_for_business: ["等你回答问题", true],
    running: ["开发中", false],
    completed: ["已完成", false],
    stopped: ["已停止", false],
    failed: ["没有完成", false],
    queued: ["排队中", false],
  };
  const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
  const circled = (n) => (n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`);

  const $ = (id) => document.getElementById(id);
  const frame = $("frame");
  const view = {
    scale: 1,
    info: null,
    file: null,
    state: null,
    width: 1280,
    mode: "comment",
    comments: [],
    general: "",
    regions: [],
    pending: null,
    clickTimer: null,
  };

  // ---------------------------------------------------------------------------
  // Talking to the server

  async function api(path, options) {
    const r = await fetch(path, options);
    const body = await r.json().catch(() => ({ ok: false, message: `服务返回 ${r.status}` }));
    if (!r.ok && body.ok !== true) throw Object.assign(new Error(body.message || `服务返回 ${r.status}`), { body });
    return body;
  }

  let saveTimer = null;
  function saveDraft() {
    if (view.info?.readOnly) return;
    clearTimeout(saveTimer);
    $("saved").textContent = "正在保存…";
    saveTimer = setTimeout(async () => {
      try {
        await api("api/draft", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ comments: view.comments, general: view.general }),
        });
        $("saved").textContent = "已自动保存，关掉页面也不会丢。";
      } catch (e) {
        $("saved").textContent = `没能保存：${e.message}`;
      }
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // Header controls

  function seg(container, items, current, onPick) {
    container.replaceChildren(
      ...items.map((it) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = it.label;
        b.setAttribute("aria-pressed", String(it.value === current));
        b.addEventListener("click", () => onPick(it.value));
        return b;
      }),
    );
  }

  function renderControls() {
    const files = view.info.files;
    $("filesGroup").hidden = files.length < 2;
    seg($("files"), files.map((f) => ({ label: f.title, value: f.path })), view.file, (v) => {
      view.file = v;
      view.state = null;
      loadFrame();
    });
    seg($("widths"), WIDTHS.map((w) => ({ label: `${w.label} ${w.px}`, value: w.px })), view.width, (v) => {
      view.width = v;
      renderControls();
      sizeFrame();
    });
    seg(
      $("modes"),
      [
        { label: "点选提意见", value: "comment" },
        { label: "试用", value: "try" },
      ],
      view.mode,
      (v) => {
        view.mode = v;
        closePop();
        renderControls();
        hint();
      },
    );
  }

  function renderStates(doc) {
    const states = [...new Set([...doc.querySelectorAll("[data-state]")].map((e) => e.getAttribute("data-state")).filter(Boolean))];
    $("statesGroup").hidden = states.length === 0;
    if (states.length > 0 && !states.includes(view.state)) view.state = states[0];
    if (states.length === 0) view.state = null;
    seg($("states"), states.map((s) => ({ label: s, value: s })), view.state, (v) => {
      view.state = v;
      applyState();
      afterLayout();
    });
  }

  function hint() {
    const scaled = view.scale < 1 ? `（窗口不够宽，按 ${Math.round(view.scale * 100)}% 显示）` : "";
    $("hint").textContent =
      (view.mode === "comment"
        ? "点选模式：点任何地方提意见，双击文字直接改字。要像平时一样点按钮、切换页面时，换到“试用”。"
        : "试用模式：可以像平时一样点。要提意见时换回“点选提意见”。") + scaled;
  }

  // ---------------------------------------------------------------------------
  // The prototype in the frame

  const doc = () => frame.contentDocument;

  function loadFrame() {
    closePop();
    renderControls();
    frame.src = `proto/cur/${view.file.split("/").map(encodeURIComponent).join("/")}`;
  }

  frame.addEventListener("load", () => {
    const d = doc();
    if (!d || !d.body) return;
    const style = d.createElement("style");
    style.id = "rk-style";
    style.textContent = `
      .rk-hover { outline: 2px solid #65a30d !important; outline-offset: 2px !important; cursor: pointer !important; }
      .rk-region { outline: 2px dashed #6366f1 !important; outline-offset: 4px !important; }
      .rk-changed { outline: 2px solid #10b981 !important; outline-offset: 2px !important; box-shadow: inset 0 0 0 9999px rgba(16,185,129,.10) !important; }
      .rk-edited { box-shadow: inset 0 0 0 9999px rgba(250,204,21,.35) !important; }
      .rk-flash { outline: 3px solid #a8e01f !important; outline-offset: 3px !important; box-shadow: 0 0 0 9999px rgba(168,224,31,.12) !important; }
      #rk-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; }
      #rk-layer > * { position: absolute; font: 700 12px/22px ui-monospace, Consolas, monospace; border-radius: 999px; text-align: center; box-shadow: 0 0 0 2px #05070d, 0 4px 12px rgba(0,0,0,.35); }
      .rk-badge { background: #4f46e5; color: #fff; padding: 0 7px; pointer-events: none; white-space: nowrap; }
      .rk-pin { background: #a8e01f; color: #0f1a02; min-width: 22px; height: 22px; padding: 0 5px; cursor: pointer; }
      [contenteditable="true"] { outline: 2px solid #f59e0b !important; background: #fffbe6 !important; color: #111 !important; }
    `;
    d.head.appendChild(style);
    const layer = d.createElement("div");
    layer.id = "rk-layer";
    d.body.appendChild(layer);
    d.addEventListener("mouseover", onHover, true);
    d.addEventListener("mouseout", onHoverOut, true);
    d.addEventListener("click", onClick, true);
    d.addEventListener("dblclick", onDblClick, true);
    d.addEventListener("submit", (e) => e.preventDefault(), true);
    d.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePop();
    });
    renderStates(d);
    applyState();
    afterLayout();
  });

  function applyState() {
    const d = doc();
    if (!d) return;
    let s = d.getElementById("rk-state");
    if (!s) {
      s = d.createElement("style");
      s.id = "rk-state";
      d.head.appendChild(s);
    }
    s.textContent = view.state ? `[data-state]:not([data-state="${CSS.escape(view.state)}"]) { display: none !important; }` : "";
    renderStates(d);
  }

  /** The prototype at the chosen width, shrunk to fit when the window is narrower. */
  function sizeFrame() {
    frame.style.width = `${view.width}px`;
    const room = Math.max(200, $("frameWrap").clientWidth - 26);
    view.scale = Math.min(1, room / view.width);
    frame.style.transform = view.scale < 1 ? `scale(${view.scale})` : "";
    const d = doc();
    let h = 480;
    if (d?.documentElement) {
      frame.style.height = "480px";
      h = Math.max(480, d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0) + 4;
    }
    frame.style.height = `${h}px`;
    const sizer = $("sizer");
    sizer.style.width = `${Math.floor(view.width * view.scale)}px`;
    sizer.style.height = `${Math.ceil(h * view.scale)}px`;
    hint();
  }

  function afterLayout() {
    sizeFrame();
    // Sizes settle after the frame grows; mark once it has.
    requestAnimationFrame(() => {
      markRegions();
      drawPins();
      if ($("showDiff").checked) markDiff();
    });
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function pageRect(el) {
    const r = el.getBoundingClientRect();
    const w = el.ownerDocument.defaultView;
    return { left: r.left + w.scrollX, top: r.top + w.scrollY, width: r.width, height: r.height };
  }

  function layer() {
    return doc()?.getElementById("rk-layer");
  }

  function clearLayer(cls) {
    layer()
      ?.querySelectorAll(`.${cls}`)
      .forEach((n) => n.remove());
  }

  // ---------------------------------------------------------------------------
  // What to look at: the regions the design marked with data-ac

  function markRegions() {
    const d = doc();
    if (!d) return;
    d.querySelectorAll(".rk-region").forEach((e) => e.classList.remove("rk-region"));
    clearLayer("rk-badge");
    view.regions = [...d.querySelectorAll("[data-ac]")].filter(visible);
    const show = $("showRegions").checked;
    view.regions.forEach((el, i) => {
      if (!show) return;
      el.classList.add("rk-region");
      const r = pageRect(el);
      const b = d.createElement("div");
      b.className = "rk-badge";
      b.textContent = `${circled(i + 1)} ${el.getAttribute("data-ac")}`;
      b.style.left = `${Math.max(0, r.left - 6)}px`;
      b.style.top = `${Math.max(0, r.top - 14)}px`;
      layer().appendChild(b);
    });
    renderRegions();
  }

  function criterionText(ac) {
    const ids = String(ac || "")
      .split(/[\s,，、]+/)
      .filter(Boolean);
    return ids
      .map((id) => view.info.criteria.find((c) => c.id === id))
      .filter(Boolean)
      .map((c) => `${c.id}：${c.text}`)
      .join("；");
  }

  function renderRegions() {
    const ul = $("regions");
    if (view.regions.length === 0) {
      const crit = view.info.criteria;
      ul.replaceChildren(
        li(
          `<p class="muted small">这个原型没有标出改动区域。可以对照下面的验收标准看${view.state ? "（也看看上面切换出来的其他状态）" : ""}。</p>` +
            (crit.length ? `<ul class="diff-list">${crit.map((c) => `<li>${esc(c.id)}：${esc(c.text)}</li>`).join("")}</ul>` : ""),
        ),
      );
      return;
    }
    ul.replaceChildren(
      ...view.regions.map((el, i) => {
        const ac = el.getAttribute("data-ac");
        const label = el.getAttribute("data-label") || "";
        const item = li(
          `<div class="row"><span class="badge region">${circled(i + 1)}</span><div class="grow"><div class="strong">${esc(label || ac)}</div><div class="muted small">${esc(criterionText(ac) || ac)}</div></div><button type="button" class="linkish">看一下</button></div>`,
        );
        item.querySelector("button").addEventListener("click", () => flash(el));
        return item;
      }),
    );
  }

  function li(html) {
    const n = document.createElement("li");
    n.innerHTML = html;
    return n;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function flash(el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const r = pageRect(el);
    const wrap = $("frameWrap");
    wrap.scrollTo({ top: Math.max(0, r.top * view.scale - wrap.clientHeight / 3), behavior: "smooth" });
    el.classList.add("rk-flash");
    setTimeout(() => el.classList.remove("rk-flash"), 1600);
  }

  // ---------------------------------------------------------------------------
  // Describing what was clicked, in words a person and an agent can both use

  const TAG_DESC = {
    BUTTON: "按钮",
    A: "链接",
    INPUT: "输入框",
    SELECT: "下拉框",
    TEXTAREA: "多行输入框",
    IMG: "图片",
    H1: "标题",
    H2: "标题",
    H3: "标题",
    H4: "小标题",
    H5: "小标题",
    H6: "小标题",
    TABLE: "表格",
    TH: "表头",
    TD: "表格单元格",
    TR: "表格行",
    LABEL: "标签文字",
    LI: "列表项",
    P: "文字",
    SPAN: "文字",
    STRONG: "文字",
    EM: "文字",
    SMALL: "小字",
    NAV: "导航",
    HEADER: "页头",
    FOOTER: "页脚",
    FORM: "表单",
    UL: "列表",
    OL: "列表",
  };
  const ROLE_DESC = { button: "按钮", link: "链接", tab: "标签页", dialog: "弹窗", checkbox: "勾选框", switch: "开关", menuitem: "菜单项", alert: "提示" };

  function hex(color) {
    const m = /rgba?\(([^)]+)\)/.exec(color || "");
    if (!m) return color || "";
    const [r, g, b, a = "1"] = m[1].split(/[\s,/]+/).filter(Boolean);
    if (Number(a) === 0) return "";
    return `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
  }

  function backgroundOf(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = hex(n.ownerDocument.defaultView.getComputedStyle(n).backgroundColor);
      if (c) return c;
    }
    return "#ffffff";
  }

  function textOf(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value || el.getAttribute("placeholder") || "";
    if (el.tagName === "IMG") return el.getAttribute("alt") || "";
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n.tagName !== "HTML"; n = n.parentElement) {
      if (n.id && !n.id.startsWith("rk-")) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      if (n.tagName === "BODY") break;
    }
    return parts.join(" > ");
  }

  function describe(el) {
    const w = el.ownerDocument.defaultView;
    const cs = w.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const role = el.getAttribute("role");
    let desc = (role && ROLE_DESC[role]) || TAG_DESC[el.tagName] || "区域";
    if (el.tagName === "INPUT" && /checkbox|radio/.test(el.type)) desc = el.type === "checkbox" ? "勾选框" : "单选项";
    if (el.tagName === "INPUT" && /submit|button/.test(el.type)) desc = "按钮";
    const regionEl = el.closest("[data-ac]");
    const index = regionEl ? view.regions.indexOf(regionEl) + 1 : 0;
    return {
      desc,
      text: textOf(el).slice(0, 120),
      selector: cssPath(el),
      region: regionEl ? { ac: regionEl.getAttribute("data-ac"), label: regionEl.getAttribute("data-label") || "", index: index > 0 ? circled(index) : null } : null,
      styles: {
        color: hex(cs.color),
        background: backgroundOf(el),
        fontSize: cs.fontSize,
        size: `${Math.round(r.width)}×${Math.round(r.height)}`,
      },
    };
  }

  /** A click on a big container or the page itself: say where it is by what is around it. */
  function targetOf(el) {
    if (el.id === "rk-layer" || el.closest?.("#rk-layer")) return null;
    if (el.tagName === "HTML" || el.tagName === "BODY") return { el, empty: true };
    return { el, empty: false };
  }

  // ---------------------------------------------------------------------------
  // Clicking in the prototype

  let hovered = null;
  function onHover(e) {
    if (view.mode !== "comment") return;
    const t = e.target;
    if (!t || t.nodeType !== 1 || t.closest("#rk-layer") || t.tagName === "BODY" || t.tagName === "HTML") return;
    hovered?.classList.remove("rk-hover");
    hovered = t;
    t.classList.add("rk-hover");
  }
  function onHoverOut(e) {
    if (e.target === hovered) {
      hovered.classList.remove("rk-hover");
      hovered = null;
    }
  }

  function onClick(e) {
    const pin = e.target.closest?.(".rk-pin");
    if (pin) {
      e.preventDefault();
      e.stopPropagation();
      focusComment(pin.dataset.id);
      return;
    }
    if (view.mode !== "comment") return;
    if (e.target.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    if (view.info.readOnly) return;
    const t = targetOf(e.target);
    if (!t) return;
    // A double click edits the text instead: wait a moment before opening the box.
    clearTimeout(view.clickTimer);
    const { clientX, clientY } = e;
    view.clickTimer = setTimeout(() => openPop(t, clientX, clientY), 260);
  }

  function onDblClick(e) {
    if (view.mode !== "comment" || view.info.readOnly) return;
    clearTimeout(view.clickTimer);
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (!el || el.nodeType !== 1 || el.closest("#rk-layer")) return;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || el.tagName === "BODY") {
      openPop({ el, empty: false }, e.clientX, e.clientY, "text");
      return;
    }
    closePop();
    const before = describe(el);
    const original = el.dataset.rkOriginal ?? textOf(el);
    el.dataset.rkOriginal = original;
    el.contentEditable = "true";
    el.focus();
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const sel = el.ownerDocument.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = () => {
      el.contentEditable = "false";
      el.removeEventListener("blur", finish);
      el.removeEventListener("keydown", onKey);
      const now = textOf(el);
      if (now && now !== original) {
        el.classList.add("rk-edited");
        const existing = view.comments.find((c) => c.kind === "text" && c.file === view.file && c.target?.selector === before.selector);
        if (existing) existing.newText = now;
        else addComment({ kind: "text", newText: now, note: "", target: { ...before, text: original } });
        renderComments();
        drawPins();
        saveDraft();
      }
    };
    const onKey = (k) => {
      if (k.key === "Enter" && !k.shiftKey) {
        k.preventDefault();
        el.blur();
      }
      if (k.key === "Escape") {
        el.textContent = original;
        el.blur();
      }
    };
    el.addEventListener("blur", finish);
    el.addEventListener("keydown", onKey);
  }

  // ---------------------------------------------------------------------------
  // The "how to change it" box

  function openPop(t, x, y, kind) {
    const el = t.el;
    const info = t.empty ? { desc: "空白处", text: "", selector: "body", region: null, styles: null } : describe(el);
    view.pending = { el, info, kind: kind || (t.empty ? "add" : null), edit: null };
    $("popTitle").textContent = t.empty ? "在页面空白处" : `${info.desc}${info.text ? `“${info.text.slice(0, 30)}${info.text.length > 30 ? "…" : ""}”` : ""}`;
    $("popSub").textContent = info.region
      ? `在区域 ${info.region.index ?? ""}${info.region.label ? `「${info.region.label}」` : ""}${info.region.ac ? `（${info.region.ac}）` : ""}`
      : "选一种改法，再补一句";
    renderKinds();
    $("note").value = "";
    $("newText").value = info.text || "";
    syncPopFields();
    const pop = $("pop");
    pop.hidden = false;
    const fr = frame.getBoundingClientRect();
    const px = Math.min(window.innerWidth - pop.offsetWidth - 12, Math.max(12, fr.left + x * view.scale + 12));
    const py = Math.min(window.innerHeight - pop.offsetHeight - 12, Math.max(12, fr.top + y * view.scale + 12));
    pop.style.left = `${px}px`;
    pop.style.top = `${py}px`;
    (view.pending.kind ? $("note") : $("kinds").querySelector("button"))?.focus();
  }

  function editComment(c) {
    const el = findTarget(c);
    view.pending = { el, info: c.target, kind: c.kind, edit: c.id };
    $("popTitle").textContent = `修改第 ${view.comments.indexOf(c) + 1} 条意见`;
    $("popSub").textContent = c.target?.desc ? `${c.target.desc}${c.target.text ? `“${c.target.text.slice(0, 30)}”` : ""}` : "";
    renderKinds();
    $("note").value = c.note || "";
    $("newText").value = c.newText || "";
    syncPopFields();
    const pop = $("pop");
    pop.hidden = false;
    pop.style.left = `${Math.max(12, window.innerWidth - pop.offsetWidth - 400)}px`;
    pop.style.top = "120px";
    $("note").focus();
  }

  function renderKinds() {
    $("kinds").replaceChildren(
      ...KINDS.map((k) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = k.label;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(view.pending.kind === k.id));
        b.addEventListener("click", () => {
          view.pending.kind = k.id;
          renderKinds();
          syncPopFields();
          (k.id === "text" ? $("newText") : $("note")).focus();
        });
        return b;
      }),
    );
  }

  function syncPopFields() {
    const kind = view.pending?.kind;
    $("newTextField").hidden = kind !== "text";
    $("newTextLabel").textContent = "改成这样的文字";
    $("noteLabel").textContent = NOTE_HINT[kind] || "用你自己的话说说（可以不写）";
    $("popOk").disabled = !kind;
  }

  function closePop() {
    $("pop").hidden = true;
    view.pending = null;
  }

  $("popCancel").addEventListener("click", closePop);
  $("pop").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePop();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("popOk").click();
  });
  $("popOk").addEventListener("click", () => {
    const p = view.pending;
    if (!p?.kind) return;
    const note = $("note").value.trim();
    const newText = p.kind === "text" ? $("newText").value.trim() : "";
    if (p.kind === "text" && !newText) {
      $("newText").focus();
      return;
    }
    if (p.edit) {
      const c = view.comments.find((x) => x.id === p.edit);
      if (c) Object.assign(c, { kind: p.kind, note, newText: newText || undefined });
    } else {
      addComment({ kind: p.kind, note, newText: newText || undefined, target: p.info });
    }
    closePop();
    renderComments();
    drawPins();
    saveDraft();
  });

  function addComment(c) {
    view.comments.push({ id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, file: view.file, state: view.state, width: view.width, ...c });
  }

  // ---------------------------------------------------------------------------
  // The list of comments and their pins

  function findTarget(c) {
    if (c.file !== view.file || !c.target?.selector) return null;
    try {
      return doc()?.querySelector(c.target.selector) ?? null;
    } catch {
      return null;
    }
  }

  function drawPins() {
    clearLayer("rk-pin");
    const d = doc();
    if (!d || !layer()) return;
    view.comments.forEach((c, i) => {
      if (c.file !== view.file || (c.state && view.state && c.state !== view.state)) return;
      const el = findTarget(c);
      if (!el || !visible(el)) return;
      const r = pageRect(el);
      const pin = d.createElement("div");
      pin.className = "rk-pin";
      pin.dataset.id = c.id;
      pin.textContent = String(i + 1);
      pin.title = `第 ${i + 1} 条：${KIND_LABEL[c.kind]}`;
      pin.style.left = `${Math.max(0, r.left + r.width - 8)}px`;
      pin.style.top = `${Math.max(0, r.top - 15)}px`;
      layer().appendChild(pin);
      if (c.kind === "text" && c.newText && el.dataset.rkOriginal === undefined && !el.isContentEditable) {
        // Show the requested text in place, as the person typed it (plain text elements only:
        // replacing the text of one with icons inside would drop the icons).
        el.classList.add("rk-edited");
        if (el.childElementCount === 0) {
          el.dataset.rkOriginal = textOf(el);
          el.textContent = c.newText;
        }
      }
    });
  }

  function summary(c) {
    if (c.kind === "text") return `文字改成“${c.newText ?? ""}”`;
    return KIND_LABEL[c.kind] || "其他";
  }

  function renderComments() {
    $("count").textContent = view.comments.length ? `（${view.comments.length}）` : "";
    const ul = $("comments");
    if (view.comments.length === 0) {
      ul.replaceChildren(li('<p class="muted small">还没有意见。点原型上想改的地方开始。</p>'));
    } else {
      ul.replaceChildren(
        ...view.comments.map((c, i) => {
          const where = [
            view.info.files.length > 1 ? (view.info.files.find((f) => f.path === c.file)?.title ?? c.file) : "",
            c.state ? `状态“${c.state}”` : "",
            c.target?.region?.index ? `区域 ${c.target.region.index}` : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const item = li(
            `<div class="row"><span class="badge pin">${i + 1}</span><div class="grow"><div class="strong">${esc(summary(c))}</div>` +
              `<div class="muted small">${esc(c.target?.desc ?? "")}${c.target?.text ? `“${esc(c.target.text.slice(0, 40))}”` : ""}${where ? ` · ${esc(where)}` : ""}</div>` +
              (c.note ? `<div class="small">${esc(c.note)}</div>` : "") +
              `<div><button type="button" class="linkish" data-act="show">在原型上看</button><button type="button" class="linkish" data-act="edit">修改</button><button type="button" class="linkish danger" data-act="del">删除</button></div></div></div>`,
          );
          item.dataset.id = c.id;
          item.querySelector('[data-act="show"]').addEventListener("click", () => showComment(c));
          item.querySelector('[data-act="edit"]').addEventListener("click", () => editComment(c));
          item.querySelector('[data-act="del"]').addEventListener("click", () => {
            view.comments = view.comments.filter((x) => x.id !== c.id);
            const el = findTarget(c);
            if (el && el.dataset.rkOriginal !== undefined && c.kind === "text") {
              el.textContent = el.dataset.rkOriginal;
              delete el.dataset.rkOriginal;
              el.classList.remove("rk-edited");
            }
            renderComments();
            drawPins();
            saveDraft();
          });
          return item;
        }),
      );
    }
    renderActions();
  }

  function showComment(c) {
    const go = () => {
      const el = findTarget(c);
      if (el) flash(el);
      focusComment(c.id);
    };
    if (c.file !== view.file) {
      view.file = c.file;
      view.state = c.state ?? null;
      frame.addEventListener("load", () => setTimeout(go, 150), { once: true });
      loadFrame();
      return;
    }
    if (c.state && c.state !== view.state) {
      view.state = c.state;
      applyState();
      afterLayout();
    }
    setTimeout(go, 60);
  }

  function focusComment(id) {
    const item = [...$("comments").children].find((n) => n.dataset.id === id);
    if (!item) return;
    item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    item.classList.add("flash");
    setTimeout(() => item.classList.remove("flash"), 1500);
  }

  // ---------------------------------------------------------------------------
  // What changed since the version before

  function leafTexts(root) {
    const out = [];
    const walk = (n) => {
      if (n.nodeType !== 1 || /^(SCRIPT|STYLE|TEMPLATE)$/.test(n.tagName) || n.id === "rk-layer") return;
      const own = [...n.childNodes]
        .filter((c) => c.nodeType === 3)
        .map((c) => c.textContent)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      const attr = n.getAttribute("placeholder") || n.getAttribute("alt") || (n.tagName === "INPUT" ? n.getAttribute("value") : "") || "";
      if (own || attr) out.push({ el: n, text: own || attr });
      [...n.children].forEach(walk);
    };
    walk(root);
    return out;
  }

  async function markDiff() {
    const d = doc();
    if (!d) return;
    d.querySelectorAll(".rk-changed").forEach((e) => e.classList.remove("rk-changed"));
    const prev = view.info.versions.previous;
    const card = $("changesCard");
    if (!$("showDiff").checked || !prev) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    let html;
    try {
      const r = await fetch(`proto/v/${prev}/${view.file.split("/").map(encodeURIComponent).join("/")}`);
      if (r.status === 404) {
        $("changes").innerHTML = '<p class="muted small">这个页面是这一版新加的。</p>';
        return;
      }
      html = await r.text();
    } catch {
      $("changes").innerHTML = '<p class="muted small">没能读到上一版。</p>';
      return;
    }
    const old = new DOMParser().parseFromString(html, "text/html");
    const oldTexts = new Set(leafTexts(old.body).map((x) => x.text));
    const now = leafTexts(d.body);
    const nowTexts = new Set(now.map((x) => x.text));
    let changed = 0;
    for (const x of now) {
      if (!oldTexts.has(x.text) && visible(x.el)) {
        x.el.classList.add("rk-changed");
        changed++;
      }
    }
    const removed = [...oldTexts].filter((t) => !nowTexts.has(t)).slice(0, 20);
    $("changes").innerHTML =
      `<p class="small">绿色框是这一版新出现或改过文字的地方，共 ${changed} 处。</p>` +
      (removed.length ? `<p class="small muted">上一版有、这一版没有的文字：</p><ul class="diff-list">${removed.map((t) => `<li>${esc(t.slice(0, 60))}</li>`).join("")}</ul>` : "") +
      (changed === 0 && removed.length === 0 ? '<p class="muted small">文字没有变化，改动可能在样式或布局上。</p>' : "");
  }

  // ---------------------------------------------------------------------------
  // Sending

  function renderActions() {
    const info = view.info;
    const note = $("actionNote");
    const changes = $("submitChanges");
    const approve = $("approve");
    if (info.readOnly) {
      $("actions").hidden = true;
      return;
    }
    changes.textContent = view.comments.length ? `提交修改意见（${view.comments.length} 条）` : "提交修改意见";
    const hasAny = view.comments.length > 0 || view.general.trim().length > 0;
    if (!info.canReply) {
      note.textContent = "这个需求不是从 Paseo 对话开始的，这里的意见只会保存，请在卡片或终端中处理。";
      changes.disabled = true;
      approve.disabled = !info.waitingForApproval;
    } else if (info.waitingForApproval) {
      note.textContent = hasAny ? "提交后，需求会话会按你的意见改需求说明，再请你确认。" : "看完了，没有要改的就同意；有要改的先点原型提意见。";
      changes.disabled = !hasAny;
      approve.disabled = false;
    } else if (info.waitingForReply) {
      note.textContent = "需求现在在等你回答问题，意见会一起转给需求会话。";
      changes.disabled = !hasAny;
      approve.disabled = true;
    } else {
      note.textContent = `现在不在等你确认方案（${STATUS[info.status]?.[0] ?? info.status ?? "还没开始"}）。可以先写意见，会自动保存，等到要确认时再提交。`;
      changes.disabled = true;
      approve.disabled = true;
    }
    approve.hidden = !info.waitingForApproval;
    // 1.15: one lime button, the next step: send the notes when there are any, else confirm the design.
    const notesFirst = hasAny || !info.waitingForApproval;
    changes.className = notesFirst ? "rk-btn rk-btn--primary" : "rk-btn";
    approve.className = notesFirst ? "rk-btn" : "rk-btn rk-btn--primary";
  }

  async function submit(action) {
    const result = $("result");
    if (action === "approve" && view.comments.length > 0 && !confirm(`还有 ${view.comments.length} 条意见没有提交。确定不改，直接同意开始写代码吗？`)) return;
    $("submitChanges").disabled = true;
    $("approve").disabled = true;
    result.className = "result";
    result.textContent = "正在提交…";
    try {
      const r = await api("api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, comments: view.comments, general: view.general }),
      });
      result.className = "result ok";
      result.textContent = action === "approve" ? `已确认方案，开始写代码。${r.message ? `（${r.message.split("\n").at(-1)}）` : ""}` : "已转给需求会话。它会按你的意见改需求说明，改好后请你确认。";
      view.comments = [];
      view.general = "";
      $("general").value = "";
      await refreshInfo();
      renderComments();
      drawPins();
    } catch (e) {
      result.className = "result err";
      result.textContent = `没有提交成功：${e.message}`;
      renderActions();
    }
  }
  $("submitChanges").addEventListener("click", () => submit("changes"));
  $("approve").addEventListener("click", () => submit("approve"));
  $("general").addEventListener("input", (e) => {
    view.general = e.target.value;
    renderActions();
    saveDraft();
  });
  $("showRegions").addEventListener("change", () => markRegions());
  $("showDiff").addEventListener("change", () => markDiff());
  window.addEventListener("resize", () => afterLayout());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePop();
  });

  // ---------------------------------------------------------------------------
  // Start

  async function refreshInfo() {
    view.info = await api("api/info");
    const [label, waiting] = STATUS[view.info.status] ?? [view.info.status ? view.info.status : "还没开始", false];
    const pill = $("status");
    pill.hidden = false;
    pill.textContent = label;
    pill.className = waiting ? "rk-badge rk-badge--needs" : "rk-badge rk-badge--muted";
    $("diffWrap").hidden = !view.info.versions.previous;
    renderActions();
  }

  async function start() {
    hint();
    try {
      await refreshInfo();
    } catch (e) {
      $("title").textContent = "打不开";
      $("empty").hidden = false;
      $("empty").textContent = e.message;
      $("frameWrap").hidden = true;
      return;
    }
    const info = view.info;
    $("title").textContent = info.title;
    document.title = `原型审查 · ${info.title}`;
    if (info.readOnly) $("guide").open = false;
    try {
      const draft = await api("api/draft");
      view.comments = Array.isArray(draft.comments) ? draft.comments : [];
      view.general = typeof draft.general === "string" ? draft.general : "";
      $("general").value = view.general;
      if (view.comments.length) $("saved").textContent = `上次写的 ${view.comments.length} 条意见还在。`;
    } catch {
      /* start empty */
    }
    renderComments();
    if (info.files.length === 0) {
      $("frameWrap").hidden = true;
      $("empty").hidden = false;
      $("empty").textContent = "这个需求还没有界面原型。界面改动的需求在方案设计完成后才会有，到时再打开这个页面。";
      return;
    }
    view.file = info.files[0].path;
    // On a phone, start with the phone width.
    if (window.innerWidth < 700) view.width = 390;
    // Auto-suggest the diff when the design was revised since the last look.
    if (info.versions.previous) $("showDiff").checked = true;
    loadFrame();
  }

  start();
})();
