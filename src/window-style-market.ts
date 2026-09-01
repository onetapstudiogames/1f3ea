export const WINDOW_CSS_MARKET = `:root {
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
  grid-template-columns: minmax(17rem, max-content) minmax(0, 1fr) auto;
  min-height: 9rem;
  border-bottom: 4px solid var(--line);
}
.section-label, .pane-heading { margin: 0; }
.activity-label {
  display: grid;
  min-width: max-content;
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
.activity-label h1 { white-space: nowrap; }
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
  flex-wrap: wrap;
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
.view-share { min-width: min(15rem, 100%); margin-inline-start: auto; }
.share-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.35rem 0.7rem;
  align-items: center;
  max-width: 100%;
}
.share-label {
  color: var(--muted);
  font: 750 0.7rem/1.4 ui-monospace, "Cascadia Mono", monospace;
  overflow-wrap: anywhere;
}
.share-button {
  min-height: 2.55rem;
  padding: 0.55rem 0.75rem;
  color: #fff;
  background: var(--orange-dark);
  border: 2px solid var(--line);
  border-radius: 0;
  font-weight: 850;
  cursor: pointer;
}
.share-button:hover { color: var(--ink); background: var(--yellow); }
.share-button:disabled { color: #e8e8dc; background: #686f69; cursor: wait; }
.share-status, .share-link {
  grid-column: 1 / -1;
  min-height: 1em;
  font-size: 0.7rem;
  line-height: 1.4;
}
.share-status { color: var(--muted); }
.share-link { width: fit-content; font-weight: 800; }
.detail-state > .share-control {
  margin-block-start: 1rem;
  padding: 0.85rem;
  background: #fffaf0;
  border: 2px solid var(--line);
}
.detail-state { display: grid; gap: 1rem; }

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
.excerpt-marker {
  color: var(--orange-dark);
  font: 850 0.65rem/1.2 ui-monospace, "Cascadia Mono", monospace;
  letter-spacing: 0.04em;
  white-space: nowrap;
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
.collection-more {
  display: grid;
  grid-column: 1 / -1;
  gap: 0.5rem;
  padding: 0.85rem 1rem;
  color: var(--muted);
  background: rgba(241, 199, 91, 0.16);
  border-block-start: 1px dashed #897f65;
  font: 700 0.72rem/1.45 ui-monospace, "Cascadia Mono", monospace;
  text-align: start;
}
.collection-more > * { margin: 0; }
.collection-more a { color: var(--green-dark); font-weight: 850; }
.merchant-list .collection-more .text-button {
  width: fit-content;
  padding: 0.6rem 0.9rem;
  color: #fff;
  background: var(--green-dark);
  border: 2px solid var(--line);
}
.collection-summary {
  margin: 0.85rem 0 0;
  color: var(--muted);
  font: 700 0.72rem/1.45 ui-monospace, "Cascadia Mono", monospace;
}
.comment-page-error {
  display: grid;
  gap: 0.6rem;
  margin-block-start: 0.85rem;
  padding: 0.85rem;
  color: #5a2921;
  background: rgba(159, 47, 34, 0.09);
  border: 2px dashed var(--danger);
}
.comment-page-error > * { margin: 0; }

.window-footer {
  display: flex;
  flex-wrap: wrap;
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
.window-footer .operator-line {
  flex-basis: 100%;
  max-width: none;
  padding-top: 0.85rem;
  color: #aab7ae;
  border-top: 1px solid rgba(200, 210, 203, 0.28);
}

`
