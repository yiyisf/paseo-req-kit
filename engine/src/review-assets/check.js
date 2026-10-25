// The acceptance checklist page (1.14; design system 1.15). Plain script, no framework: the server
// serves it next to its JSON API (api/info, api/draft, api/try, api/submit).
(function () {
  "use strict";
  var state = { info: null, answers: {}, reviewer: "", saveTimer: null, busy: false };
  var $ = function (id) {
    return document.getElementById(id);
  };
  var icon = function (name, cls) {
    return window.RkIcon ? window.RkIcon(name, cls) : null;
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) return;
      if (k === "text") node.textContent = attrs[k];
      else if (k === "className") node.className = attrs[k];
      else if (k.indexOf("on") === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function badge(kind, iconName, text) {
    return el("span", { className: "rk-badge rk-badge--" + kind }, [iconName ? icon(iconName) : null, text]);
  }

  function toast(text) {
    var t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () {
      t.hidden = true;
    }, 6000);
  }

  function api(pathname, method, body) {
    return fetch(pathname, { method: method || "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok && data && data.message) throw new Error(data.message);
        return data;
      });
    });
  }

  // What the pipeline found for each criterion: badge kind, icon, words.
  var PIPELINE = { pass: ["success", "circle-check", "流水线已验证"], fail: ["failed", "circle-x", "流水线没通过"], unverified: ["muted", "circle-dashed", "流水线没验证"], unknown: ["muted", "circle-dashed", "流水线没有记录"] };
  var DETAIL = /^(前置条件|操作|预期结果|预期)[:：]\s*(.*)$/;

  function hhmm() {
    var d = new Date();
    return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }

  function answersList() {
    return Object.keys(state.answers).map(function (id) {
      return { id: id, mark: state.answers[id].mark, note: state.answers[id].note || "" };
    });
  }

  function save() {
    if (state.info.readOnly) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      api("api/draft", "PUT", { answers: answersList(), reviewer: state.reviewer })
        .then(function () {
          $("saved").textContent = "已自动保存 " + hhmm();
        })
        .catch(function () {
          $("saved").textContent = "没保存上，网络恢复后再改一下会重试";
        });
    }, 600);
  }

  function summary() {
    var items = state.info.items;
    var c = { pass: 0, fail: 0, skip: 0, open: 0 };
    var missing = 0;
    var failedRequired = 0;
    items.forEach(function (i) {
      var a = state.answers[i.id];
      if (!a) c.open++;
      else c[a.mark]++;
      if (i.required && (!a || a.mark === "skip")) missing++;
      if (i.required && a && a.mark === "fail") failedRequired++;
    });
    var verdict = failedRequired > 0 ? "不通过" : missing === 0 ? "通过" : null;
    $("summary").textContent = "已核对 " + (c.pass + c.fail) + " / " + items.length + (c.fail ? " · " + c.fail + " 项不对" : "") + (c.skip ? " · 先不验 " + c.skip : "");
    $("summary-sub").textContent = state.info.readOnly
      ? "这是只读链接，只能查看"
      : verdict === "通过"
        ? "可以提交：验收通过"
        : verdict === "不通过"
          ? "提交后结论是“不通过”，不对的地方会转给需求的对话处理"
          : "还有 " + missing + " 条必须验的没有核对；核对完，或者有不对的标“不对”后才能提交";
    $("submit").disabled = state.info.readOnly || state.busy || verdict === null;
    $("submit").lastChild.textContent = verdict === "不通过" ? "提交验收（不通过）" : "提交验收";
  }

  function details(item) {
    var rows = [];
    var rest = [];
    item.details.forEach(function (d) {
      var m = DETAIL.exec(d.replace(/^\s*[-*]\s+/, ""));
      if (m) rows.push(el("dt", { text: m[1] === "预期" ? "预期结果" : m[1] }), el("dd", { text: m[2] }));
      else rest.push(el("li", { text: d.replace(/^\s*[-*]\s+/, "") }));
    });
    return [rows.length ? el("dl", {}, rows) : null, rest.length ? el("ul", { className: "ck-details" }, rest) : null];
  }

  function renderItem(item) {
    var a = state.answers[item.id];
    var p = PIPELINE[item.pipeline] || PIPELINE.unknown;
    var li = el("li", { className: "rk-check" + (a && a.mark === "fail" ? " is-fail" : a && a.mark === "pass" ? " is-pass" : ""), id: "item-" + item.id });
    li.appendChild(el("span", { className: "rk-check__id", text: item.id }));
    var main = el("div", { className: "rk-check__main" });
    main.appendChild(
      el("div", { className: "rk-check__title" }, [
        el("span", { text: item.title }),
        item.kind === "criterion" ? badge(p[0], p[1], p[2]) : badge("needs", "circle-dot", "请你表态"),
        item.required ? null : badge("outline", null, "可以以后再说"),
      ]),
    );
    details(item).forEach(function (n) {
      if (n) main.appendChild(n);
    });
    if (item.evidence) main.appendChild(el("div", { className: "rk-check__evidence", text: (item.kind === "criterion" ? "流水线的记录：" : "") + item.evidence }));
    var labels = item.kind === "decision" ? [["pass", "同意", "is-pass"], ["fail", "不同意", "is-fix"], ["skip", "先不表态", ""]] : [["pass", "通过", "is-pass"], ["fail", "不对", "is-fix"], ["skip", "先不验", ""]];
    var seg = el(
      "div",
      { className: "rk-seg", role: "group", "aria-label": item.kind === "decision" ? "表态" : "核对结果", style: "align-self:flex-start" },
      labels.map(function (l) {
        return el("button", {
          type: "button",
          className: l[2],
          "aria-pressed": String(!!(a && a.mark === l[0])),
          text: l[1],
          disabled: state.info.readOnly ? "disabled" : null,
          onclick: function () {
            var cur = state.answers[item.id];
            state.answers[item.id] = { mark: l[0], note: cur ? cur.note : "" };
            save();
            render();
            if (l[0] === "fail") setTimeout(function () {
              var t = document.querySelector("#item-" + CSS.escape(item.id) + " textarea");
              if (t && !t.value) t.focus();
            });
          },
        });
      }),
    );
    main.appendChild(seg);
    if (a && a.mark === "fail") {
      var ta = el("textarea", { className: "rk-input", rows: "2", "aria-label": "看到了什么", placeholder: item.kind === "decision" ? "为什么不同意？希望怎样？" : "看到了什么？应该是什么样？（例如：点导出后提示“失败”，应该下载文件）" });
      ta.value = a.note || "";
      ta.disabled = !!state.info.readOnly;
      ta.addEventListener("input", function () {
        state.answers[item.id].note = ta.value;
        save();
      });
      main.appendChild(ta);
    }
    li.appendChild(main);
    return li;
  }

  function navIcon(item) {
    var a = state.answers[item.id];
    if (a && a.mark === "pass") return ["circle-check", "var(--rk-status-success)"];
    if (a && a.mark === "fail") return ["circle-x", "var(--rk-status-failed)"];
    if (item.kind === "decision") return ["circle-dot", "var(--rk-brand-text)"];
    if (item.pipeline === "fail") return ["circle-x", "var(--rk-status-failed)"];
    if (item.pipeline === "pass") return ["circle-check", "var(--rk-text-muted)"];
    return ["circle-dashed", "var(--rk-text-muted)"];
  }

  function renderNav() {
    var nav = $("nav");
    nav.textContent = "";
    var first = state.info.items.filter(function (i) {
      return i.kind === "decision" || i.pipeline !== "pass";
    });
    var rest = state.info.items.filter(function (i) {
      return first.indexOf(i) < 0;
    });
    [["先看这些", first], ["流水线已验证", rest]].forEach(function (g) {
      if (!g[1].length) return;
      nav.appendChild(el("div", { className: "rk-side__group", text: g[0] }));
      g[1].forEach(function (item) {
        var ic = navIcon(item);
        var svg = icon(ic[0]);
        if (svg) svg.style.color = ic[1];
        nav.appendChild(
          el("a", { href: "#item-" + item.id, onclick: function (e) {
            e.preventDefault();
            var t = $("item-" + item.id);
            if (t) t.scrollIntoView({ block: "start", behavior: "smooth" });
          } }, [svg, el("span", { text: item.id + " " + item.title })]),
        );
      });
    });
  }

  function render() {
    var list = $("items");
    list.textContent = "";
    if (!state.info.items.length) {
      list.appendChild(el("li", { className: "rk-card rk-card--sm" }, [el("div", { className: "rk-empty" }, [icon("clipboard-check", "ic ic-xl"), el("h3", { text: "没有找到验收标准" }), el("p", { text: "需求说明里没有 AC 编号的验收标准。请在需求的对话里补上，或者按完成报告验收。" })])]));
    }
    state.info.items.forEach(function (item) {
      list.appendChild(renderItem(item));
    });
    renderNav();
    summary();
  }

  function showTry(result) {
    var box = $("try-box");
    box.textContent = "";
    $("try-state").textContent = "";
    var running = (result.services || []).filter(function (s) {
      return s.running && s.url;
    });
    $("try-state").appendChild(result.ok && running.length ? badge("running", null, "正在运行") : badge(result.ok ? "success" : "warning", result.ok ? "circle-check" : "triangle-alert", result.ok ? "已启动" : "没能一键跑起来"));
    if (result.ok && running.length) $("try-state").firstChild.insertBefore(el("span", { className: "rk-spin" }), $("try-state").firstChild.firstChild);
    box.appendChild(el("p", { text: (result.message || "").split("\n")[0] }));
    if (running.length) {
      box.appendChild(
        el(
          "ul",
          { className: "ck-services" },
          running.map(function (s) {
            return el("li", {}, [s.name + "：", el("a", { href: s.url, target: "_blank", rel: "noopener", text: s.url })]);
          }),
        ),
      );
      $("try-stop").hidden = false;
    }
    if (result.howTo && result.howTo.length) box.appendChild(el("pre", { className: "ck-howto", text: result.howTo.join("\n") }));
  }

  function tryIt(stop) {
    var button = stop ? $("try-stop") : $("try");
    var label = stop ? button : button.lastChild;
    button.disabled = true;
    label.textContent = stop ? "正在停止…" : "正在启动，可能要一两分钟…";
    api("api/try", "POST", { stop: !!stop })
      .then(function (r) {
        if (stop) {
          toast(r.message);
          $("try-stop").hidden = true;
          $("try-state").textContent = "";
        } else showTry(r);
      })
      .catch(function (e) {
        toast(e.message);
      })
      .then(function () {
        button.disabled = false;
        label.textContent = stop ? "停止试用" : "把它跑起来试用";
      });
  }

  function submit() {
    state.busy = true;
    summary();
    api("api/submit", "POST", { answers: answersList(), reviewer: state.reviewer })
      .then(function (r) {
        toast(r.message);
        var ok = r.verdict === "通过";
        var done = el("div", { className: "rk-banner " + (ok ? "rk-banner--ok" : "rk-banner--warn") }, [icon(ok ? "circle-check" : "undo-2"), el("span", { text: "已提交：验收" + r.verdict + "。" + r.message })]);
        $("main").insertBefore(done, $("main").firstChild);
        window.scrollTo(0, 0);
      })
      .catch(function (e) {
        toast(e.message);
        state.busy = false;
        summary();
      });
  }

  function start() {
    api("api/info")
      .then(function (info) {
        state.info = info;
        document.title = "验收清单 · " + info.title;
        $("title").textContent = info.title;
        $("project").textContent = info.featureDir;
        $("project").hidden = false;
        $("readonly").hidden = !info.readOnly;
        $("sub").textContent = [info.reportVerdict ? "流水线结论：" + info.reportVerdict : null, info.accepted ? "上次验收：" + info.accepted : null].filter(Boolean).join("　");
        (info.draft && info.draft.answers ? info.draft.answers : []).forEach(function (a) {
          state.answers[a.id] = { mark: a.mark, note: a.note || "" };
        });
        state.reviewer = (info.draft && info.draft.reviewer) || "";
        $("reviewer").value = state.reviewer;
        $("reviewer").disabled = !!info.readOnly;
        if (info.notes && info.notes.length) {
          var n = $("notes");
          n.hidden = false;
          n.appendChild(icon("info"));
          n.appendChild(
            el("div", {}, [
              el("b", { text: "先看一下（来自提测说明）" }),
              el(
                "ul",
                {},
                info.notes.map(function (t) {
                  return el("li", { text: t });
                }),
              ),
            ]),
          );
        }
        if (info.readOnly || info.running) $("try-card").hidden = true;
        render();
      })
      .catch(function (e) {
        $("title").textContent = "打不开验收清单";
        $("sub").textContent = e.message;
      });
    $("reviewer").addEventListener("input", function (e) {
      state.reviewer = e.target.value;
      save();
    });
    $("try").addEventListener("click", function () {
      tryIt(false);
    });
    $("try-stop").addEventListener("click", function () {
      tryIt(true);
    });
    $("submit").addEventListener("click", submit);
  }

  start();
})();
