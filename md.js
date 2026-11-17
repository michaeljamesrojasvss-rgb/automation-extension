// Tiny, safe Markdown -> DOM renderer (no innerHTML, only http(s) links). Used for the AI suggestion panel.
// mdToDom("## Hi\n- a\n- b") -> DocumentFragment
// Task items ("- [ ] text" / "- [] text" / "- [x] text") become tickable checkboxes. Pass a Set as `ticks` to remember
// which items are ticked (keyed by the item text) across redraws; nothing is stored anywhere else.
function mdToDom(src, ticks) {
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    for (const k of kids.flat()) if (k != null) e.append(k);
    return e;
  };
  const link = (href, kids) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, kids);
  const INLINE = [
    { re: /`([^`]+)`/, mk: m => h("code", null, m[1]) },
    { re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, mk: (m, rec) => link(m[2], rec(m[1])) },
    { re: /\*\*(.+?)\*\*|__(.+?)__/, mk: (m, rec) => h("strong", null, rec(m[1] || m[2])) },
    { re: /~~(.+?)~~/, mk: (m, rec) => h("del", null, rec(m[1])) },
    { re: /\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])/, mk: (m, rec) => h("em", null, rec(m[1] || m[2])) },
    { re: /https?:\/\/[^\s<)]*[^\s<).,;:!?]/, mk: m => link(m[0], m[0]) }
  ];
  function inlineNodes(text) {
    const out = [];
    while (text) {
      let best = null;
      for (const r of INLINE) { const m = r.re.exec(text); if (m && (!best || m.index < best.m.index)) best = { m, r }; }
      if (!best) { out.push(text); break; }
      if (best.m.index) out.push(text.slice(0, best.m.index));
      out.push(best.r.mk(best.m, inlineNodes));
      text = text.slice(best.m.index + best.m[0].length);
    }
    return out;
  }

  const TASK = /^(?:\[( |x|X)?\]|(\u2610)|(\u2611|\u2612))\s*(\S.*)$/;   // [ ] [] [x] or the symbols \u2610 \u2611
  function taskLi(tk) {
    const key = tk[4].trim(), box = h("input", { type: "checkbox", class: "woc-chk" }), txt = h("span", { class: "woc-tt" }, inlineNodes(tk[4]));
    const li = h("li", { class: "woc-task" }, box, " ", txt);
    const sync = () => li.classList.toggle("woc-done", box.checked);
    box.checked = !!(ticks && ticks.has(key)) || /x/i.test(tk[1] || "") || !!tk[3];
    box.addEventListener("change", () => { if (ticks) { if (box.checked) ticks.add(key); else ticks.delete(key); } sync(); });
    sync();
    return li;
  }

  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const root = document.createDocumentFragment();
  let list = [];                                        // open (nested) lists: { indent, el, li }
  const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isItem = l => ITEM.test(l);
  const isHr = l => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  const isHead = l => /^#{1,6}\s+/.test(l);
  const isFence = l => /^\s*```/.test(l);
  const isSep = l => l.includes("|") && l.includes("-") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const startsBlock = (l, next) => isFence(l) || isHead(l) || isHr(l) || isItem(l) || /^\s*>/.test(l) || (l.includes("|") && next !== undefined && isSep(next));

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (isFence(line)) {
      const code = []; i++;
      while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
      i++; list = [];
      root.append(h("pre", null, h("code", null, code.join("\n"))));
      continue;
    }
    if (!line.trim()) {
      let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
      if (!(list.length && j < lines.length && (isItem(lines[j]) || /^\s{2,}\S/.test(lines[j])))) list = [];
      i++; continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { list = []; root.append(h("h" + m[1].length, null, inlineNodes(m[2]))); i++; continue; }
    if (isHr(line)) { list = []; root.append(h("hr")); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      list = [];
      const head = cells(line), rows = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      root.append(h("table", null,
        h("thead", null, h("tr", null, head.map(c => h("th", null, inlineNodes(c))))),
        h("tbody", null, rows.map(r => h("tr", null, r.map(c => h("td", null, inlineNodes(c))))))));
      continue;
    }
    if (/^\s*>/.test(line)) {
      list = []; const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      root.append(h("blockquote", null, q.flatMap((t, k) => k ? [h("br"), ...inlineNodes(t)] : inlineNodes(t))));
      continue;
    }
    if ((m = ITEM.exec(line))) {
      const indent = m[1].replace(/\t/g, "    ").length, tag = /\d/.test(m[2]) ? "ol" : "ul";
      while (list.length && list[list.length - 1].indent > indent) list.pop();
      const top = list[list.length - 1], tk = TASK.exec(m[3]), li = tk ? taskLi(tk) : h("li", null, inlineNodes(m[3]));
      if (!top || indent > top.indent) {
        const el = h(tag); (top ? top.li : root).append(el); el.append(li);
        list.push({ indent, el, li });
      } else { top.el.append(li); top.li = li; }
      i++; continue;
    }
    if (list.length && /^\s+\S/.test(line)) { list[list.length - 1].li.append(h("br"), ...inlineNodes(line.trim())); i++; continue; }
    // paragraph
    list = [];
    const para = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    root.append(h("p", null, para.flatMap((t, k) => k ? [h("br"), ...inlineNodes(t)] : inlineNodes(t))));
  }
  return root;
}
