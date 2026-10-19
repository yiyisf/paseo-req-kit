# 用浏览器验证网页界面

`<pipeline-context>` 中有"浏览器"一行，说明你可以使用 Paseo 内置的浏览器（`browser_*` 工具）。需求方可以在 Paseo 桌面端实时看到你在浏览器中的操作。

涉及网页界面的验收标准，**像使用者一样在浏览器里实际操作一遍**，而不是只看代码或只调接口：

1. 用 `browser_new_tab` 打开服务地址（服务由 Paseo 管理时用给出的地址）。
2. 按验收标准的"操作"一步步做：`browser_snapshot` 找到元素，用 `browser_click`、`browser_fill`、`browser_select` 等操作，用 `browser_wait` 等待结果出现。
3. 用 `browser_snapshot`（文字形式的页面结构）核对页面上的结果是否符合"预期结果"。版面问题用上面的界面检查命令；在这个浏览器里也可以检查：用 `browser_evaluate` 运行 `界面检查命令 --script` 输出的那段函数，它返回文字形式的问题清单。只在需要给需求方看某个画面时才用 `browser_screenshot`：截图会整张发给你，很费 token，看图判断也不如文字可靠。需要检查手机布局时用 `browser_resize`。出现异常时用 `browser_logs` 查看控制台和网络请求。
4. 在产物中记录：打开的地址、操作步骤、看到的结果、对应的 AC 编号，并注明"浏览器验证"（截了图的，说明截图在该步骤 agent 的对话记录中）。
5. 用完关闭你打开的标签页（`browser_close_tab`）。

浏览器工具返回 `browser_no_host`（桌面端没有连接）或 `browser_disabled` 时，不要反复重试，改用接口调用、端到端测试等其他方式验证，并在产物中说明浏览器验证没能进行。不要在浏览器中登录生产环境或输入真实的个人信息。
