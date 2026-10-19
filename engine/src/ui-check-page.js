// Runs inside the page being checked (req ui-check, or an agent's browser_evaluate): finds layout
// problems a person would see, and lists the page's visible labels, as plain data. It must stay
// one self-contained function: it is sent to the browser as text.
// Input: { width, narrow, state } — state: show only [data-state="<state>"] (prototypes).
(function reqKitUiCheck(input) {
  const opts = input || {};
  const doc = document;
  const win = window;
  if (opts.state) {
    for (const el of doc.querySelectorAll("[data-state]")) {
      if (el.getAttribute("data-state") !== opts.state) el.style.setProperty("display", "none", "important");
    }
  }
  const W = win.innerWidth;
  const H_DOC = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
  const issues = [];
  const add = (kind, el, detail) => issues.push({ kind, target: el ? describe(el) : null, detail });

  function visible(el) {
    if (!el.isConnected) return false;
    const cs = win.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  }
  function text(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value || el.getAttribute("placeholder") || "";
    if (el.tagName === "IMG") return el.getAttribute("alt") || "";
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }
  const KIND = { BUTTON: "按钮", A: "链接", INPUT: "输入框", SELECT: "下拉框", TEXTAREA: "多行输入框", IMG: "图片", TABLE: "表格", TH: "表头", TD: "单元格", LABEL: "标签", LI: "列表项", H1: "标题", H2: "标题", H3: "标题", H4: "小标题", H5: "小标题", H6: "小标题", P: "文字", SPAN: "文字" };
  function describe(el) {
    const role = el.getAttribute("role");
    let kind = KIND[el.tagName] || (role === "button" ? "按钮" : "区域");
    if (el.tagName === "INPUT" && /submit|button/.test(el.type)) kind = "按钮";
    const r = el.getBoundingClientRect();
    return {
      kind,
      text: text(el).slice(0, 60),
      selector: cssPath(el),
      box: { x: Math.round(r.left + win.scrollX), y: Math.round(r.top + win.scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }
  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n.tagName !== "HTML"; n = n.parentElement) {
      if (n.id) {
        parts.unshift("#" + CSS.escape(n.id));
        break;
      }
      let p = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) p += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(p);
      if (n.tagName === "BODY") break;
    }
    return parts.join(" > ");
  }
  function rgb(c) {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 };
  }
  function hex(c) {
    return c ? "#" + [c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("") : "";
  }
  function lum(c) {
    const f = (x) => {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  /** The color behind an element, or null when an image or gradient is behind it. */
  function backdrop(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = win.getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = rgb(cs.backgroundColor);
      if (c && c.a > 0.95) return c;
      if (c && c.a > 0.05) return null;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  const all = Array.from(doc.body ? doc.body.querySelectorAll("*") : []).filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|path|BR)$/.test(el.tagName) && visible(el));
  const interactive = all.filter((el) => /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName) || ["button", "link", "tab", "checkbox", "switch", "menuitem"].includes(el.getAttribute("role")));
  const leaves = all.filter((el) => ownText(el) || /^(IMG|INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName));

  // 1. Wider than the window: what sticks out on the right.
  const docWidth = doc.documentElement.scrollWidth;
  if (docWidth > W + 1) {
    const out = all.filter((el) => el.getBoundingClientRect().right > W + 1 && !(el.parentElement && el.parentElement.getBoundingClientRect().right > W + 1 && el.parentElement !== doc.body));
    out.slice(0, 5).forEach((el) => add("overflow", el, { overBy: Math.round(el.getBoundingClientRect().right - W) }));
    if (out.length === 0) add("overflow", null, { overBy: docWidth - W });
  }
  // 2. Cut-off text (hidden overflow, ellipsis).
  for (const el of leaves) {
    if (!ownText(el)) continue;
    const cs = win.getComputedStyle(el);
    const clipsX = cs.overflowX !== "visible" || cs.textOverflow === "ellipsis";
    const clipsY = cs.overflowY !== "visible";
    if ((clipsX && el.scrollWidth > el.clientWidth + 1) || (clipsY && el.scrollHeight > el.clientHeight + 2 && cs.overflowY !== "auto" && cs.overflowY !== "scroll")) {
      add("clipped", el, { shown: el.clientWidth, needed: el.scrollWidth });
    }
  }
  // 3. Things on top of each other (neither inside the other).
  const boxes = leaves.slice(0, 500).map((el) => ({ el, r: el.getBoundingClientRect() }));
  let overlaps = 0;
  for (let i = 0; i < boxes.length && overlaps < 10; i++) {
    for (let j = i + 1; j < boxes.length && overlaps < 10; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 2 || h <= 2) continue;
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (w * h >= 0.3 * smaller) {
        overlaps++;
        add("overlap", a.el, { other: describe(b.el), area: { w: Math.round(w), h: Math.round(h) } });
      }
    }
  }
  // 4. Off the page on the left or top.
  for (const el of leaves) {
    const r = el.getBoundingClientRect();
    if (r.right + win.scrollX < 2 || r.bottom + win.scrollY < 2) add("offscreen", el, {});
  }
  // 5. Images that did not load.
  for (const img of doc.querySelectorAll("img")) {
    if (img.complete && img.naturalWidth === 0 && visible(img)) add("broken_image", img, { src: (img.getAttribute("src") || "").slice(0, 120) });
  }
  // 6. Too small to tap (narrow screens).
  if (opts.narrow) {
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) add("small_target", el, { w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  // 7. Text that is hard to read on its background.
  let lowContrast = 0;
  for (const el of leaves) {
    if (lowContrast >= 10 || !ownText(el)) continue;
    const cs = win.getComputedStyle(el);
    const fg = rgb(cs.color);
    const bg = backdrop(el);
    if (!fg || !bg || fg.a < 0.5) continue;
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize);
    // Only text that is clearly hard to read (WCAG asks 4.5:1; many component libraries' own
    // buttons sit just under it, and reporting those would bury the real problems).
    const large = size >= 24 || (size >= 18.6 && Number(cs.fontWeight) >= 700);
    const need = large ? 2.5 : 3;
    if (ratio < need && !el.closest("[disabled],[aria-disabled=true]")) {
      lowContrast++;
      add("low_contrast", el, { ratio: Math.round(ratio * 10) / 10, need, color: hex(fg), background: hex(bg) });
    }
  }
  // 8. Controls nobody can name: inputs without a label, buttons without text.
  for (const el of interactive) {
    const named = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title");
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !/hidden|submit|button|image|reset/.test(el.type || "")) {
      const before = el.previousElementSibling;
      const labelled =
        named ||
        el.getAttribute("placeholder") ||
        el.closest("label") ||
        (el.id && doc.querySelector('label[for="' + CSS.escape(el.id) + '"]')) ||
        (before && /^(LABEL|SPAN)$/.test(before.tagName) && text(before));
      if (!labelled) add("no_label", el, {});
    } else if (!named && !text(el) && !el.querySelector("img[alt]:not([alt=''])")) {
      add("no_name", el, {});
    }
  }

  // The labels people read: titles, buttons, links, field names, table headers, hints in the
  // marked regions. Sample data in table cells is left out (it differs from the real page).
  const labels = [];
  const seen = new Set();
  const push = (t) => {
    const v = (t || "").replace(/\s+/g, " ").trim();
    if (v && v.length <= 80 && !seen.has(v) && !/^[\d\s.,:\-/%¥$]+$/.test(v)) {
      seen.add(v);
      labels.push(v);
    }
  };
  for (const el of all) {
    if (/^(H1|H2|H3|H4|H5|H6|BUTTON|A|LABEL|TH|LEGEND|SUMMARY|CAPTION|OPTION)$/.test(el.tagName) || ["button", "tab", "link", "menuitem", "heading"].includes(el.getAttribute("role"))) push(text(el));
    if (el.getAttribute("placeholder")) push(el.getAttribute("placeholder"));
    if (el.tagName === "INPUT" && /submit|button/.test(el.type)) push(el.value);
    if (el.closest("[data-ac]") && !el.closest("td") && ownText(el)) push(ownText(el));
  }
  if (doc.title) push(doc.title);

  return { width: W, height: H_DOC, title: doc.title, issues, labels };
});
