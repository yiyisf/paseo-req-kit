// The code review page (1.14). Plain script, no framework: the server serves it next to its JSON
// API (api/info, api/draft, api/submit). Everything shown is set with textContent.
(function () {
  "use strict";
  var state = { info: null, comments: [], decisions: {}, reviewer: "", reviewers: "", note: "", saveTimer: null, busy: false, open: null };
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

  function save() {
    if (state.info.readOnly) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      api("api/draft", "PUT", { comments: state.comments, decisions: state.decisions, reviewer: state.reviewer, reviewers: state.reviewers, note: state.note }).catch(function () {});
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
    $("count").textContent = "代码行上的意见 " + comments + " 条，AI 意见标为要改 " + fix + " 条";
    var blocked = state.info.readOnly || state.info.running || state.busy;
    $("changes").disabled = blocked || total === 0;
    $("changes").textContent = total ? "退回修改（" + total + " 条意见）" : "退回修改";
    $("approve").disabled = blocked;
  }

  var SEVERITY_CLASS = { "阻塞": "danger", "重要": "warn", "建议": "", "待核实": "" };
  var STATUS_TEXT = { fixed: "已修复", rejected: "修复时判为不成立", wontfix: "决定不修复", open: "未处理" };

  function findingNode(f, compact) {
    var d = state.decisions[f.id] || {};
    var note = el("input", { className: "note-input", placeholder: "补充一句（可不填）", value: d.note || "", hidden: d.mark === "fix" ? null : "" });
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
    return el("div", { className: "finding " + (SEVERITY_CLASS[f.severity] || "") + (d.mark ? " decided-" + d.mark : "") }, [
      el("div", { className: "finding-head" }, [
        el("span", { className: "badge " + (SEVERITY_CLASS[f.severity] || ""), text: "AI · " + f.severity }),
        el("b", { text: f.id }),
        f.status !== "open" ? el("span", { className: "badge " + (f.status === "fixed" ? "ok" : ""), text: STATUS_TEXT[f.status] }) : null,
        !compact && where ? el("a", { href: "#", className: "where", text: where, onclick: function (e) {
          e.preventDefault();
          jump(f.file, f.line);
        } }) : null,
      ]),
      el("div", { className: "finding-text", text: f.title }),
      f.suggestion ? el("div", { className: "muted small", text: "建议：" + f.suggestion }) : null,
      state.info.readOnly
        ? null
        : el("div", { className: "marks" }, [
            el("button", { className: "btn small" + (d.mark === "fix" ? " on-fix" : ""), text: "要改", onclick: mark("fix") }),
            el("button", { className: "btn small" + (d.mark === "ok" ? " on-ok" : ""), text: "不用改", onclick: mark("ok") }),
          ]),
      note,
    ]);
  }

  function jump(file, line) {
    var target = document.querySelector('[data-file="' + CSS.escape(file) + '"]' + (line ? '[data-n="' + line + '"]' : ""));
    if (!target) target = document.querySelector('[data-file-head="' + CSS.escape(file) + '"]');
    if (target) {
      var box = target.closest(".file");
      if (box && box.classList.contains("folded")) box.classList.remove("folded");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("flash");
      setTimeout(function () {
        target.classList.remove("flash");
      }, 1600);
    }
  }

  function commentBox(file, line) {
    var existing = state.comments.find(function (c) {
      return c.file === file && c.line === line;
    });
    if (!existing) {
      existing = { file: file, line: line, text: "" };
      state.comments.push(existing);
    }
    var ta = el("textarea", { rows: "2", placeholder: "这一行哪里不对、应该怎么改" });
    ta.value = existing.text;
    ta.addEventListener("input", function (e) {
      existing.text = e.target.value;
      save();
    });
    var remove = el("button", { className: "btn small", text: "删除", onclick: function () {
      state.comments = state.comments.filter(function (c) {
        return c !== existing;
      });
      state.open = null;
      render();
      save();
    } });
    return el("tr", { className: "comment-row" }, [el("td", { colspan: "3" }, [el("div", { className: "comment" }, [el("div", { className: "muted small", text: "你的意见（" + file + ":" + line + "）" }), ta, state.info.readOnly ? null : remove])])]);
  }

  function renderFile(f, findingsByFile) {
    var mine = findingsByFile[f.path] || [];
    var owners = (state.info.reviewers.byFile || {})[f.path] || [];
    var head = el("div", { className: "file-head", "data-file-head": f.path, onclick: function () {
      box.classList.toggle("folded");
    } }, [
      el("span", { className: "path", text: f.path + (f.oldPath ? "（原 " + f.oldPath + "）" : "") }),
      el("span", { className: "badge", text: { added: "新增", deleted: "删除", modified: "修改", renamed: "改名" }[f.status] }),
      el("span", { className: "plus", text: "+" + f.additions }),
      el("span", { className: "minus", text: "−" + f.deletions }),
      f.doc ? el("span", { className: "badge", text: "需求文档" }) : null,
      mine.length ? el("span", { className: "badge warn", text: "AI 意见 " + mine.length }) : null,
      owners.length ? el("span", { className: "muted small", text: "负责人 " + owners.join(" ") }) : null,
    ]);
    var body = el("div", { className: "file-body" });
    var unplaced = mine.filter(function (x) {
      return !x.line || !f.hunks.some(function (h) {
        return h.lines.some(function (l) {
          return l.n === x.line;
        });
      });
    });
    unplaced.forEach(function (x) {
      body.appendChild(findingNode(x, true));
    });
    if (f.binary) body.appendChild(el("div", { className: "muted pad", text: "二进制文件，不显示内容。" }));
    f.hunks.forEach(function (h) {
      var table = el("table", { className: "diff" });
      table.appendChild(el("tr", { className: "hunk" }, [el("td", { colspan: "3", text: h.header })]));
      h.lines.forEach(function (l) {
        var line = l.n || l.o;
        var row = el("tr", { className: "line " + (l.t === "+" ? "add" : l.t === "-" ? "del" : ""), "data-file": f.path, "data-n": l.n || "", title: state.info.readOnly ? "" : "点这一行写意见" }, [
          el("td", { className: "num", text: l.o === null ? "" : String(l.o) }),
          el("td", { className: "num", text: l.n === null ? "" : String(l.n) }),
          el("td", { className: "code", text: (l.t === " " ? " " : l.t) + " " + l.s }),
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
            table.appendChild(el("tr", { className: "finding-row" }, [el("td", { colspan: "3" }, [findingNode(x, true)])]));
          });
        var hasComment = state.comments.some(function (c) {
          return c.file === f.path && c.line === line;
        });
        if (hasComment || state.open === f.path + ":" + line) table.appendChild(commentBox(f.path, line));
      });
      body.appendChild(table);
    });
    if (f.truncated) body.appendChild(el("div", { className: "muted pad", text: "改动太多，只显示了一部分。完整改动请在开发工具里看。" }));
    var box = el("section", { className: "file" + (f.doc && !mine.length ? " folded" : ""), id: "file-" + f.path }, [head, body]);
    return box;
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
    document.querySelectorAll(".file").forEach(function (n) {
      folded[n.id] = n.classList.contains("folded");
    });
    var diffs = $("diffs");
    var y = window.scrollY;
    diffs.textContent = "";
    if (!info.files.length) diffs.appendChild(el("div", { className: "card muted", text: info.base.commit ? "没有找到改动。" : "找不到这个需求是从哪个提交开始的，没法列出改动。" }));
    info.files.forEach(function (f) {
      var node = renderFile(f, byFile);
      if (node.id in folded) node.classList.toggle("folded", folded[node.id]);
      diffs.appendChild(node);
    });
    // The AI findings not on a changed file: listed at the top.
    var ai = $("ai");
    ai.textContent = "";
    var elsewhere = info.findings.filter(function (x) {
      return !byFile[x.file] || byFile[x.file].indexOf(x) < 0;
    });
    if (info.findings.length) {
      ai.hidden = false;
      var open = info.findings.filter(function (x) {
        return x.status === "open";
      }).length;
      ai.appendChild(el("h2", { text: "AI 评审意见（" + info.findings.length + " 条，未处理 " + open + " 条）" }));
      ai.appendChild(el("p", { className: "muted small", text: "在代码旁边也能看到。阻塞、重要的未处理意见建议标为要改；拿不准的请开发同事看一下。" }));
      info.findings.forEach(function (x) {
        if (elsewhere.indexOf(x) >= 0 || x.severity === "阻塞" || x.severity === "重要") ai.appendChild(findingNode(x, false));
      });
    } else if (info.rounds.length) {
      ai.hidden = false;
      ai.appendChild(el("h2", { text: "AI 评审" }));
      ai.appendChild(el("p", { className: "muted", text: "AI 评审没有留下结构化的意见，详细内容见 code-review.md。" }));
    }
    var nav = $("files");
    nav.textContent = "";
    nav.appendChild(el("div", { className: "nav-title", text: "改动的文件（" + info.files.length + "）" }));
    info.files.forEach(function (f) {
      nav.appendChild(el("a", { href: "#", className: f.doc ? "doc" : "", onclick: function (e) {
        e.preventDefault();
        jump(f.path, null);
      } }, [el("span", { text: f.path }), (byFile[f.path] || []).length ? el("span", { className: "badge warn", text: String(byFile[f.path].length) }) : null]));
    });
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

  function load() {
    return api("api/info").then(function (info) {
      state.info = info;
      $("project").textContent = info.featureDir;
      $("title").textContent = "代码审查：" + info.title;
      var adds = 0,
        dels = 0;
      info.files.forEach(function (f) {
        if (!f.doc) {
          adds += f.additions;
          dels += f.deletions;
        }
      });
      var last = info.rounds.length ? info.rounds[info.rounds.length - 1] : null;
      $("sub").textContent =
        (info.branch ? "分支 " + info.branch : "") +
        (info.base.ref ? "，相对 " + info.base.ref : "") +
        "：改了 " + info.files.filter(function (f) {
          return !f.doc;
        }).length + " 个代码文件（+" + adds + " −" + dels + "）" +
        (last ? "；AI 评审 " + info.rounds.length + " 轮，最后一轮" + (last.verdict === "pass" ? "通过" : "需要修改") : "");
      var banner = $("status");
      banner.hidden = true;
      banner.className = "banner";
      if (info.running) {
        banner.hidden = false;
        banner.textContent = "流水线正在运行，改动还会变化。可以先看，结束后再提交评审。";
      } else if (info.human) {
        banner.hidden = false;
        var h = info.human;
        if (h.status === "approved") {
          banner.className = "banner " + (h.stale ? "warn" : "ok");
          banner.textContent = (h.stale ? "评审通过后代码又有改动，需要重新评审。" : "已评审通过") + "（" + h.reviewer + "，" + h.at.slice(0, 10) + (h.reviewers.length ? "，审核人 " + h.reviewers.join(" ") : "") + "）";
        } else {
          banner.className = "banner warn";
          banner.textContent = "上次退回了 " + h.items.length + " 条意见（" + h.reviewer + "，" + h.at.slice(0, 10) + "）" + (h.consumedAttempt ? "，第 " + h.consumedAttempt + " 次尝试在处理" : "，还没开始修改");
        }
      }
      var sum = $("summary");
      sum.textContent = "";
      if (info.summary.length) {
        sum.hidden = false;
        sum.appendChild(el("h2", { text: "这次改了什么（来自提测说明）" }));
        info.summary.forEach(function (l) {
          sum.appendChild(el("div", { text: l.replace(/^\s*[-*]\s+/, "• ") }));
        });
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
