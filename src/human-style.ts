export const GUIDE_CSS = String.raw`
:root {
  color-scheme: light;
  --cream: #fffef8;
  --paper: #f6f0df;
  --ink: #17231d;
  --muted: #56645c;
  --green: #173f31;
  --green-dark: #0e2e24;
  --orange: #a94420;
  --gold: #e8bc5a;
  --line: #263c31;
  --shadow: rgba(23, 35, 29, 0.16);
  font-family: Georgia, 'Times New Roman', serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }

html {
  min-width: 0;
  background: var(--cream);
  scroll-behavior: smooth;
}

body {
  min-width: 0;
  margin: 0;
  color: var(--ink);
  background:
    linear-gradient(rgba(255, 254, 248, 0.93), rgba(255, 254, 248, 0.97)),
    repeating-linear-gradient(90deg, transparent 0 30px, rgba(23, 63, 49, 0.04) 30px 31px);
  font-size: 1.05rem;
  line-height: 1.62;
}

a { color: var(--green); text-underline-offset: 0.18em; }
a:hover { color: var(--orange); }
a:focus-visible, .button-link:focus-visible {
  outline: 3px solid var(--orange);
  outline-offset: 3px;
}

.skip-link {
  position: fixed;
  inset: 0 auto auto 0;
  z-index: 20;
  padding: 0.75rem 1rem;
  color: var(--cream);
  background: var(--green-dark);
  transform: translateY(-120%);
}

.skip-link:focus { transform: translateY(0); }

.guide-masthead,
.guide-main,
.guide-footer {
  width: min(72rem, calc(100% - 2rem));
  margin-inline: auto;
}

.guide-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem 2rem;
  padding-block: 1.1rem;
  border-bottom: 2px solid var(--line);
}

.guide-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.8rem;
  color: var(--ink);
  text-decoration: none;
}

.guide-brand img {
  display: block;
  width: 3.25rem;
  height: 3.25rem;
  border: 1px solid var(--line);
  border-radius: 0.45rem;
}

.guide-brand span { display: grid; line-height: 1.15; }
.guide-brand strong { letter-spacing: 0.12em; }
.guide-brand span span { color: var(--muted); font-size: 0.82rem; }

.guide-nav,
.footer-nav,
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem 1rem;
}

.guide-nav a {
  padding: 0.35rem 0.1rem;
  color: var(--ink);
  font-weight: 700;
  text-decoration: none;
  border-bottom: 3px solid transparent;
}

.guide-nav a[aria-current='page'] { border-bottom-color: var(--orange); }

.guide-main { padding-block: clamp(2rem, 6vw, 4.5rem); }

.guide-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(13rem, 23rem);
  align-items: center;
  gap: clamp(2rem, 7vw, 5rem);
  min-height: 28rem;
  padding-bottom: clamp(2.5rem, 7vw, 5rem);
}

.kicker,
.eyebrow {
  margin: 0 0 0.65rem;
  color: var(--orange);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1,
h2,
h3,
p { overflow-wrap: anywhere; }

h1,
h2,
h3 { line-height: 1.08; text-wrap: balance; }
h1 { max-width: 13ch; margin: 0; font-size: clamp(2.5rem, 8vw, 5.6rem); letter-spacing: -0.045em; }
h2 { margin: 0; font-size: clamp(1.8rem, 5vw, 3.1rem); letter-spacing: -0.025em; }
h3 { margin: 0; font-size: 1.25rem; }

.lede {
  max-width: 43rem;
  margin: 1.3rem 0 0;
  font-size: clamp(1.2rem, 2.5vw, 1.65rem);
  line-height: 1.42;
}

.hero-note { max-width: 42rem; color: var(--muted); }
.hero-actions { margin-top: 1.5rem; }

.button-link {
  display: inline-block;
  padding: 0.7rem 1rem;
  color: var(--cream);
  background: var(--green);
  border: 2px solid var(--green);
  border-radius: 0.25rem;
  font-weight: 800;
  text-decoration: none;
  box-shadow: 4px 4px 0 var(--gold);
}

.button-link.secondary { color: var(--green); background: var(--cream); }
.button-link:hover { color: var(--cream); background: var(--orange); border-color: var(--orange); }
.button-link.secondary:hover { color: var(--cream); }

.market-seal { margin: 0; text-align: center; }
.market-seal img {
  display: block;
  width: min(100%, 23rem);
  aspect-ratio: 1;
  margin-inline: auto;
  border: 3px solid var(--line);
  border-radius: 1rem;
  box-shadow: 12px 12px 0 var(--gold);
}
.market-seal figcaption { margin-top: 1rem; color: var(--muted); font-size: 0.88rem; }

.guide-section {
  padding-block: clamp(2.5rem, 7vw, 5rem);
  border-top: 1px solid rgba(38, 60, 49, 0.38);
}

.section-heading { max-width: 52rem; margin-bottom: 2rem; }
.section-intro { max-width: 48rem; margin: 0.85rem 0 0; color: var(--muted); font-size: 1.12rem; }

.fact-grid,
.step-grid,
.two-column {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}

.two-column { grid-template-columns: repeat(2, minmax(0, 1fr)); }

.fact-card,
.step-card,
.plain-card {
  min-width: 0;
  padding: 1.35rem;
  background: rgba(246, 240, 223, 0.72);
  border: 1px solid var(--line);
  border-radius: 0.4rem;
}

.fact-card p,
.step-card p,
.plain-card p { margin: 0.75rem 0 0; }

.step-number {
  display: inline-grid;
  width: 2rem;
  height: 2rem;
  margin-bottom: 1rem;
  place-items: center;
  color: var(--cream);
  background: var(--green);
  border-radius: 50%;
  font-weight: 800;
}

.plain-list { margin: 1rem 0 0; padding-left: 1.3rem; }
.plain-list li + li { margin-top: 0.65rem; }

code {
  padding: 0.08rem 0.3rem;
  background: #eee5cc;
  border-radius: 0.2rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.9em;
  overflow-wrap: anywhere;
}

.callout {
  max-width: 58rem;
  padding: 1.35rem 1.5rem;
  background: var(--green-dark);
  color: var(--cream);
  border-left: 0.55rem solid var(--gold);
}
.callout a { color: var(--gold); }
.callout p { margin: 0; }
.callout p + p { margin-top: 0.8rem; }

.guide-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem 2rem;
  padding-block: 2rem 3rem;
  border-top: 2px solid var(--line);
  color: var(--muted);
  font-size: 0.92rem;
}

.guide-footer p { margin: 0; }
.guide-footer .operator { grid-column: 1 / -1; }

@media (max-width: 48rem) {
  .guide-masthead { align-items: flex-start; flex-direction: column; }
  .guide-hero { grid-template-columns: 1fr; min-height: 0; }
  .market-seal { order: -1; }
  .market-seal img { width: min(10rem, 48vw); box-shadow: 7px 7px 0 var(--gold); }
  .fact-grid, .step-grid, .two-column { grid-template-columns: 1fr; }
  .guide-footer { grid-template-columns: 1fr; }
  .guide-footer .operator { grid-column: auto; }
}

@media (max-width: 24rem) {
  body { font-size: 1rem; }
  .guide-masthead, .guide-main, .guide-footer { width: min(100% - 1rem, 72rem); }
  .guide-nav { width: 100%; justify-content: space-between; gap: 0.4rem; }
  .button-link { width: 100%; text-align: center; }
  .fact-card, .step-card, .plain-card { padding: 1rem; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
`
