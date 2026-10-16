#!/usr/bin/env node
// Stands in for `shenbing alm-card` in the card tests (1.10): cards live in a JSON file
// (FAKE_ALM_CARDS, next to this script by default); every call is logged to <cards>.log.
//   alm-card view <id> --fields …          {"success":true,"data":{globalId,name,state,createdBy,subsysName,description}}
//   alm-card edit <id> -b <description>     replaces the description
//   alm-card edit <id> --state-detail <s>   changes the state
//   alm-card list --project-id <p> [-S <state>] [-s <keyword>] [-L <n>] [-P <page>]
//                                           {"success":true,"data":{"list":[…],"total":n}} (projectId, state, keyword in the title)
import fs from "node:fs";
import path from "node:path";

const file = process.env.FAKE_ALM_CARDS ?? path.join(path.dirname(new URL(import.meta.url).pathname), "cards.json");
const args = process.argv.slice(2);
fs.appendFileSync(`${file}.log`, `${JSON.stringify(args)}\n`);
const cards = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const [, command, id] = args;
const card = cards[id];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (command === "list") {
  const project = opt("--project-id");
  const state = opt("-S");
  const keyword = opt("-s");
  const limit = Number(opt("-L") ?? 10);
  const page = Number(opt("-P") ?? 1);
  const all = Object.entries(cards)
    .filter(([, c]) => (!project || c.projectId === project) && (!state || c.state === state) && (!keyword || c.name.includes(keyword)))
    .map(([globalId, c]) => ({ globalId, name: c.name, state: c.state, subsysName: c.subsysName, createdBy: c.createdBy }));
  console.log(JSON.stringify({ success: true, data: { list: all.slice((page - 1) * limit, page * limit), total: all.length } }));
  process.exit(0);
}
if (command === "view") {
  if (!card) {
    console.log(JSON.stringify({ success: false, message: `卡片 ${id} 不存在` }));
    process.exit(1);
  }
  console.log("正在查询…");
  console.log(JSON.stringify({ success: true, data: { globalId: id, ...card } }, null, 2));
} else if (command === "edit") {
  if (!card) {
    console.error(`卡片 ${id} 不存在`);
    process.exit(1);
  }
  const b = args.indexOf("-b");
  if (b >= 0) card.description = args[b + 1];
  const s = args.indexOf("--state-detail");
  if (s >= 0) card.state = args[s + 1];
  fs.writeFileSync(file, JSON.stringify(cards, null, 2));
  console.log("修改成功");
} else {
  console.error(`不认识的命令 ${command}`);
  process.exit(2);
}
