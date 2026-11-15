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

		// --- 二选一弹窗：建在 document.body 上，不经过任何插槽 -----------------------
		// 以前挂在 conversation.input.left 里，position:fixed 的包含块就变成了输入区容器：
		// 遮罩只盖一条、卡片被挤到底部、背后照常能点、滚轮还能滚页面。那不是 modal，
		// 只是"画在页面上的一个框"。body 的子节点没有祖先 transform，
		// 遮罩天然铺满视口、拦下所有点击。
		var GATE_HOST_CSS = "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;overflow:auto;overscroll-behavior:contain";
		var GATE_CARD_CSS = "background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid " + BORDER + ";border-radius:12px;padding:22px;max-width:520px;width:100%;max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;box-shadow:0 24px 64px rgba(0,0,0,0.35);font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary,#1a1a1a)";

		function el(tag, css, text) {
			var node = document.createElement(tag);
			if (css) node.style.cssText = css;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		function gateRow(engine, title, blurb) {
			var row = el("div", "border:1px solid " + BORDER + ";border-radius:10px;padding:10px 12px;margin-top:8px");
			var head = el("div", "display:flex;align-items:baseline;gap:8px");
			head.appendChild(el("span", "font-weight:600", title));
			head.appendChild(el("span", "font-size:11px;color:" + DIM, engine.id + " v" + engine.version));
			row.appendChild(head);
			row.appendChild(el("div", "font-size:12px;color:" + DIM + ";margin-top:4px", blurb));
			return row;
		}

		var gateHost = null;

		function closeEngineGate() {
			if (gateHost !== null && gateHost.parentNode !== null) gateHost.parentNode.removeChild(gateHost);
			gateHost = null;
		}

		function openEngineGate(info) {
			if (gateHost !== null) return;
			var engines = Array.isArray(info.engines) ? info.engines : [];
			var acc = engines.filter(function (e) { return e.kind === "acc" })[0];
			var other = engines.filter(function (e) { return e.kind !== "acc" })[0];
			var busy = false;

			gateHost = el("div", GATE_HOST_CSS);
			gateHost.setAttribute("role", "dialog");
			gateHost.setAttribute("aria-modal", "true");
			// 弹窗开着就别让背后的页面跟着滚
			gateHost.addEventListener("wheel", function (event) {
				if (gateHost.scrollHeight <= gateHost.clientHeight) event.preventDefault();
			}, { passive: false });

			var card = el("div", GATE_CARD_CSS);
			card.appendChild(el("div", "font-size:16px;font-weight:600", "两个记忆引擎都装着，留哪个？"));
			card.appendChild(el("div", "font-size:12px;color:" + DIM + ";margin-top:6px;line-height:1.7",
				"为了避免算力浪费，只允许装载一个：两个都跑的话，每轮对话要跑两条记忆链——重复计费，还会争同一个上下文。选一个留下，另一个写进 profile 的 patch 停用（只加一行 disabled，注释不动），重启 harness 后生效。"));
			if (other !== undefined) card.appendChild(gateRow(other, "标准版", "更适合工作：按作用域切片，只留结论，上下文干净、每轮开销小。"));
			if (acc !== undefined) card.appendChild(gateRow(acc, "ACC 完整版", "更适合聊天：保存每一次完整对话与图片，记得住前因后果，能回头翻。默认借用 harness 自己的模型，不用填 key。"));

			var note = el("div", "font-size:12px;margin-top:10px;text-align:right;line-height:1.6");
			var keepBtn = el("button", "padding:8px 14px;border-radius:8px;border:1px solid " + BORDER + ";background:transparent;color:inherit;font-size:13px;cursor:pointer", "保留标准版");
			var accBtn = el("button", "padding:8px 14px;border-radius:8px;border:none;background:" + ACCENT + ";color:#fff;font-size:13px;cursor:pointer", "保留 ACC");

			function choose(target, choice, label) {
				if (busy) return;
				busy = true;
				keepBtn.disabled = true;
				accBtn.disabled = true;
				keepBtn.style.opacity = "0.6";
				accBtn.style.opacity = "0.6";
				note.style.color = DIM;
				note.textContent = "正在停用 " + target + "…";
				fetch(API + "/disable?target=" + encodeURIComponent(target), { credentials: "same-origin", method: "POST" })
					.then(function (r) { return r.json() })
					.then(function (body) {
						if (body !== null && body.ok === true) {
							writeChoice(choice);
							fetch(API + "/reset", { credentials: "same-origin", method: "POST" }).catch(function () { /* 清不掉也不阻塞 */ });
							note.style.color = "var(--dsw-alias-state-success-primary, #2fbf71)";
							note.textContent = "已停用 " + target + " · 重启 harness 后只剩" + label;
							window.setTimeout(closeEngineGate, 2600);
							return;
						}
						note.style.color = "#d94a4a";
						note.textContent = "停用失败：" + ((body && body.error) || "未知原因");
						busy = false;
						keepBtn.disabled = false;
						accBtn.disabled = false;
						keepBtn.style.opacity = "1";
						accBtn.style.opacity = "1";
					})
					.catch(function (error) {
						note.style.color = "#d94a4a";
						note.textContent = "停用失败：" + String((error && error.message) || error);
						busy = false;
						keepBtn.disabled = false;
						accBtn.disabled = false;
						keepBtn.style.opacity = "1";
						accBtn.style.opacity = "1";
					});
			}

			keepBtn.addEventListener("click", function () {
				choose(acc !== undefined ? acc.id : "dsh-memory-acc", "other", "标准版");
			});
			accBtn.addEventListener("click", function () {
				choose(other !== undefined ? other.id : "memory", "acc", " ACC");
			});

			var actions = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:16px");
			actions.appendChild(keepBtn);
			actions.appendChild(accBtn);
			card.appendChild(actions);
			card.appendChild(note);
			gateHost.appendChild(card);
			document.body.appendChild(gateHost);
		}

		/** 两个引擎都在 patch 里启用时才弹；查不到就当没事。 */
		function checkEngineGate() {
			return fetch(API + "/engines", { credentials: "same-origin" })
				.then(function (r) { return r.json() })
				.then(function (body) {
					var inst = body && body.installed;
					var both = inst !== undefined && inst !== null
						? inst.memory === true && inst.acc === true
						: body.conflict === true;
					if (both) openEngineGate(body);
					else closeEngineGate();
				})
				.catch(function () { /* 拿不到就不打扰 */ });
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
			// 两个引擎同时装着时，本引擎按设计让位（工具与上下文注入都停用）。
			// 胶囊必须反映这个事实：否则蓝色的「ACC」会让人以为它在工作。
			// 引擎表有两个字段，含义不同：conflict=两个都在，accToolsActive=本轮真的注册了工具。
			// 让位之后后者仍为 false（apply 只跑一次），所以它才是「现在能不能用」的判据。
			var infoState = React.useState(null);
			var info = infoState[0];
			var setInfo = infoState[1];
			React.useEffect(function () {
				var alive = true;
				fetch(API + "/engines", { credentials: "same-origin" })
					.then(function (r) { return r.json() })
					.then(function (body) { if (alive) setInfo(body || {}) })
					.catch(function () { /* 拿不到就按未让位处理 */ });
				return function () { alive = false };
			}, []);
			var yielded = info !== null && info.accToolsActive === false;
			var conflicted = info !== null && info.conflict === true;
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			// 让位胶囊点下去之后要回报「正在停用谁」，所以这里多一个说明位。
			var noteState = React.useState("");
			var note = noteState[0];
			var setNote = noteState[1];
			React.useEffect(function () {
				var alive = true;
				fetch(API + "/mode", { credentials: "same-origin" })
					.then(function (r) { return r.json() })
					.then(function (body) { if (alive && body && body.mode) setMode(body.mode) })
					.catch(function () { if (alive) setMode("off") });
				return function () { alive = false };
			}, []);
			if (mode === null) return null;
			// 让位不是终点：点一下就把另一个引擎停掉（写 patch 的 disabled: true）。
			// 停用之后要重启 harness 才轮到 ACC 接管——工具是加载时注册的，
			// 插件在运行时补不了这一步（实测：patch 改完宿主不会重新 apply 本插件）。
			// 不在页面加载时自动做——那等于「装第二个就顶掉第一个」，
			// 而实验室里两个都装着就是为了测共存，一打开就被拆掉就没法测了。
			function takeOver() {
				if (busy) return;
				setBusy(true);
				setNote("正在停用另一个引擎…");
				fetch(API + "/engines", { credentials: "same-origin" })
					.then(function (r) { return r.json() })
					.then(function (body) {
						var others = (body && Array.isArray(body.engines) ? body.engines : []).filter(function (e) { return e.id !== "dsh-memory-acc" });
						var target = others.length > 0 ? others[0].id : "memory";
						return fetch(API + "/disable?target=" + encodeURIComponent(target), { credentials: "same-origin", method: "POST" })
							.then(function (r) { return r.json() })
							.then(function (result) {
								if (result && result.ok === true) {
									try { window.localStorage.setItem("dsh-acc.engine-choice", "acc") } catch (e) { /* 隐私模式 */ }
									fetch(API + "/reset", { credentials: "same-origin", method: "POST" }).catch(function () { /* 清不掉也不阻塞 */ });
									// 不自动刷新：刷新只是重画页面，宿主里 ACC 这一轮仍然没注册过工具。
									setInfo({ engines: [], conflict: false, accToolsActive: false });
									setNote("已停用 " + target + " · 重启 harness 后接管");
									setBusy(false);
									return;
								}
								setNote("停用失败：" + ((result && result.error) || "未知原因"));
								setBusy(false);
							});
					})
					.catch(function (error) { setNote("停用失败：" + String((error && error.message) || error)); setBusy(false) });
			}
			if (yielded) {
				var idle = conflicted ? "ACC 未生效 · 点此接管" : "ACC 未生效 · 重启 harness";
				return h("button", {
					onClick: conflicted ? takeOver : undefined,
					title: conflicted
						? "两个记忆引擎同时装着，本引擎已让位（工具与上下文注入均已停用）。点一下停用另一个引擎；重启 harness 后 ACC 接管——插件只在加载时注册工具，这一步插件自己改不了。"
						: "另一个引擎已经停用了，但 ACC 的工具是在加载时注册的，这一轮没有注册。重启 harness 后生效。",
					style: {
						display: "inline-flex", alignItems: "center", padding: "3px 9px",
						borderRadius: 999, border: "1px solid " + BORDER,
						background: "transparent", color: "inherit", fontSize: 12,
						cursor: busy ? "default" : (conflicted ? "pointer" : "default"),
						opacity: busy ? 0.75 : 0.6
					}
				}, h("span", {
					style: {
						width: 7, height: 7, borderRadius: "50%", display: "inline-block",
						background: "#8a8a92", marginRight: 6
					}
				}), note.length > 0 ? note : (busy ? "正在接管…" : idle));
			}
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
			var storyState = React.useState(null);
			var story = storyState[0];
			var setStory = storyState[1];

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
			if (data.conflict === true) enginesRow.push(h("div", { key: "c", style: { fontSize: 12, color: "#d94a4a", marginTop: 6 } }, "为了避免算力浪费，只允许装载一个：现在两个都是启用状态，需要二选一。"));

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
					button("重新检测冲突", function () {
						clearChoice();
						checkEngineGate().then(function () { setNote("已重新检测：两个都启用时会立刻弹窗") }, function () { setNote("检测失败，看控制台") });
					}))
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
			function runDreamNow() {
				setNote("做梦要调两三次模型，等一会儿…");
				fetch(API + "/dream?run=1", { credentials: "same-origin", method: "POST" })
					.then(function (r) { return r.json() })
					.then(function (body) {
						if (body && body.ok === true) setNote("做完了：" + ((body.steps || []).join(" · ") || "整理过了"));
						else setNote("没做成：" + (((body && body.errors) || []).join("；") || "未知原因"));
						reload();
					})
					.catch(function (e) { setNote("请求失败：" + String((e && e.message) || e)); reload() });
			}
			function setPerWeek(n) {
				fetch(API + "/dream?perWeek=" + String(n), { credentials: "same-origin", method: "POST" })
					.then(function (r) { return r.json() })
					.then(function () { setNote("每周改成了 " + n + " 次"); reload() })
					.catch(function (e) { setNote("改不了：" + String((e && e.message) || e)) });
			}

			function openStory(name) {
				if (story !== null && story.name === name) { setStory(null); return }
				setStory({ name: name, loading: true, text: "" });
				fetch(API + "/dream?story=" + encodeURIComponent(name), { credentials: "same-origin" })
					.then(function (r) { return r.json() })
					.then(function (body) {
						setStory({ name: name, loading: false, text: body && body.ok ? String(body.text || "") : ("读不到：" + ((body && body.error) || "未知原因")) });
					})
					.catch(function (e) { setStory({ name: name, loading: false, text: "读不到：" + String((e && e.message) || e) }) });
			}

			function toggleDreams() {
				var next = data.dream && data.dream.enabled === true ? "0" : "1";
				fetch(API + "/dream?enabled=" + next, { credentials: "same-origin", method: "POST" })
					.then(function () { setNote(next === "1" ? "做梦已开启" : "做梦已关掉"); reload() })
					.catch(function (e) { setNote("改不了：" + String((e && e.message) || e)) });
			}

			var dream = data.dream || {};
			var dreamRows = [
				kv("本周", String(dream.count || 0) + " / " + String(dream.perWeek || 2) + (dream.carry > 0 ? "（还欠上周一次）" : "")),
				kv("上次", dream.lastAt ? String(dream.lastAt).slice(0, 16).replace("T", " ") : "还没做过"),
				kv("开关", dream.enabled === true ? "开" : "关")
			];
			function clockOf(ts) {
				var d = new Date(ts);
				var today = new Date();
				var same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
				var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
				return same ? ("今天 " + hm) : ((d.getMonth() + 1) + "-" + d.getDate() + " " + hm);
			}
			var nextText = "关着";
			if (dream.enabled === true) {
				if (dream.plan && dream.plan.need === 0) nextText = "本周已经做完（" + (dream.count || 0) + "/" + (dream.perWeek || 2) + "）";
				else if (dream.fireAt > 0) nextText = "已排到 " + clockOf(dream.fireAt);
				else nextText = "等色子（本周还欠 " + ((dream.plan && dream.plan.need) || 0) + " 次，还剩 " + ((dream.plan && dream.plan.daysLeft) || 0) + " 天）";
			}
			dreamRows.push(kv("下次", nextText));
			var weekButtons = [];
			for (var w = 1; w <= 4; w += 1) {
				weekButtons.push(button(String(w), (function (n) {
					return function () { setPerWeek(n) };
				})(w), (dream.perWeek || 2) === w));
			}
			dreamRows.push(h("div", { key: "w", style: { display: "flex", gap: 6, alignItems: "baseline", marginBottom: 6, flexWrap: "wrap" } },
				h("span", { style: { fontSize: 12, color: DIM, minWidth: 76 } }, "每周"),
				weekButtons,
				h("span", { key: "hint", style: { fontSize: 11, color: DIM } }, "色子按这个数掷；上周一次没做会多欠一次")));
			if (dream.essence && dream.essence.length > 0) {
				var latestDream = dream.essence[dream.essence.length - 1];
				dreamRows.push(kv("最近一场", "《" + latestDream.title + "》" + latestDream.essence));
				dreamRows.push(h("div", { key: "s", style: { marginTop: 4 } },
					button(story !== null && story.name === latestDream.story ? "收起故事" : "看故事", function () { openStory(latestDream.story) })));
			}
			if (story !== null) {
				dreamRows.push(h("pre", {
					key: "story",
					style: {
						marginTop: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid " + BORDER,
						maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.7,
						fontFamily: "inherit", background: "rgba(127,127,127,0.06)"
					}
				}, story.loading ? "读故事…" : story.text));
			}
			if (dream.lastError) dreamRows.push(h("div", { key: "e", style: { fontSize: 12, color: "#d94a4a", marginTop: 4 } }, "上次出错：" + dream.lastError));
			dreamRows.push(h("div", { key: "b", style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" } },
				button("现在做一次梦", runDreamNow, true),
				button(dream.enabled === true ? "关掉做梦" : "开启做梦", toggleDreams)));
			children.push(section("做梦（整理记忆）", dreamRows));

			personaRows.push(h("div", { key: "deep", style: { fontSize: 12, marginTop: 6 } },
				"二级记忆：" + (data.deep || 0) + " 条（每轮注入最近 6 条）"));
			children.push(section("档案", personaRows));

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
			// 二选一弹窗不挂插槽：插槽在输入区里，会给 position:fixed 造出错误包含块。
			try {
				var bootGate = function () { checkEngineGate(); };
				if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootGate);
				else bootGate();
				window.addEventListener("focus", function () { checkEngineGate() });
			} catch (error) { if (typeof console !== "undefined") console.warn("dsh-memory-acc: gate mount failed", error) }
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
