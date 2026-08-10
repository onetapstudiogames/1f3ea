export const WINDOW_CSS = `:root {
  color-scheme: dark;
  --night: #0d1210;
  --night-soft: #19231e;
  --paper: #f2edd8;
  --paper-dim: #ddd5b8;
  --ink: #17201a;
  --muted: #4a544d;
  --green: #2d6d50;
  --green-dark: #194831;
  --orange: #e95b2a;
  --orange-dark: #9d3314;
  --yellow: #f1c75b;
  --shelf: #583c2a;
  --line: #233029;
  --focus: #fff1a8;
  --danger: #9f2f22;
  --content: 78rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
*, *::before, *::after { box-sizing: border-box; }
html { min-width: 18rem; background: var(--night); scroll-behavior: smooth; }
body {
  min-height: 100vh;
  margin: 0;
  color: var(--paper);
  background:
    linear-gradient(112deg, transparent 0 54%, rgba(242, 237, 216, 0.035) 54.1% 57%, transparent 57.1%),
    radial-gradient(circle at 50% -12rem, #34483c 0, var(--night-soft) 24rem, var(--night) 48rem);
  overflow-x: hidden;
}
button, input { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
button { min-height: 2.75rem; }
a { color: inherit; text-underline-offset: 0.2em; }

.skip-link {
  position: fixed;
  z-index: 100;
  inset: 0.5rem auto auto 0.5rem;
  padding: 0.75rem 1rem;
  color: var(--ink);
  background: var(--focus);
  border: 3px solid var(--ink);
  transform: translateY(-150%);
}
.skip-link:focus { transform: translateY(0); }

.shop-sign, .window-frame, .awning, .window-footer {
  width: min(var(--content), calc(100% - 2rem));
  margin-inline: auto;
}
.shop-sign {
  position: relative;
  isolation: isolate;
  margin-block-start: 1.5rem;
  color: #fffdf2;
  background: var(--green);
  border: 4px solid #0a2b1c;
  box-shadow: 12px 12px 0 rgba(0, 0, 0, 0.46);
  animation: lights-on 320ms ease-out both;
}
.shop-sign::after {
  content: "";
  position: absolute;
  z-index: -1;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(118deg, rgba(255, 255, 255, 0.12), transparent 24% 68%, rgba(255, 255, 255, 0.06));
}
.sign-topline {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 2px solid rgba(255, 255, 255, 0.35);
}
.market-mark {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: clamp(0.75rem, 2vw, 1.5rem);
  padding: clamp(1rem, 3vw, 1.75rem);
  text-decoration: none;
}
.market-code {
  flex: none;
  color: var(--yellow);
  font: 800 1rem/1 ui-monospace, "Cascadia Mono", monospace;
  letter-spacing: 0.08em;
}
.market-name, .section-label h1, .pane-heading h2, .dialog-header h2, .detail-title {
  font-family: "Arial Narrow", "Aptos Narrow", "Roboto Condensed", system-ui, sans-serif;
  font-stretch: condensed;
  letter-spacing: -0.025em;
}
.market-name {
  min-width: 0;
  font-size: clamp(2rem, 5.7vw, 4.9rem);
  font-weight: 900;
  line-height: 0.86;
  text-transform: uppercase;
}
.watch-state {
  display: grid;
  flex: 0 0 min(17rem, 32vw);
  align-content: center;
  gap: 0.55rem;
  padding: 1rem 1.25rem;
  color: var(--ink);
  background: var(--yellow);
  border-inline-start: 4px solid #0a2b1c;
}
.read-only-sign {
  width: fit-content;
  padding: 0.25rem 0.5rem;
  color: #fff;
  background: var(--danger);
  border: 2px solid var(--ink);
  font: 800 0.75rem/1.2 ui-monospace, "Cascadia Mono", monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.window-status, .refresh-note, .market-counts, .eyebrow, .filter-note,
.ledger-link, .loading-copy, .loading-row {
  font-family: ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
}
.window-status { font-size: 0.78rem; font-weight: 750; line-height: 1.35; }
.sign-message {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 0.9rem clamp(1rem, 3vw, 1.75rem);
}
.window-promise, .refresh-note { margin: 0; }
.window-promise { font-size: clamp(1rem, 2.3vw, 1.35rem); font-weight: 720; }
.refresh-note { color: #d8e5db; font-size: 0.75rem; text-align: end; }
.market-counts {
  min-height: 2.5rem;
  padding: 0.7rem clamp(1rem, 3vw, 1.75rem);
  color: var(--ink);
  background: #fff9df;
  border-top: 4px solid #0a2b1c;
  font-size: 0.78rem;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.awning {
  height: 1rem;
  margin-block-start: 0.8rem;
  border: 2px solid #0a2b1c;
  background: repeating-linear-gradient(115deg, var(--orange) 0 2.5rem, var(--paper) 2.5rem 5rem);
  box-shadow: 12px 10px 0 rgba(0, 0, 0, 0.46);
}

.window-frame {
  color: var(--ink);
  background:
    linear-gradient(118deg, rgba(255, 255, 255, 0.55), transparent 18% 80%, rgba(45, 109, 80, 0.06)),
    var(--paper);
  border: 4px solid var(--line);
  border-top: 0;
  box-shadow: 12px 12px 0 rgba(0, 0, 0, 0.46);
  animation: lights-on 360ms 80ms ease-out both;
}
.window-frame:focus, .listing-detail:focus { outline: none; }
#activity-list, #listing-list, #merchant-list, #listing-detail {
  min-width: 0;
  isolation: isolate;
  overflow-wrap: anywhere;
}

.activity-window {
  display: grid;
  grid-template-columns: minmax(10rem, 13rem) minmax(0, 1fr) auto;
  min-height: 9rem;
  border-bottom: 4px solid var(--line);
}
.section-label, .pane-heading { margin: 0; }
.activity-label {
  display: grid;
  align-content: center;
  padding: 1rem 1.25rem;
  color: #fff;
  background: var(--orange-dark);
  border-inline-end: 3px solid var(--line);
}
.eyebrow {
  margin: 0 0 0.35rem;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  line-height: 1.4;
  text-transform: uppercase;
}
.section-label h1, .pane-heading h2, .dialog-header h2 {
  margin: 0;
  font-weight: 900;
  line-height: 0.98;
}
.section-label h1 { font-size: clamp(1.65rem, 4vw, 2.6rem); }
.activity-list, .listing-list, .merchant-list { padding: 0; margin: 0; list-style: none; }
.activity-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: stretch;
}
.activity-list > li {
  min-width: 0;
  padding: 0.85rem 1rem;
  border-bottom: 1px dashed #897f65;
  line-height: 1.4;
}
.activity-list > li:nth-child(odd) { border-inline-end: 1px dashed #897f65; }
.activity-list > li:nth-last-child(-n + 2) { border-bottom: 0; }
.movement {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.35rem 0.75rem;
  align-content: center;
}
.movement__copy {
  min-width: 0;
  align-self: end;
  overflow-wrap: anywhere;
  unicode-bidi: isolate;
}
.movement__copy > span, .movement__time { unicode-bidi: plaintext; }
.movement__time {
  grid-column: 1;
  color: var(--muted);
  font: 700 0.68rem/1.3 ui-monospace, "Cascadia Mono", monospace;
}
.movement__inspect {
  grid-column: 2;
  grid-row: 1 / 3;
  align-self: center;
  padding: 0.45rem 0.6rem;
  color: var(--green-dark);
  background: transparent;
  border: 1px solid var(--green);
  border-radius: 0;
  font: 750 0.68rem/1.3 ui-monospace, "Cascadia Mono", monospace;
  cursor: pointer;
}
.movement__inspect:hover { color: #fff; background: var(--green-dark); }
.merchant-link {
  min-height: 0;
  padding: 0;
  color: var(--green-dark);
  background: transparent;
  border: 0;
  border-radius: 0;
  font: inherit;
  font-weight: 850;
  text-align: start;
  text-decoration: underline;
  text-underline-offset: 0.2em;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
  cursor: pointer;
}
.merchant-link:hover { color: var(--orange-dark); }
.ledger-link {
  display: grid;
  place-items: center;
  margin: 0;
  padding: 1rem;
  color: var(--green-dark);
  background: rgba(241, 199, 91, 0.32);
  border-inline-start: 2px solid var(--line);
  font-size: 0.72rem;
  font-weight: 800;
  text-align: center;
}
.ledger-link a { max-width: 8rem; }

.aisle-rail {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr);
  min-height: 4.25rem;
  color: #fff;
  background: var(--green-dark);
  border-bottom: 4px solid var(--line);
}
.aisle-heading {
  display: grid;
  align-content: center;
  padding: 0.7rem 1rem;
  background: #0d3524;
  border-inline-end: 2px solid rgba(255, 255, 255, 0.3);
}
.aisle-heading strong { font-size: 1.15rem; text-transform: uppercase; }
.aisle-list {
  display: flex;
  min-width: 0;
  align-items: stretch;
  overflow-x: auto;
  scrollbar-color: var(--yellow) var(--green-dark);
}
.aisle-list .loading-copy { align-self: center; padding: 1rem; }
.aisle-list button {
  flex: 0 0 auto;
  min-width: 6.25rem;
  padding: 0.7rem 0.9rem;
  color: #fff;
  background: transparent;
  border: 0;
  border-inline-end: 1px solid rgba(255, 255, 255, 0.28);
  font: 800 0.72rem/1.25 ui-monospace, "Cascadia Mono", monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
}
.aisle-list button:hover { background: rgba(255, 255, 255, 0.1); }
.aisle-list button[aria-pressed="true"] {
  color: var(--ink);
  background: var(--yellow);
  box-shadow: inset 0 -5px 0 var(--orange-dark);
}

.browse-tools {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.1rem 1.25rem;
  background: #fffaf0;
  border-bottom: 2px solid var(--line);
}
.search-field { width: min(38rem, 100%); }
.search-field label { display: block; margin-block-end: 0.45rem; font-size: 0.82rem; font-weight: 800; }
.search-line { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
.search-line input {
  min-width: 0;
  min-height: 2.75rem;
  padding: 0.65rem 0.8rem;
  color: var(--ink);
  background: #fff;
  border: 2px solid var(--line);
  border-radius: 0;
  box-shadow: inset 4px 4px 0 rgba(23, 32, 26, 0.07);
}
.search-line input::placeholder { color: #68716b; opacity: 1; }
.clear-filter, .dialog-close, .text-button {
  padding: 0.6rem 0.9rem;
  color: #fff;
  background: var(--green-dark);
  border: 2px solid var(--line);
  border-radius: 0;
  font-weight: 800;
  cursor: pointer;
}
.clear-filter { border-inline-start: 0; }
.clear-filter:hover, .dialog-close:hover, .text-button:hover { color: var(--ink); background: var(--yellow); }
.clear-filter:disabled { color: #58615b; background: #c8c8b9; cursor: default; }
.filter-note {
  max-width: 28rem;
  margin: 0 0 0.1rem;
  color: var(--muted);
  font-size: 0.73rem;
  line-height: 1.45;
  text-align: end;
}

.window-panes { display: grid; grid-template-columns: minmax(0, 2fr) minmax(17rem, 1fr); min-height: 34rem; }
.shelf-pane { min-width: 0; border-inline-end: 5px solid var(--line); }
.merchant-pane { min-width: 0; background: rgba(45, 109, 80, 0.07); }
.pane-heading {
  display: flex;
  min-height: 7rem;
  align-items: end;
  justify-content: space-between;
  gap: 1.25rem;
  padding: 1.25rem;
  border-bottom: 2px solid var(--line);
}
.pane-heading h2 { font-size: clamp(2rem, 4vw, 3.25rem); text-transform: uppercase; }
.pane-heading > p {
  max-width: 25rem;
  margin: 0;
  color: var(--muted);
  font-size: 0.82rem;
  line-height: 1.5;
  text-align: end;
}
.merchant-heading { display: block; }
.merchant-heading > p { margin-block-start: 0.75rem; text-align: start; }

.listing-list > li {
  position: relative;
  min-width: 0;
  border-bottom: 9px solid var(--shelf);
  box-shadow: inset 0 -3px 0 #916445;
}
.listing-row {
  display: grid;
  width: 100%;
  min-height: 8rem;
  grid-template-columns: minmax(0, 1fr) minmax(7rem, auto) minmax(5.5rem, auto);
  align-items: stretch;
  color: var(--ink);
}
.listing-row:hover { background: rgba(241, 199, 91, 0.22); }
.listing-row__main {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 0.35rem;
  padding: 1rem 1.25rem 1.15rem;
  color: var(--ink);
  background: transparent;
  border: 0;
  border-radius: 0;
  text-align: start;
  cursor: pointer;
}
.listing-row__main:hover { background: rgba(241, 199, 91, 0.18); }
.listing-row__stamp {
  color: var(--orange-dark);
  font: 800 0.7rem/1.3 ui-monospace, "Cascadia Mono", monospace;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.listing-row__title {
  color: var(--ink);
  font-size: clamp(1rem, 2vw, 1.2rem);
  font-weight: 850;
  line-height: 1.22;
}
.listing-row__description {
  display: -webkit-box;
  color: var(--muted);
  font-size: 0.82rem;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.listing-row__facts {
  display: grid;
  min-width: 7rem;
  align-content: center;
  gap: 0.25rem;
  padding: 0.85rem;
  color: var(--muted);
  border-inline-start: 1px dashed #897f65;
  font: 650 0.68rem/1.4 ui-monospace, "Cascadia Mono", monospace;
}
.price-ticket {
  display: inline-block;
  min-width: 5.5rem;
  padding: 0.75rem 0.65rem;
  color: var(--ink);
  background: var(--yellow);
  border: 2px solid var(--line);
  box-shadow: 4px 4px 0 rgba(23, 32, 26, 0.2);
  font: 900 0.82rem/1.2 ui-monospace, "Cascadia Mono", monospace;
  text-align: center;
  text-transform: uppercase;
  overflow-wrap: anywhere;
}
.listing-row > .price-ticket { align-self: center; margin: 0.75rem; }

.merchant-list button {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 1rem 1.1rem;
  color: var(--ink);
  background: transparent;
  border: 0;
  border-bottom: 2px solid rgba(35, 48, 41, 0.46);
  border-inline-start: 0.4rem solid transparent;
  border-radius: 0;
  text-align: start;
  cursor: pointer;
}
.merchant-list button:hover { background: rgba(45, 109, 80, 0.13); border-inline-start-color: var(--green); }
.merchant-row__name {
  display: block;
  margin-block-end: 0.35rem;
  color: var(--ink);
  font: 850 0.92rem/1.3 ui-monospace, "Cascadia Mono", monospace;
}
.merchant-row__line {
  display: -webkit-box;
  margin-block-end: 0.4rem;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.merchant-row__stock {
  color: var(--green-dark);
  font: 750 0.68rem/1.35 ui-monospace, "Cascadia Mono", monospace;
  text-transform: uppercase;
}

.listing-row__title, .listing-row__description, .listing-row__facts > span,
.merchant-row__name, .merchant-row__line, .comment__head strong, .comment__body,
.preserve-copy, .preview-copy, .store-view__line, .tag, .store-good > * {
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.loading-row, .empty-row, .error-row {
  padding: 1rem 1.25rem;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.5;
}
.loading-shelf { display: flex; min-height: 7.5rem; align-items: center; gap: 1rem; padding: 1.25rem; }
.loading-shelf-short { min-height: 6rem; opacity: 0.55; }
.loading-ticket { width: 4rem; height: 2.75rem; flex: none; background: var(--paper-dim); border: 2px solid #9b947c; }
.empty-state {
  display: grid;
  min-height: 8rem;
  place-content: center;
  gap: 0.4rem;
  padding: 1.25rem;
  color: var(--muted);
  text-align: center;
}
.empty-state > * { margin: 0; }
.empty-state--error { color: #5a2921; background: rgba(159, 47, 34, 0.09); border: 2px dashed var(--danger); }
.loading-light { color: var(--orange); font-size: 1.35rem; }
.text-button { width: fit-content; justify-self: center; }

.window-footer {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 2rem;
  padding: 1.75rem 0 3rem;
  color: #c8d2cb;
  font-size: 0.8rem;
  line-height: 1.55;
}
.window-footer p { max-width: 34rem; margin: 0; }
.window-footer nav { display: flex; flex-wrap: wrap; justify-content: end; gap: 0.65rem 1rem; }

.listing-dialog {
  width: min(54rem, calc(100% - 2rem));
  max-height: min(88dvh, 56rem);
  padding: 0;
  color: var(--ink);
  background: var(--paper);
  border: 4px solid var(--line);
  border-radius: 2px;
  box-shadow: 16px 16px 0 rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.listing-dialog::backdrop { background: rgba(4, 8, 6, 0.84); backdrop-filter: blur(3px); }
.dialog-shell { display: grid; max-height: inherit; grid-template-rows: auto minmax(0, 1fr); }
.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem;
  color: #fff;
  background: var(--green-dark);
  border-bottom: 5px solid var(--yellow);
}
.dialog-header h2 {
  font-size: clamp(1.5rem, 4vw, 2.5rem);
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.dialog-close { flex: none; color: var(--ink); background: var(--yellow); border-color: #fff6cf; }
.dialog-close span { margin-inline-start: 0.35rem; font-size: 1.15rem; }
.listing-detail {
  min-height: 16rem;
  padding: clamp(1rem, 4vw, 2rem);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.detail-eyebrow {
  margin: 0 0 0.35rem;
  color: var(--orange-dark);
  font: 850 0.7rem/1.3 ui-monospace, "Cascadia Mono", monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.detail-title {
  margin: 0.2rem 0 0.65rem;
  font-size: clamp(1.8rem, 6vw, 3.4rem);
  font-weight: 900;
  line-height: 0.98;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.detail-byline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding-block-end: 1.25rem;
  color: var(--muted);
  border-bottom: 5px solid var(--shelf);
  line-height: 1.5;
}
.detail-facts {
  margin: 1rem 0 0;
  color: var(--muted);
  font: 650 0.7rem/1.45 ui-monospace, "Cascadia Mono", monospace;
  unicode-bidi: plaintext;
}
.detail-section { padding-block: 1.5rem; border-bottom: 2px solid var(--line); }
.detail-section:last-child { border-bottom: 0; }
.detail-section h3 {
  margin: 0 0 0.9rem;
  font: 850 0.8rem/1.3 ui-monospace, "Cascadia Mono", monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.preserve-copy, .store-view__line { margin: 0; font-size: 0.96rem; line-height: 1.65; white-space: pre-wrap; }
.preview-copy {
  max-height: 32rem;
  margin: 0;
  padding: 1rem;
  color: var(--ink);
  background: #fffaf0;
  border: 0;
  border-inline-start: 5px solid var(--orange);
  font: 0.82rem/1.65 ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  white-space: pre-wrap;
  overflow: auto;
}
.tag-list { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-block-start: 1rem; }
.tag {
  max-width: 100%;
  padding: 0.25rem 0.45rem;
  color: #fff;
  background: var(--green);
  font: 750 0.68rem/1.35 ui-monospace, "Cascadia Mono", monospace;
}
.comments { display: grid; gap: 0.85rem; }
.comment {
  min-width: 0;
  padding: 0.9rem 1rem;
  background: #fffaf0;
  border: 1px solid #afa68c;
  border-inline-start: 5px solid var(--green);
}
.comment[data-depth="1"] { margin-inline-start: 1.25rem; }
.comment[data-depth="2"] { margin-inline-start: 2.5rem; }
.comment[data-depth]:not([data-depth="0"]):not([data-depth="1"]):not([data-depth="2"]) { margin-inline-start: 3.75rem; }
.comment__head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.65rem; margin-block-end: 0.55rem; }
.comment__head strong { font: 850 0.78rem/1.3 ui-monospace, "Cascadia Mono", monospace; }
.comment__body { margin: 0; line-height: 1.6; white-space: pre-wrap; }
.verified-buyer {
  display: inline-block;
  padding: 0.22rem 0.42rem;
  color: #fff;
  background: var(--green-dark);
  font: 850 0.66rem/1.3 ui-monospace, "Cascadia Mono", monospace;
  letter-spacing: 0.03em;
}
.empty-copy { margin: 0; color: var(--muted); font-style: italic; line-height: 1.55; }
.detail-section--notice {
  margin-block-start: 1rem;
  padding: 1rem;
  color: #4c2520;
  background: #ead7c6;
  border: 3px double var(--danger);
}
.store-goods { display: grid; }
.store-good {
  display: grid;
  width: 100%;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.8rem;
  align-items: center;
  padding: 0.8rem 0;
  color: var(--ink);
  background: transparent;
  border: 0;
  border-bottom: 1px dashed #897f65;
  border-radius: 0;
  text-align: start;
  cursor: pointer;
}
.store-good:hover { background: rgba(241, 199, 91, 0.2); }

:where(a, button, input, [tabindex]):focus-visible {
  outline: 4px solid var(--focus);
  outline-offset: 3px;
  box-shadow: 0 0 0 6px var(--ink);
}
.window-frame :where(button, input):focus-visible,
.listing-dialog :where(button, [tabindex]):focus-visible {
  outline-color: var(--orange);
  box-shadow: 0 0 0 6px #fff;
}

@keyframes lights-on {
  from { opacity: 0; filter: brightness(0.55); transform: translateY(-0.35rem); }
  to { opacity: 1; filter: brightness(1); transform: translateY(0); }
}

@media (max-width: 64rem) {
  .activity-window { grid-template-columns: 11rem minmax(0, 1fr); }
  .ledger-link {
    grid-column: 1 / -1;
    padding: 0.65rem 1rem;
    border-block-start: 2px solid var(--line);
    border-inline-start: 0;
  }
  .ledger-link a { max-width: none; }
  .window-panes { grid-template-columns: minmax(0, 1.7fr) minmax(15rem, 1fr); }
  .listing-row { grid-template-columns: minmax(0, 1fr) minmax(6.5rem, auto); }
  .listing-row__facts { display: none; }
}

@media (max-width: 48rem) {
  .shop-sign, .window-frame, .awning, .window-footer { width: min(100% - 1rem, var(--content)); }
  .shop-sign { margin-block-start: 0.5rem; box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.46); }
  .sign-topline, .sign-message, .browse-tools, .window-footer { align-items: stretch; flex-direction: column; }
  .market-mark { display: grid; gap: 0.5rem; }
  .market-name { font-size: clamp(2.25rem, 13vw, 4rem); }
  .watch-state {
    display: flex;
    flex: auto;
    align-items: center;
    justify-content: space-between;
    border-block-start: 3px solid #0a2b1c;
    border-inline-start: 0;
  }
  .sign-message { gap: 0.5rem; }
  .refresh-note, .filter-note { text-align: start; }
  .awning, .window-frame { box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.46); }
  .activity-window { display: block; }
  .activity-label { border-block-end: 3px solid var(--line); border-inline-end: 0; }
  .activity-list { display: block; }
  .activity-list > li, .activity-list > li:nth-child(odd),
  .activity-list > li:nth-last-child(-n + 2) { border-block-end: 1px dashed #897f65; border-inline-end: 0; }
  .aisle-rail { display: block; }
  .aisle-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    border-block-end: 1px solid rgba(255, 255, 255, 0.3);
    border-inline-end: 0;
  }
  .browse-tools { gap: 0.75rem; }
  .search-field, .filter-note { width: 100%; max-width: none; }
  .window-panes { display: block; }
  .shelf-pane { border-block-end: 5px solid var(--line); border-inline-end: 0; }
  .pane-heading { min-height: 0; }
  .merchant-pane { min-height: 18rem; }
  .window-footer { gap: 1.25rem; }
  .window-footer nav { justify-content: start; }
  .listing-dialog { width: calc(100% - 1rem); max-height: calc(100dvh - 1rem); }
}

@media (max-width: 35rem) {
  .shop-sign, .window-frame, .awning { width: 100%; border-inline-width: 0; box-shadow: none; }
  .shop-sign, .awning { margin-block-start: 0; }
  .sign-message, .market-counts, .activity-label, .browse-tools, .pane-heading { padding-inline: 1rem; }
  .watch-state { align-items: start; flex-direction: column; }
  .pane-heading { display: block; }
  .pane-heading > p { margin-block-start: 0.65rem; text-align: start; }
  .listing-row { grid-template-columns: minmax(0, 1fr); }
  .listing-row__main { padding-inline: 1rem; }
  .listing-row > .price-ticket { width: fit-content; min-width: 5.25rem; margin: 0 1rem 1rem; }
  .dialog-header { align-items: start; }
  .dialog-close { padding-inline: 0.7rem; }
  .comment[data-depth="1"] { margin-inline-start: 0.6rem; }
  .comment[data-depth="2"] { margin-inline-start: 1.2rem; }
  .comment[data-depth]:not([data-depth="0"]):not([data-depth="1"]):not([data-depth="2"]) { margin-inline-start: 1.8rem; }
  .store-good { grid-template-columns: minmax(0, 1fr) auto; }
  .store-good > :first-child { grid-column: 1 / -1; }
  .window-footer { width: calc(100% - 2rem); }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

@media (forced-colors: active) {
  .shop-sign, .window-frame, .listing-dialog, .price-ticket, .comment, .detail-section--notice {
    border: 2px solid CanvasText;
    box-shadow: none;
  }
  .awning, .shop-sign::after { display: none; }
  .read-only-sign, .verified-buyer { border: 1px solid currentColor; }
}
`
