// dsh-memory-acc — Client half: the first-run engine gate.
//
// Two memory engines in one profile means two memory chains per turn. The host
// already prevents that (ACC drops its tools when another engine signed in), so
// this dialog is the decision, not the enforcement: pick one and stop asking.
//
// Rendered from a zero-size slot entry as a fixed overlay. Nothing is written to
// document.body and no Harness client package is imported: a throwing component
// would blank the slot, so the whole component is written defensively.
window.__ModuleLoader__.load({
	id: "dsh-memory-acc",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var inject = ["slots", "sessions", "uiWorkspace", "uiConversation"];
		var React = require("react");
		var h = React.createElement;

		var API = "/dsh-acc";
		var CHOICE_KEY = "dsh-acc.engine-choice";
		var DIM = "var(--dsw-alias-label-tertiary, #8a8a92)";
		var BORDER = "var(--dsw-alias-border-l3, rgba(127,127,127,0.35))";
		var ACCENT = "var(--dsw-alias-state-business-primary, #4a7dff)";

		function readChoice() {
			try { return window.localStorage.getItem(CHOICE_KEY) } catch (e) { return null }
		}
		function clearChoice() {
			try { window.localStorage.removeItem(CHOICE_KEY) } catch (e) { /* private */ }
		}
		function writeChoice(value) {
			try { window.localStorage.setItem(CHOICE_KEY, value) } catch (e) { /* private mode */ }
		}

		function engineRow(engine, title, blurb) {
			return h("div", {
				key: engine.id,
				style: { border: "1px solid " + BORDER, borderRadius: 10, padding: "10px 12px", marginTop: 8 }
			},
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 8 } },
					h("span", { style: { fontWeight: 600 } }, title),
					h("span", { style: { fontSize: 11, color: DIM } }, engine.id + " v" + engine.version)),
				h("div", { style: { fontSize: 12, color: DIM, marginTop: 4 } }, blurb));
		}

		function EngineGate() {
			var infoState = React.useState(null);
			var info = infoState[0];
			var setInfo = infoState[1];
			var hiddenState = React.useState(false);
			var hidden = hiddenState[0];
			var setHidden = hiddenState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var noteState = React.useState("");
			var note = noteState[0];
			var setNote = noteState[1];

			React.useEffect(function () {
				var alive = true;
				fetch(API + "/engines", { credentials: "same-origin" })
					.then(function (r) { return r.json() })
					.then(function (body) { if (alive) setInfo(body) })
					.catch(function () { if (alive) setInfo({ conflict: false }) });
				return function () { alive = false }
			}, []);

			if (hidden || info === null || info.conflict !== true) return null;
			// 已经执行过一次选择就不再打扰：宿主里的握手表不会因为 patch 改动而立刻清空，
			// 所以"冲突仍然为真"不能被当成"用户还没选"。
			if (readChoice() !== null) return null;

			var engines = Array.isArray(info.engines) ? info.engines : [];
			var acc = engines.filter(function (e) { return e.kind === "acc" })[0];
			var other = engines.filter(function (e) { return e.kind !== "acc" })[0];

			function keepOther() {
				if (busy) return;
				setBusy(true);
				setNote("正在停用 ACC…");
				var me = acc !== undefined ? acc.id : "dsh-memory-acc";
				fetch(API + "/disable?target=" + encodeURIComponent(me), { credentials: "same-origin", method: "POST" })
					.then(function (r) { return r.json() })
					.then(function (body) {
						if (body !== null && body.ok === true) {
							writeChoice("other");
							fetch(API + "/reset", { credentials: "same-origin", method: "POST" }).catch(function () { /* 同上 */ });
							setNote("已停用 ACC，正在重新加载…");
							window.setTimeout(function () { window.location.reload() }, 700);
							return;
						}
						setNote("停用失败：" + ((body && body.error) || "未知原因"));
						setBusy(false);
					})
					.catch(function (error) { setNote("停用失败：" + String((error && error.message) || error)); setBusy(false) });
			}

			function useAcc() {
				if (busy) return;
				setBusy(true);
				setNote("正在切换…");
				var target = other !== undefined ? other.id : "memory";
				fetch(API + "/disable?target=" + encodeURIComponent(target), { credentials: "same-origin", method: "POST" })
					.then(function (r) { return r.json() })
					.then(function (body) {
						if (body !== null && body.ok === true) {
							writeChoice("acc");
							fetch(API + "/reset", { credentials: "same-origin", method: "POST" }).catch(function () { /* 表清不掉也不阻塞 */ });
							setNote("已切换，正在重新加载…");
							window.setTimeout(function () { window.location.reload() }, 600);
							return;
						}
						setNote("切换失败：" + ((body && body.error) || "未知原因"));
						setBusy(false);
					})
					.catch(function (error) {
						setNote("切换失败：" + String((error && error.message) || error) + "（F12 的 Network 里有这一条请求）");
						setBusy(false);
					});
			}

			var head = h("div", { style: { fontSize: 16, fontWeight: 600 } }, "检测到两个记忆引擎");
			var blurb = h("div", { style: { fontSize: 12, color: DIM, marginTop: 6, lineHeight: 1.7 } },
				"两个引擎同时加载，每轮对话会跑两条记忆链——重复的 token 开销，而且以后会争同一个上下文。只能留一个。");
			var rowA = other !== undefined ? engineRow(other, "标准版", "更适合工作：按作用域切片，只留结论，上下文干净、每轮开销小。") : null;
			var rowB = acc !== undefined ? engineRow(acc, "ACC 完整版", "更适合聊天：保存每一次完整对话与图片，记得住前因后果，能回头翻。默认借用 harness 自己的模型，不用填 key。") : null;

			var keepBtn = h("button", {
				onClick: keepOther,
				style: { padding: "8px 14px", borderRadius: 8, cursor: "pointer", border: "1px solid " + BORDER, background: "transparent", color: "inherit" }
			}, "保留标准版");

			var accBtn = h("button", {
				onClick: useAcc,
				disabled: busy,
				style: { padding: "8px 14px", borderRadius: 8, cursor: busy ? "default" : "pointer", border: "none", background: ACCENT, color: "#fff", opacity: busy ? 0.6 : 1 }
			}, busy ? "切换中…" : "改用 ACC");

			var actions = h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 } }, keepBtn, accBtn);
			var noteLine = note.length > 0 ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #d94a4a)", marginTop: 10, textAlign: "right", lineHeight: 1.6 } }, note) : null;

			var card = h("div", {
				style: {
					background: "var(--dsw-alias-bg-layer-1, #fff)", border: "1px solid " + BORDER,
					borderRadius: 12, padding: 22, maxWidth: 520, width: "calc(100% - 48px)",
					boxShadow: "0 24px 64px rgba(0,0,0,0.35)", fontSize: 13
				}
			}, [head, blurb, rowA, rowB, actions, noteLine]);

			return h("div", {
				style: { position: "fixed", inset: 0, zIndex: 2147483000, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }
			}, card);
		}


		// --- 侧边栏「常驻聊天」与输入框胶囊 ---------------------------------------
		var residentState = { id: "", ws: "" };

		function openResident() {
			// 先进它自己的工作区，再进那一条会话；只开工作区会落到第一条会话上
			var ok = false;
			if (residentState.ws && residentState.ws.length > 0) {
				try { PLUGIN_CTX.uiWorkspace.openWorkspace(residentState.ws); ok = true } catch (e) { /* 继续 */ }
			}
			if (residentState.id && residentState.id.length > 0) {
				try { PLUGIN_CTX.uiWorkspace.openSession(residentState.id); ok = true } catch (e) { /* 继续 */ }
			}
			return ok;
		}

		function ResidentEntry() {
			var state = React.useState(null);
			var ready = state[0];            // null=读取中, true=已启用, false=未设置
			var setReady = state[1];
			React.useEffect(function () {
				var alive = true;
				fetch(API + "/config", { credentials: "same-origin" })
					.then(function (r) { return r.json() })
					.then(function (body) {
						if (!alive) return;
						residentState.id = typeof body.resident === "string" ? body.resident : "";
						residentState.ws = typeof body.residentWs === "string" ? body.residentWs : "";
						setReady(residentState.id.length > 0 || residentState.ws.length > 0);
					})
					.catch(function () { if (alive) setReady(false) });
				return function () { alive = false };
			}, []);
			function click() {
				if (openResident()) return;
				setReady(false);
			}
			var on = ready === true;
			var dotColor = on ? "#2fbf71" : "#8a8a92";
			var label = on ? "已启用" : (ready === null ? "读取中" : "未设置");
			return h("button", {
				onClick: click,
				title: on ? "打开常驻聊天" : "还没设定：设置 → 记忆 · ACC",
				style: {
					display: "flex", alignItems: "center", gap: 8, width: "100%",
					padding: "7px 10px", borderRadius: 8, border: "none",
					background: "transparent", color: "inherit", fontSize: 13,
					cursor: "pointer", textAlign: "left"
				}
			},
				h("span", {
					style: {
						width: 7, height: 7, borderRadius: "50%", display: "inline-block",
						background: dotColor, boxShadow: on ? "0 0 6px " + dotColor : "none"
					}
				}),
				h("span", null, "常驻聊天"),
				h("span", { style: { marginLeft: "auto", fontSize: 11, color: on ? "#2fbf71" : DIM } }, label));
		}

		// 三态胶囊：记忆（绿）/ ACC（蓝）/ 关闭（灰）
		var CHIP_DOT = { memory: "#2fbf71", acc: "#4a7dff", off: "#8a8a92" };
		var CHIP_LABEL = { memory: "记忆", acc: "ACC", off: "关闭" };
		var CHIP_ORDER = ["memory", "acc", "off"];

		function AccChip() {
			var state = React.useState(null);
			var mode = state[0];
			var setMode = state[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			React.useEffect(function () {
				var alive = true;
				fetch(API + "/mode", { credentials: "same-origin" })
					.then(function (r) { return r.json() })
					.then(function (body) { if (alive && body && body.mode) setMode(body.mode) })
					.catch(function () { if (alive) setMode("off") });
				return function () { alive = false };
			}, []);
			if (mode === null) return null;
			function cycle() {
				if (busy) return;
				var next = CHIP_ORDER[(CHIP_ORDER.indexOf(mode) + 1) % CHIP_ORDER.length];
				setBusy(true);
				fetch(API + "/mode?mode=" + next, { credentials: "same-origin", method: "POST" })
					.then(function (r) { return r.json() })
					.then(function (body) { if (body && body.ok) setMode(body.mode); setBusy(false) })
					.catch(function () { setBusy(false) });
			}
			var dot = h("span", {
				style: {
					width: 7, height: 7, borderRadius: "50%", display: "inline-block",
					background: CHIP_DOT[mode], marginRight: 6,
					boxShadow: mode === "off" ? "none" : "0 0 6px " + CHIP_DOT[mode]
				}
			});
			return h("button", {
				onClick: cycle,
				title: "记忆引擎：" + CHIP_LABEL[mode] + "（点击切换）",
				style: {
					display: "inline-flex", alignItems: "center", padding: "3px 9px",
					borderRadius: 999, border: "1px solid " + BORDER,
					background: "transparent", color: "inherit", fontSize: 12,
					cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1
				}
			}, dot, CHIP_LABEL[mode]);
		}

		function EnginePanel() {
			var dataState = React.useState(null);
			var data = dataState[0];
			var setData = dataState[1];
			var noteState = React.useState("");
			var note = noteState[0];
			var setNote = noteState[1];
			var keyState = React.useState("");
			var keyDraft = keyState[0];
			var setKeyDraft = keyState[1];

			function reload() {
				fetch(API + "/panel", { credentials: "same-origin" })
					.then(function (r) { return r.json() })
					.then(function (body) { setData(body) })
					.catch(function () { setNote("读不到状态") });
			}
			React.useEffect(function () { reload() }, []);

			if (data === null) return h("div", { style: { padding: "4px 2px", fontSize: 12, color: DIM } }, "读取中…");

			function section(title, rows, extra) {
				return h("div", { style: { marginTop: 18 } },
					h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, title),
					h("div", { style: { border: "1px solid " + BORDER, borderRadius: 10, padding: "10px 12px" } }, rows),
					extra ? extra : null);
			}
			function kv(label, value, mono) {
				return h("div", { style: { display: "flex", gap: 10, alignItems: "baseline", marginBottom: 6, flexWrap: "wrap" } },
					h("span", { style: { fontSize: 12, color: DIM, minWidth: 76 } }, label),
					h("span", { style: { fontSize: 12, fontFamily: mono ? "ui-monospace, monospace" : "inherit", wordBreak: "break-all" } }, value));
			}
			function button(text, onClick, primary) {
				return h("button", {
					onClick: onClick,
					style: {
						padding: "5px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12,
						border: primary ? "none" : "1px solid " + BORDER,
						background: primary ? ACCENT : "transparent",
						color: primary ? "#fff" : "inherit"
					}
				}, text);
			}

			function currentSessionIds() {
				try {
					var snap = PLUGIN_CTX.uiWorkspace.sessions.list.getSnapshot();
					return Array.isArray(snap && snap.ids) ? snap.ids.slice() : [];
				} catch (e) { return [] }
			}

			async function setDir() {
				setNote("正在打开文件管理器…");
				try {
					var result = await PLUGIN_CTX.uiWorkspace.directoryPicker.pick();
					if (!result || result.ok !== true) { setNote("已取消"); return }
					var picked = typeof result.value === "string" ? result.value : (result.value && result.value.path ? result.value.path : "");
					if (picked.length === 0) { setNote("没拿到目录"); return }
					setNote("建工作区…");
					var created = await PLUGIN_CTX.uiWorkspace.workspaces.create({ path: picked });
					var wsId = created && (created.workspaceId || created.id) ? (created.workspaceId || created.id) : "";
					var sid = "";
					if (wsId.length > 0) {
						var before = currentSessionIds();
						try {
							var session = await PLUGIN_CTX.uiWorkspace.startSession(wsId);
							sid = typeof session === "string" ? session
								: (session && (session.sessionId || session.id) ? (session.sessionId || session.id) : "");
						} catch (e2) { /* 会话没建成 */ }
						if (sid.length === 0) {
							// startSession 没回 id：等一拍，从会话列表里找出新出现的那个
							await new Promise(function (resolve) { window.setTimeout(resolve, 1200) });
							var after = currentSessionIds();
							for (var k = 0; k < after.length; k++) {
								if (before.indexOf(after[k]) < 0) { sid = after[k]; break }
							}
						}
					}
					var q = "?residentDir=" + encodeURIComponent(picked);
					if (wsId.length > 0) q += "&residentWs=" + encodeURIComponent(wsId);
					if (sid.length > 0) q += "&resident=" + encodeURIComponent(sid);
					await fetch(API + "/config" + q, { credentials: "same-origin", method: "POST" });
					residentState.ws = wsId;
					residentState.id = sid;
					setNote(sid.length > 0 ? "设定完成" : "工作区已建，会话下次进入时创建");
					reload();
				} catch (e) {
					setNote("失败：" + String((e && e.message) || e).slice(0, 60));
				}
			}

			async function pickBackupDir() {
				setNote("正在打开文件管理器…");
				try {
					var result = await PLUGIN_CTX.uiWorkspace.directoryPicker.pick();
					if (!result || result.ok !== true) { setNote("已取消"); return }
					var picked = typeof result.value === "string" ? result.value : (result.value && result.value.path ? result.value.path : "");
					if (picked.length === 0) { setNote("没拿到目录"); return }
					await fetch(API + "/config?backupRoot=" + encodeURIComponent(picked), { credentials: "same-origin", method: "POST" });
					setNote("备份目录已设为：" + picked);
					reload();
				} catch (e) { setNote("失败：" + String((e && e.message) || e).slice(0, 60)) }
			}

			async function saveKey() {
				var value = String(keyDraft || "").trim();
				if (value.length === 0) { setNote("没有输入新的 key"); return }
				await fetch(API + "/config?key=" + encodeURIComponent(value), { credentials: "same-origin", method: "POST" });
				setKeyDraft("");
				setNote("key 已保存（仅用于覆盖 harness 默认）");
				reload();
			}

			async function toggleEncrypt() {
				var next = data.encrypt === true ? "0" : "1";
				await fetch(API + "/config?encrypt=" + next, { credentials: "same-origin", method: "POST" });
				setNote(next === "1" ? "已开启加密（需填密钥才生效）" : "已关闭加密");
				reload();
			}

			var enginesRow = [];
			for (var i = 0; i < (data.engines || []).length; i++) {
				var e = data.engines[i];
				enginesRow.push(h("div", { key: e.id, style: { fontSize: 12, marginBottom: 4 } },
					"● " + e.id + "  v" + e.version + "（" + e.kind + "）"));
			}
			if (data.conflict === true) enginesRow.push(h("div", { key: "c", style: { fontSize: 12, color: "#d94a4a", marginTop: 6 } }, "两个引擎同时在跑，需要二选一。"));

			var personaRows = [];
			for (var who of ["you", "me"]) {
				var parts = [];
				var counts = (data.persona && data.persona[who]) || {};
				var labels = data.facets || {};
				for (var facet in labels) {
					if ((counts[facet] || 0) > 0) parts.push(labels[facet] + " " + counts[facet]);
				}
				personaRows.push(h("div", { key: who, style: { fontSize: 12, marginBottom: 4 } },
					(who === "you" ? "你：" : "我：") + (parts.length > 0 ? parts.join(" · ") : "（空）")));
			}

			var children = [
				h("div", { key: "t", style: { fontSize: 15, fontWeight: 600 } }, "记忆引擎"),
				note.length > 0 ? h("div", { key: "n", style: { fontSize: 11, color: DIM, marginTop: 4 } }, note) : null
			];

			children.push(section("引擎", enginesRow.concat([
				h("div", { key: "r", style: { marginTop: 8 } },
					button("重新检测冲突", function () { clearChoice(); reload(); setNote("已清除上次选择，刷新后会重新提示") }))
			])));
			children.push(section("常驻聊天", [
				kv("目录", data.residentDir || "（未设定）", true),
				kv("会话", data.resident ? data.resident.slice(0, 24) + "…" : "（进入时创建）", true),
				h("div", { key: "b", style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" } },
					button(data.residentDir ? "重新设定目录" : "设定目录", setDir, true),
					button("进入常驻", function () { openResident() }))
			]));
			children.push(section("存储", [
				kv("归档", data.dataRoot, true),
				kv("备份", data.backupRoot, true),
				kv("已归档", data.archived + " 个会话"),
				kv("加密", data.encrypt === true ? ("开启" + (data.hasKey ? "（已设密钥）" : "（缺密钥，暂不生效）")) : "关闭"),
				h("div", { key: "b", style: { marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" } },
					button(data.encrypt ? "关闭加密" : "开启加密", toggleEncrypt),
					button("选择备份目录", pickBackupDir))
			]));
			children.push(section("记忆模型", [
				kv("来源", data.hasKey ? "手动 key（覆盖 harness 默认）" : "借用 harness 默认（deepseek-official / deepseek-flash）"),
				h("div", { key: "k", style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" } },
					h("input", {
						type: "password",
						autoComplete: "off",
						value: keyDraft,
						placeholder: data.hasKey ? "已设置，留空不改" : "留空则用 harness 默认",
						onChange: function (event) { setKeyDraft(event.target.value) },
						style: { flex: "1 1 240px", padding: "5px 8px", borderRadius: 8, border: "1px solid " + BORDER, background: "transparent", color: "inherit", fontSize: 12 }
					}),
					button("保存 key", saveKey))
			]));
			personaRows.push(h("div", { key: "deep", style: { fontSize: 12, marginTop: 6 } },
				"二级记忆：" + (data.deep || 0) + " 条（每轮注入最近 6 条）"));
			children.push(section("档案", personaRows));
			children.push(h(EngineGate, { key: "gate" }));

			// 首次进入且还没设常驻：问一次要不要建
			var wantGuide = false;
			try { wantGuide = window.localStorage.getItem("dsh-acc.resident-guided") !== "1" } catch (e) { /* private */ }
			if (wantGuide && !data.residentDir) {
				children.push(h("div", {
					key: "guide",
					style: {
						position: "fixed", inset: 0, zIndex: 2147483000,
						background: "rgba(0,0,0,0.45)", display: "flex",
						alignItems: "center", justifyContent: "center", padding: 16
					}
				},
					h("div", {
						style: {
							background: "var(--dsw-alias-bg-layer-1, #fff)", border: "1px solid " + BORDER,
							borderRadius: 12, padding: 22, maxWidth: 460, width: "calc(100% - 48px)",
							boxShadow: "0 24px 64px rgba(0,0,0,0.35)", fontSize: 13
						}
					},
						h("div", { style: { fontSize: 16, fontWeight: 600 } }, "要不要建一个「常驻聊天」？"),
						h("div", { style: { fontSize: 12, color: DIM, marginTop: 8, lineHeight: 1.7 } },
							"它会是一个独立的工作区，只放一条对话，永远从侧边栏那个入口进。",
							"选个文件夹就行，其余的 ACC 自己建。"),
						h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 } },
							h("button", {
								onClick: function () {
									try { window.localStorage.setItem("dsh-acc.resident-guided", "1") } catch (e) {}
									setNote("以后可在「常驻聊天」里设定");
									reload();
								},
								style: { padding: "8px 14px", borderRadius: 8, border: "1px solid " + BORDER, background: "transparent", color: "inherit", cursor: "pointer" }
							}, "暂不"),
							h("button", {
								onClick: function () {
									try { window.localStorage.setItem("dsh-acc.resident-guided", "1") } catch (e) {}
									setDir();
								},
								style: { padding: "8px 14px", borderRadius: 8, border: "none", background: ACCENT, color: "#fff", cursor: "pointer" }
							}, "选文件夹")))));
			}

			return h("div", { style: { padding: "4px 2px", maxWidth: 720 } }, children);
		}

		function apply(ctx) {
			PLUGIN_CTX = ctx;
			// Register in two mounted-anywhere slots: the gate has to be visible whether
			// the person is in a conversation or sitting in Settings, and either slot may
			// be the only one alive at any moment. The component renders nothing but the
			// overlay, so an idle registration is invisible.
			function registerWith(name, id, order, label, Component) {
				try {
					ctx.slots.inject(name, function () {
						var options = { name: name, id: id, order: order };
						if (label !== undefined) options.label = function () { return label };
						return ctx.slots.register(options, Component);
					});
				} catch (error) {
					if (typeof console !== "undefined") console.warn("dsh-memory-acc: gate not registered in " + name, error);
				}
			}
			registerWith("conversation.input.left", "acc-engine-gate", 1, undefined, EngineGate);
			// 外壳级：侧边栏整个应用生命周期都在，不依赖用户打开设置或进入会话
			try {
				ctx.slots.inject("sidebar", function () {
					return ctx.slots.register({ name: "sidebar", id: "acc-engine-gate-shell", order: 900 }, EngineGate);
				});
			} catch (e) { /* 侧边栏槽不可用时仍有输入框那一处 */ }
			registerWith("conversation.input.left", "acc-chip", 5, undefined, AccChip);
			// 侧边栏：常驻聊天入口
			// 主位置：侧边栏，和「插件」同级
			try {
				ctx.slots.inject("sidebar.panellist", function () {
					// 不给 label：宿主的 panellist 会把 label 渲染成文字，而本组件已画了整行，
            // 两处都给就会显示两个「常驻聊天」。
						return ctx.slots.register({ name: "sidebar.panellist", id: "acc-resident", order: 5 }, ResidentEntry);
				});
			} catch (e) { if (typeof console !== "undefined") console.warn("acc: sidebar entry failed", e) }
			registerWith("settings.section", "acc-engine-gate-settings", 600, "记忆 · ACC", EnginePanel);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
