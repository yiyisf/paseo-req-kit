// The code review page (1.14; design system 1.15). Plain script, no framework: the server serves it
// next to its JSON API (api/info, api/draft, api/submit). Everything shown is set with textContent.
(function () {
  "use strict";
  var state = { info: null, comments: [], decisions: {}, reviewer: "", reviewers: "", note: "", saveTimer: null, busy: false, open: null };
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
    }, 8000);
  }

  function api(pathname, method, body) {
    return fetch(pathname, { method: method || "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok && data && data.message) throw new Error(data.message);
        return data;
      });
    });
  }

  function reviewersList() {
    return state.reviewers
      .split(/[,，、\s]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function hhmm() {
    var d = new Date();
    return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }

  function save() {
    if (state.info.readOnly) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      api("api/draft", "PUT", { comments: state.comments, decisions: state.decisions, reviewer: state.reviewer, reviewers: state.reviewers, note: state.note })
        .then(function () {
          $("saved").textContent = "已自动保存 " + hhmm();
        })
        .catch(function () {
          $("saved").textContent = "没保存上，网络恢复后再改一下会重试";
        });
    }, 600);
    count();
  }

  function fixes() {
    return Object.keys(state.decisions)
      .filter(function (id) {
        return state.decisions[id].mark === "fix";
      })
      .map(function (id) {
        return { id: id, note: state.decisions[id].note || "" };
      });
  }

  function count() {
    var comments = state.comments.filter(function (c) {
      return c.text.trim();
    }).length;
    var fix = fixes().length;
    var total = comments + fix + (state.note.trim() ? 1 : 0);
    $("count").textContent = total ? total + " 条修改意见" : "还没有修改意见";
    $("countsub").textContent = state.info.readOnly
      ? "这是只读链接，只能查看"
      : state.info.running
        ? "流水线正在运行，结束后才能提交评审"
        : "代码行上的意见 " + comments + " 条，AI 意见标为要改 " + fix + " 条";
    var blocked = state.info.readOnly || state.info.running || state.busy;
    $("changes").disabled = blocked || total === 0;
    $("changes").title = total === 0 ? "写一条意见，或把 AI 意见标为要改，才能退回修改" : "";
    $("changes").lastChild.textContent = total ? "退回修改（" + total + " 条）" : "退回修改";
    $("approve").disabled = blocked;
  }

  var SEVERITY = { "阻塞": ["failed", "octagon-alert"], "重要": ["warning", "triangle-alert"], "建议": ["muted", null], "待核实": ["ai", "circle-dashed"] };
  var STATUS = { fixed: ["success", "circle-check", "已修复"], rejected: ["outline", null, "修复时判为不成立"], wontfix: ["outline", null, "决定不修复"], open: ["outline", null, "还开着"] };

  function findingNode(f, inline) {
    var d = state.decisions[f.id] || {};
    var sev = SEVERITY[f.severity] || ["muted", null];
    var st = STATUS[f.status] || STATUS.open;
    var note = el("input", { className: "rk-input", placeholder: "补充一句（可不填）", value: d.note || "", "aria-label": "补充说明", hidden: d.mark === "fix" ? null : "" });
    note.style.flex = "1 1 200px";
    note.addEventListener("input", function (e) {
      state.decisions[f.id] = { mark: "fix", note: e.target.value };
      save();
    });
    function mark(m) {
      return function () {
        var cur = state.decisions[f.id] && state.decisions[f.id].mark;
        if (cur === m) delete state.decisions[f.id];
        else state.decisions[f.id] = { mark: m, note: (state.decisions[f.id] && state.decisions[f.id].note) || "" };
        render();
        save();
      };
    }
    var where = f.file ? f.file + (f.line ? ":" + f.line : "") : "";
    return el("div", { className: "rk-finding rk-finding--ai" + (d.mark === "ok" ? " is-ok" : "") }, [
      el("div", { className: "rk-finding__head" }, [
        el("span", { className: "rk-finding__who" }, [icon("sparkles", "ic ic-sm"), "AI 评审"]),
        el("span", { className: "rk-finding__id", text: f.id + (f.round ? " · 第 " + f.round + " 轮" : "") }),
        badge(sev[0], sev[1], f.severity),
        badge(st[0], st[1], st[2]),
        !inline && where
          ? el("a", { href: "#", className: "rk-finding__where", text: where, onclick: function (e) {
              e.preventDefault();
              jump(f.file, f.line);
            } })
          : null,
      ]),
      el("div", { className: "rk-finding__body", text: f.title }),
      f.suggestion ? el("div", { className: "rk-finding__fix", text: "建议：" + f.suggestion }) : null,
      state.info.readOnly
        ? null
        : el("div", { className: "rk-finding__acts" }, [
            el("div", { className: "rk-seg", role: "group", "aria-label": "这条意见要不要改" }, [
              el("button", { type: "button", className: "is-fix", "aria-pressed": String(d.mark === "fix"), text: "要改", onclick: mark("fix") }),
              el("button", { type: "button", className: "is-ok", "aria-pressed": String(d.mark === "ok"), text: "不用改", onclick: mark("ok") }),
            ]),
            note,
          ]),
    ]);
  }

  function jump(file, line) {
    var target = document.querySelector('[data-file="' + CSS.escape(file) + '"]' + (line ? '[data-n="' + line + '"]' : ""));
    if (!target) target = document.querySelector('[data-file-head="' + CSS.escape(file) + '"]');
    if (!target) return;
    var box = target.closest(".rk-diff");
    if (box && box.classList.contains("folded")) box.classList.remove("folded");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("rk-flash");
    setTimeout(function () {
      target.classList.remove("rk-flash");
    }, 1600);
  }

  function commentRow(file, line) {
    var existing = state.comments.find(function (c) {
      return c.file === file && c.line === line;
    });
    if (!existing) {
      existing = { file: file, line: line, text: "" };
      state.comments.push(existing);
    }
    var ta = el("textarea", { className: "rk-input", rows: "2", placeholder: "这一行哪里不对、应该怎么改", "aria-label": "你的意见" });
    ta.value = existing.text;
    ta.disabled = !!state.info.readOnly;
    ta.addEventListener("input", function (e) {
      existing.text = e.target.value;
      save();
    });
    var remove = el("button", { type: "button", className: "rk-btn rk-btn--ghost rk-btn--sm", onclick: function () {
      state.comments = state.comments.filter(function (c) {
        return c !== existing;
      });
      state.open = null;
      render();
      save();
    } }, [icon("trash-2", "ic ic-sm"), "删除"]);
    var card = el("div", { className: "rk-finding rk-finding--you" }, [
      el("div", { className: "rk-finding__head" }, [el("span", { className: "rk-finding__who" }, [icon("message-square-plus", "ic ic-sm"), "你的意见"]), el("span", { className: "rk-finding__where", text: file + ":" + line }), state.info.readOnly ? null : remove]),
      ta,
    ]);
    if (state.open === file + ":" + line && !existing.text) setTimeout(function () {
      ta.focus();
    });
    return el("tr", { className: "note" }, [el("td", { colspan: "3" }, [card])]);
  }

  var FILE_STATUS = { added: "新增", deleted: "删除", modified: "修改", renamed: "改名" };

  function renderFile(f, findingsByFile) {
    var mine = findingsByFile[f.path] || [];
    var owners = (state.info.reviewers.byFile || {})[f.path] || [];
    var box;
    var head = el("div", { className: "rk-diff__head", role: "button", tabindex: "0", "aria-label": "展开或折叠 " + f.path, "data-file-head": f.path }, [
      icon("chevron-down"),
      el("span", { className: "rk-diff__path", text: f.path + (f.oldPath ? "（原 " + f.oldPath + "）" : "") }),
      el("span", { className: "rk-diff__n" }, [el("span", { className: "a", text: "+" + f.additions }), " ", el("span", { className: "r", text: "−" + f.deletions })]),
      badge("muted", null, FILE_STATUS[f.status] || f.status),
      f.doc ? badge("muted", "file-text", "需求文档") : null,
      mine.length ? badge("ai", "sparkles", "AI 意见 " + mine.length) : null,
      el("span", { className: "rk-top__spacer" }),
      owners.length ? el("span", { className: "rk-cap", text: "审核人 " + owners.join(" ") }) : null,
    ]);
    function toggle() {
      box.classList.toggle("folded");
    }
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    var body = el("div", { className: "rk-diff__body" });
    var unplaced = mine.filter(function (x) {
      return !x.line || !f.hunks.some(function (h) {
        return h.lines.some(function (l) {
          return l.n === x.line;
        });
      });
    });
    if (unplaced.length) {
      var wrap = el("div", { className: "rk-col", style: "padding:12px 16px" });
      unplaced.forEach(function (x) {
        wrap.appendChild(findingNode(x, true));
      });
      body.appendChild(wrap);
    }
    if (f.binary) body.appendChild(el("div", { className: "rk-cap", style: "padding:12px 16px", text: "二进制文件，不显示内容。" }));
    f.hunks.forEach(function (h) {
      var table = el("table");
      table.appendChild(el("tr", { className: "hunk" }, [el("td", { className: "n" }), el("td", { className: "n" }), el("td", { text: h.header })]));
      h.lines.forEach(function (l) {
        var line = l.n || l.o;
        var row = el("tr", { className: "line " + (l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx"), "data-file": f.path, "data-n": l.n || "", title: state.info.readOnly ? "" : "点这一行写意见" }, [
          el("td", { className: "n", text: l.o === null ? "" : String(l.o) }),
          el("td", { className: "n", text: l.n === null ? "" : String(l.n) }),
          el("td", { className: "s", text: l.s }),
        ]);
        if (!state.info.readOnly) {
          row.addEventListener("click", function () {
            state.open = f.path + ":" + line;
            render();
          });
        }
        table.appendChild(row);
        mine
          .filter(function (x) {
            return x.line && l.n === x.line;
          })
          .forEach(function (x) {
            table.appendChild(el("tr", { className: "note" }, [el("td", { colspan: "3" }, [findingNode(x, true)])]));
          });
        var hasComment = state.comments.some(function (c) {
          return c.file === f.path && c.line === line;
        });
        if (hasComment || state.open === f.path + ":" + line) table.appendChild(commentRow(f.path, line));
      });
      body.appendChild(table);
    });
    if (f.truncated) body.appendChild(el("div", { className: "rk-cap", style: "padding:12px 16px", text: "改动太多，只显示了一部分。完整改动请在开发工具里看。" }));
    box = el("section", { className: "rk-diff" + (f.doc && !mine.length ? " folded" : ""), id: "file-" + f.path }, [head, body]);
    return box;
  }

  function navLink(label, iconName, n, cls, onclick) {
    return el("a", { href: "#", className: cls || "", onclick: function (e) {
      e.preventDefault();
      onclick();
    } }, [icon(iconName), el("span", { text: label }), n ? el("span", { className: "cr-files-n" + (/^AI/.test(n) ? " has-ai" : ""), text: n }) : null]);
  }

  function render() {
    var info = state.info;
    var byFile = {};
    info.findings.forEach(function (x) {
      if (x.file && info.files.some(function (f) {
        return f.path === x.file;
      })) (byFile[x.file] = byFile[x.file] || []).push(x);
    });
    var folded = {};
    document.querySelectorAll("#diffs .rk-diff").forEach(function (n) {
      folded[n.id] = n.classList.contains("folded");
    });
    var diffs = $("diffs");
    var y = window.scrollY;
    diffs.textContent = "";
    if (!info.files.length) {
      diffs.appendChild(el("div", { className: "rk-card rk-card--sm" }, [el("div", { className: "rk-empty" }, [icon("git-branch", "ic ic-xl"), el("h3", { text: info.base.commit ? "没有改动" : "找不到改动的起点" }), el("p", { text: info.base.commit ? "这个需求的分支和它分出来的地方一样。" : "找不到这个需求是从哪个提交开始的，没法列出改动。" })])]));
    }
    info.files.forEach(function (f) {
      var node = renderFile(f, byFile);
      if (node.id in folded) node.classList.toggle("folded", folded[node.id]);
      diffs.appendChild(node);
    });

    // AI findings: a summary card; the ones not on a changed line, and the serious ones, listed here too.
    var ai = $("ai");
    ai.textContent = "";
    var elsewhere = info.findings.filter(function (x) {
      return !byFile[x.file] || byFile[x.file].indexOf(x) < 0;
    });
    if (info.findings.length || info.rounds.length) {
      ai.hidden = false;
      var open = info.findings.filter(function (x) {
        return x.status === "open";
      }).length;
      var fixed = info.findings.filter(function (x) {
        return x.status === "fixed";
      }).length;
      var last = info.rounds.length ? info.rounds[info.rounds.length - 1] : null;
      ai.appendChild(
        el("div", { className: "rk-row", style: "justify-content:space-between" }, [
          el("span", { className: "rk-card__label rk-card__label--ai" }, [icon("sparkles", "ic ic-sm"), "AI 评审 · " + info.rounds.length + " 轮"]),
          el("span", { className: "rk-row", style: "gap:8px" }, [fixed ? badge("success", "circle-check", "已修复 " + fixed) : null, open ? badge("outline", null, "还开着 " + open) : null, last ? badge(last.verdict === "pass" ? "ai" : "warning", last.verdict === "pass" ? "sparkles" : "triangle-alert", last.verdict === "pass" ? "最后一轮：可以合并" : "最后一轮：需要修改") : null]),
        ]),
      );
      ai.appendChild(el("p", { text: info.findings.length ? "意见放在下面对应的代码行旁边。阻塞、重要的未处理意见建议标为要改；拿不准的请开发同事看一下。" : "AI 评审没有留下结构化的意见，详细内容见 code-review.md。" }));
      info.findings.forEach(function (x) {
        if (elsewhere.indexOf(x) >= 0 || ((x.severity === "阻塞" || x.severity === "重要") && x.status === "open")) ai.appendChild(findingNode(x, false));
      });
    }

    var nav = $("files");
    nav.textContent = "";
    nav.appendChild(el("div", { className: "rk-side__group", text: "概要" }));
    if (!$("summary").hidden) nav.appendChild(navLink("这次改了什么", "list-checks", null, "", function () {
      $("summary").scrollIntoView({ block: "start", behavior: "smooth" });
    }));
    if (!ai.hidden) nav.appendChild(navLink("AI 评审意见", "sparkles", info.findings.length ? String(info.findings.length) : null, "", function () {
      ai.scrollIntoView({ block: "start", behavior: "smooth" });
    }));
    var code = info.files.filter(function (f) {
      return !f.doc;
    });
    var docs = info.files.filter(function (f) {
      return f.doc;
    });
    [["代码 · " + code.length + " 个文件", code, "file-code"], ["需求文档 · " + docs.length + " 个", docs, "file-text"]].forEach(function (g) {
      if (!g[1].length) return;
      nav.appendChild(el("div", { className: "rk-side__group", text: g[0] }));
      g[1].forEach(function (f) {
        var n = (byFile[f.path] || []).length;
        nav.appendChild(navLink(f.doc ? f.path.split("/").pop() : f.path.split("/").slice(-2).join("/"), g[2], n ? "AI " + n : "+" + f.additions, f.doc ? "is-doc" : "", function () {
          jump(f.path, null);
        }));
      });
    });
    window.RkFill && window.RkFill();
    window.scrollTo(0, y);
    count();
  }

  function submit(verdict) {
    if (state.busy) return;
    var text = verdict === "approve" ? "确认评审通过？会记入 code-review.md 并提交。" : "确认退回修改？流水线会按这些意见修改（需求说明不变），改完再评审、再验证。";
    if (!window.confirm(text)) return;
    state.busy = true;
    count();
    api("api/submit", "POST", {
      verdict: verdict,
      reviewer: state.reviewer,
      reviewers: reviewersList(),
      comments: state.comments.filter(function (c) {
        return c.text.trim();
      }),
      fix: fixes(),
      note: state.note,
    })
      .then(function (r) {
        toast(r.message);
        return load();
      })
      .catch(function (e) {
        toast(e.message);
      })
      .then(function () {
        state.busy = false;
        count();
      });
  }

  function setBanner(kind, iconName, text) {
    var banner = $("status");
    banner.hidden = false;
    banner.className = "rk-banner rk-banner--" + kind;
    banner.textContent = "";
    banner.appendChild(icon(iconName));
    banner.appendChild(el("span", { text: text }));
  }

  function load() {
    return api("api/info").then(function (info) {
      state.info = info;
      document.title = "代码审查 · " + info.title;
      $("title").textContent = info.title;
      $("project").textContent = info.featureDir;
      $("project").hidden = false;
      $("readonly").hidden = !info.readOnly;
      var adds = 0,
        dels = 0;
      info.files.forEach(function (f) {
        if (!f.doc) {
          adds += f.additions;
          dels += f.deletions;
        }
      });
      $("sub").textContent =
        (info.branch ? "分支 " + info.branch : "") +
        (info.base.ref ? "，相对 " + info.base.ref : "") +
        "：改了 " +
        info.files.filter(function (f) {
          return !f.doc;
        }).length +
        " 个代码文件（+" + adds + " −" + dels + "）。";
      $("status").hidden = true;
      if (info.running) {
        setBanner("run", "loader-circle", "流水线正在运行，改动还会变化。可以先看，结束后再提交评审。");
      } else if (info.human) {
        var h = info.human;
        if (h.status === "approved") {
          setBanner(h.stale ? "warn" : "ok", h.stale ? "triangle-alert" : "circle-check", (h.stale ? "评审通过后代码又有改动，需要重新评审。" : "已评审通过") + "（" + h.reviewer + "，" + h.at.slice(0, 10) + (h.reviewers.length ? "，审核人 " + h.reviewers.join(" ") : "") + "）");
        } else {
          setBanner("warn", "undo-2", "上次退回了 " + h.items.length + " 条意见（" + h.reviewer + "，" + h.at.slice(0, 10) + "）" + (h.consumedAttempt ? "，第 " + h.consumedAttempt + " 次尝试在处理" : "，还没开始修改"));
        }
      }
      var sum = $("summary");
      sum.textContent = "";
      sum.hidden = !info.summary.length;
      if (info.summary.length) {
        sum.appendChild(el("span", { className: "rk-card__label" }, [icon("list-checks", "ic ic-sm"), "提测说明"]));
        sum.appendChild(el("h3", { style: "font-size:17px;line-height:26px", text: "这次改了什么" }));
        sum.appendChild(el("ul", { className: "cr-summary" }, info.summary.map(function (l) {
          return el("li", { text: l.replace(/^\s*[-*]\s+/, "") });
        })));
      }
      var d = info.draft || {};
      state.comments = Array.isArray(d.comments) ? d.comments : [];
      state.decisions = d.decisions && typeof d.decisions === "object" ? d.decisions : {};
      state.reviewer = d.reviewer || "";
      state.reviewers = typeof d.reviewers === "string" ? d.reviewers : info.reviewers.suggested.join(", ");
      state.note = d.note || "";
      $("reviewer").value = state.reviewer;
      $("reviewers").value = state.reviewers;
      $("reviewers").title = info.reviewers.source ? "默认取自 " + info.reviewers.source + "，可以改" : "项目里没有 CODEOWNERS，请填写";
      $("note").value = state.note;
      if (info.readOnly) ["reviewer", "reviewers", "note"].forEach(function (id) {
        $(id).disabled = true;
      });
      render();
    });
  }

  function start() {
    load().catch(function (e) {
      $("title").textContent = "打不开代码审查页";
      $("sub").textContent = e.message;
    });
    $("reviewer").addEventListener("input", function (e) {
      state.reviewer = e.target.value;
      save();
    });
    $("reviewers").addEventListener("input", function (e) {
      state.reviewers = e.target.value;
      save();
    });
    $("note").addEventListener("input", function (e) {
      state.note = e.target.value;
      save();
    });
    $("changes").addEventListener("click", function () {
      submit("changes");
    });
    $("approve").addEventListener("click", function () {
      submit("approve");
    });
  }

  start();
})();
