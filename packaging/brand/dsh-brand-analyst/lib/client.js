window.__ModuleLoader__.load({
	id: "dsh-brand-analyst",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region Data Analyst brand occupants
		/**
		* Render the Data Analyst mark: a rounded tile with an ascending bar chart.
		* @param props - Host-supplied mark presentation (`size` in px).
		*/
		function AnalystMark({ size, className }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				className,
				viewBox: "0 0 48 48",
				fill: "none",
				"aria-hidden": true,
				children: [
					(0, react_jsx_runtime.jsx)("rect", { x: 2, y: 2, width: 44, height: 44, rx: 12, fill: "#1B6DF3" }),
					(0, react_jsx_runtime.jsx)("rect", { x: 12, y: 26, width: 6, height: 12, rx: 2, fill: "#FFFFFF", opacity: 0.85 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 21, y: 18, width: 6, height: 20, rx: 2, fill: "#FFFFFF", opacity: 0.92 }),
					(0, react_jsx_runtime.jsx)("rect", { x: 30, y: 10, width: 6, height: 28, rx: 2, fill: "#FFFFFF" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M12 16L20 11L28 14L37 8", stroke: "#FFBC4D", "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" })
				]
			});
		}
		/**
		* Render the product name as a text wordmark.
		*/
		function AnalystName() {
			return (0, react_jsx_runtime.jsx)("span", {
				style: {
					fontSize: 16,
					fontWeight: 600,
					letterSpacing: "0.2px",
					color: "var(--dsw-alias-label-primary, inherit)"
				},
				children: "Data Analyst"
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required service: the UI slot registry. */
		const inject = ["slots"];
		/**
		* Fill the sidebar brand slots and the conversation hero mark as one
		* declaration-aware registration set, mirroring the official brand
		* plugin's registration shape. Registering `conversation.hero.brand.mark`
		* replaces the conversation package's animated fish fallback.
		* @param ctx - Client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", () => ctx.slots.inject("conversation.hero.brand.mark", function* () {
				yield ctx.slots.register({ name: "sidebar.brand.mark" }, AnalystMark);
				yield ctx.slots.register({ name: "sidebar.brand.name" }, AnalystName);
				yield ctx.slots.register({ name: "conversation.hero.brand.mark" }, AnalystMark);
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
