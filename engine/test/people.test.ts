// 1.12: notification events say who they are for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { peopleOf } from "../src/notifiers.js";

test("按人通知：需求方要处理的事和结果发给需求方本人（带 people 配置中的账号）；其余发到群", () => {
  const card = { system: "ALM", id: "CM#1", url: null };
  const people = { 张广祥: { um: "ZHANGGX001" } };
  assert.deepEqual(peopleOf("blocked", "张广祥", card, people), {
    audience: "requester",
    requester: "张广祥",
    card,
    recipients: [{ name: "张广祥", accounts: { um: "ZHANGGX001" } }],
  });
  assert.deepEqual(peopleOf("completed", "李四", card, people).recipients, [{ name: "李四", accounts: {} }]);
  for (const type of ["failed", "milestone", "permission", "alert"] as const) assert.equal(peopleOf(type, "张广祥", card, people).audience, "team");
  assert.deepEqual(peopleOf("approval", null, null, people), { audience: "team", requester: null, card: null, recipients: [] });
});
