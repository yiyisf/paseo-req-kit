// The acceptance checklist page (1.14). Plain script, no framework: the server serves it next to
// its JSON API (api/info, api/draft, api/try, api/submit).
(function () {
  "use strict";
  var state = { info: null, answers: {}, reviewer: "", saveTimer: null, busy: false };
  var $ = function (id) {
    return document.getElementById(id);
  };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] === null || attrs[k] === undefined) return;
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

  var PIPELINE = { pass: ["流水线：通过", "pass"], fail: ["流水线：没通过", "fail"], unverified: ["流水线：没验证", "unverified"], unknown: ["流水线：没有记录", ""] };

  function answersList() {
    return Object.keys(state.answers).map(function (id) {
      return { id: id, mark: state.answers[id].mark, note: state.answers[id].note || "" };
    });
  }

  function save() {
    if (state.info.readOnly) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      api("api/draft", "PUT", { answers: answersList(), reviewer: state.reviewer }).catch(function () {});
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
    $("summary").textContent =
      "共 " + items.length + " 条：通过 " + c.pass + "，不对 " + c.fail + "，先不验 " + c.skip + "，还没看 " + c.open + "。" +
      (verdict === "通过" ? "可以提交：验收通过。" : verdict === "不通过" ? "提交后结论是“不通过”，不对的地方会转给需求的对话。" : "必须验的都核对完才能提交“通过”。");
    $("submit").disabled = state.info.readOnly || state.busy || verdict === null;
    $("submit").textContent = verdict === "不通过" ? "提交：验收不通过" : "提交：验收通过";
  }

  function renderItem(item, n) {
    var a = state.answers[item.id];
    var li = el("li", { className: "item" + (a ? " " + a.mark : "") });
    var p = PIPELINE[item.pipeline] || PIPELINE.unknown;
    li.appendChild(
      el("div", { className: "item-head" }, [
        el("span", { className: "id", text: n + ". " + item.id }),
        el("span", { className: "item-title", text: item.title }),
        item.kind === "criterion" ? el("span", { className: "badge " + p[1], text: p[0] }) : el("span", { className: "badge unverified", text: "请你表态" }),
        item.required ? null : el("span", { className: "badge", text: "可以以后再说" }),
      ]),
    );
    if (item.details.length) {
      li.appendChild(
        el(
          "ul",
          { className: "details" },
          item.details.map(function (d) {
            return el("li", { text: d });
          }),
        ),
      );
    }
    if (item.evidence) li.appendChild(el("div", { className: "evidence", text: "流水线的记录：" + item.evidence }));
    var labels = item.kind === "decision" ? [["pass", "同意"], ["fail", "不同意"], ["skip", "先不表态"]] : [["pass", "通过"], ["fail", "不对"], ["skip", "先不验"]];
    var marks = el(
      "div",
      { className: "marks" },
      labels.map(function (l) {
        return el("button", {
          className: "btn" + (a && a.mark === l[0] ? " on-" + l[0] : ""),
          text: l[1],
          disabled: state.info.readOnly ? "disabled" : null,
          onclick: function () {
            var cur = state.answers[item.id];
            state.answers[item.id] = { mark: l[0], note: cur ? cur.note : "" };
            save();
            render();
          },
        });
      }),
    );
    if (state.info.readOnly) marks.querySelectorAll("button").forEach(function (b) {
      b.disabled = true;
    });
    li.appendChild(marks);
    if (a && a.mark === "fail") {
      var ta = el("textarea", { placeholder: item.kind === "decision" ? "为什么不同意？希望怎样？" : "看到了什么？应该是什么样？（例如：点导出后提示“失败”，应该下载文件）" });
      ta.value = a.note || "";
      ta.addEventListener("input", function () {
        state.answers[item.id].note = ta.value;
        save();
      });
      li.appendChild(ta);
    }
    return li;
  }

  function render() {
    var list = $("items");
    list.innerHTML = "";
    state.info.items.forEach(function (item, i) {
      list.appendChild(renderItem(item, i + 1));
    });
    summary();
  }

  function showTry(result) {
    var box = $("try-box");
    box.hidden = false;
    box.innerHTML = "";
    box.appendChild(el("h2", { text: result.ok ? "已经跑起来了" : "没能一键跑起来" }));
    box.appendChild(el("div", { text: (result.message || "").split("\n")[0] }));
    var running = (result.services || []).filter(function (s) {
      return s.running && s.url;
    });
    if (running.length) {
      box.appendChild(
        el(
          "ul",
          { className: "services" },
          running.map(function (s) {
            return el("li", {}, [s.name + "：", el("a", { href: s.url, target: "_blank", rel: "noopener", text: s.url })]);
          }),
        ),
      );
      $("try-stop").hidden = false;
    }
    if (result.howTo && result.howTo.length) box.appendChild(el("pre", { className: "howto", text: result.howTo.join("\n") }));
  }

  function tryIt(stop) {
    var button = stop ? $("try-stop") : $("try");
    button.disabled = true;
    button.textContent = stop ? "正在停止…" : "正在启动，可能要一两分钟…";
    api("api/try", "POST", { stop: !!stop })
      .then(function (r) {
        if (stop) {
          toast(r.message);
          $("try-stop").hidden = true;
          $("try-box").hidden = true;
        } else showTry(r);
      })
      .catch(function (e) {
        toast(e.message);
      })
      .then(function () {
        button.disabled = false;
        button.textContent = stop ? "停止试用" : "把它跑起来试用";
      });
  }

  function submit() {
    state.busy = true;
    summary();
    api("api/submit", "POST", { answers: answersList(), reviewer: state.reviewer })
      .then(function (r) {
        toast(r.message);
        var done = el("section", { className: "card done" }, [el("h2", { text: "已提交：验收" + r.verdict }), el("div", { text: r.message })]);
        document.querySelector("main").insertBefore(done, document.querySelector("main").firstChild);
        window.scrollTo(0, 0);
      })
      .catch(function (e) {
        toast(e.message);
        state.busy = false;
        summary();
      });
  }

  function start() {
    api("api/info").then(function (info) {
      state.info = info;
      document.title = "验收清单：" + info.title;
      $("title").textContent = "验收清单：" + info.title;
      $("project").textContent = info.project + " · " + info.featureDir;
      $("sub").textContent = [info.reportVerdict ? "流水线结论：" + info.reportVerdict : null, info.accepted ? "上次验收：" + info.accepted : null, info.readOnly ? "只读：可以看，不能提交" : null]
        .filter(Boolean)
        .join("　");
      (info.draft && info.draft.answers ? info.draft.answers : []).forEach(function (a) {
        state.answers[a.id] = { mark: a.mark, note: a.note || "" };
      });
      state.reviewer = (info.draft && info.draft.reviewer) || "";
      $("reviewer").value = state.reviewer;
      if (info.notes && info.notes.length) {
        var n = $("notes");
        n.hidden = false;
        n.appendChild(el("h2", { text: "先看一下（来自提测说明）" }));
        n.appendChild(
          el(
            "ul",
            {},
            info.notes.map(function (t) {
              return el("li", { text: t });
            }),
          ),
        );
      }
      if (info.readOnly || info.running) $("try").hidden = true;
      if (!info.items.length) $("items").appendChild(el("li", { className: "item", text: "需求说明里没有找到验收标准（AC-编号）。" }));
      render();
    }).catch(function (e) {
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
