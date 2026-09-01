export const WINDOW_CSS_DETAIL = `.listing-dialog {
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
  .activity-window { grid-template-columns: minmax(17rem, max-content) minmax(0, 1fr); }
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
  .activity-label { min-width: 0; border-block-end: 3px solid var(--line); border-inline-end: 0; }
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
